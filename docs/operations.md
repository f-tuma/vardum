# Operations

These commands assume the production Compose stack and `.env.production` from
the repository root. Keep that environment file outside public backups: it
contains the secrets needed to keep sessions and signed delivery URLs valid.

Load the deployment values and set the Compose shortcut once per shell:

```sh
set -a
. ./.env.production
set +a
compose() {
  docker compose --env-file .env.production -f compose.production.yml "$@"
}
# Running the bundled object store? Add --profile rustfs to that command line.
```

## Organization bootstrap and email verification

For an instance using `ORGANIZATION_CREATION=allowlist`:

1. Set `ORGANIZATION_CREATOR_EMAILS` to the administrator's email and configure
   `SMTP_HOST` and `SMTP_FROM` plus the provider's port and credentials.
2. Sign up with that address. Sign-in alone does not grant organization creation.
3. Open the verification link in the inbox, then create the organization and
   its first workspace. The app can resend the link or recheck verification.

Without SMTP, unverified accounts cannot bootstrap an allowlisted instance.
Configure outgoing mail and restart the API to complete verification; there is
no automatic verification fallback. Previously verified allowlisted accounts
remain eligible if SMTP is later disabled. `open` is a different trust policy:
it permits **every signed-in account**, including unverified ones, to create
organizations. Do not temporarily expose an internet-facing instance in that
mode as a substitute for verifying its administrator.

After upgrading, previously unverified allowlisted users must verify before
creating additional organizations. Existing organizations, memberships and
sign-ins remain available; the upgrade does not mark old accounts as verified.
Review organizations created before this restriction if the instance was public.

Regression check (requires PostgreSQL binaries, run as a non-root user):

```sh
PG_BINDIR="$(pg_config --bindir)" pnpm --filter @vardum/api test:organization-verification
```

The check creates and removes its own temporary database, ignores `.env`, and
uses real auth endpoints with captured outbound email. It covers both SMTP
configurations without contacting a mail provider or the deployed database.

## Backup

Stop API writes, then export PostgreSQL and mirror the bucket. PostgreSQL stays
available to the backup commands.

The `aws s3 sync` commands below address the bundled RustFS from
`--profile rustfs`. With an external bucket, replace them with your provider's
own mirroring — the important part is that a database dump without the objects
is not a backup.

```sh
stamp=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "backups/$stamp"
compose stop api worker
compose exec -T postgres pg_dump -U varda -d varda -Fc \
  > "backups/$stamp/postgres.dump"
compose --profile rustfs run --rm --no-deps -v "$PWD/backups/$stamp:/backup" \
  --entrypoint /bin/sh rustfs-init -ec \
  'aws --endpoint-url http://rustfs:9000 s3 sync "s3://$S3_BUCKET" /backup/objects'
compose up -d --wait
```

Also store an encrypted copy of `.env.production`. A backup without the object
bucket is incomplete; the database stores metadata, not image contents.

## Restore

Restore into an empty stack or accept that `pg_restore --clean` replaces the
current database objects. Keep API and worker stopped until both stores match.

```sh
backup=backups/20260822T120000Z
compose --profile rustfs up -d postgres rustfs rustfs-init
compose stop api worker
compose build
# Prepare the runtime role so ACLs in newer backups have a valid grantee.
compose run --rm migrate
compose exec -T postgres pg_restore --clean --if-exists -U varda -d varda \
  < "$backup/postgres.dump"
compose --profile rustfs run --rm --no-deps -v "$PWD/$backup:/backup:ro" \
  --entrypoint /bin/sh rustfs-init -ec \
  'aws --endpoint-url http://rustfs:9000 s3 sync /backup/objects "s3://$S3_BUCKET"'
# Reapply pending migrations and runtime grants after restoring the dump.
compose run --rm migrate
compose up -d --build --wait
curl --fail "$APP_URL/ready"
```

## Upgrade

1. Read `CHANGELOG.md` and create a backup.
2. Check out the desired release tag.
3. Keep the existing `.env.production` secrets.
4. Rebuild and start; the one-shot migrate service applies pending migrations.

```sh
git fetch --tags
git checkout v0.1.0
compose up -d --build --wait
curl --fail "$APP_URL/ready"
```

Database migrations are forward-only. To roll back across a migration, check
out the previous release and restore the backup made before upgrading.

## Runtime database role upgrade

The production and both Dokploy templates keep the existing `varda` database
administrator for PostgreSQL initialization, backups and the one-shot migration
service. API and worker now connect as `varda_app`, with a separate password.
They do not receive the administrator's connection string. The runtime owns no
application or queue objects and has no superuser, BYPASSRLS, role membership,
schema-creation or table-truncation privileges. Both entrypoints refuse to start
in production when these restrictions are violated.

For an existing installation:

1. Back up the database, objects and environment. Keep `POSTGRES_PASSWORD`
   unchanged; changing the environment alone does not change an existing
   PostgreSQL administrator password.
2. Add a **different** `POSTGRES_APP_PASSWORD` to the deployment environment.
   Use at least 24 URL-safe letters, digits, underscores or hyphens; generate
   one with `openssl rand -hex 32`. Store both secrets securely.
3. Stop API and worker, deploy the matching images and run the migration service
   before restarting them. Avoid running the old privileged workers alongside
   the new services while queue grants are being changed.

```sh
compose stop api worker
compose build
compose run --rm migrate
compose up -d --force-recreate api worker gateway
curl --fail "$APP_URL/ready"
```

Dokploy uses the same environment variable and service dependency ordering.
Stop the old API/worker before redeploying; verify the migration service succeeded
and both new services started. No database reset or ownership transfer of existing
tables is required. A pre-existing `varda_app` role with elevated attributes,
memberships or owned objects is rejected for manual review rather than silently
repurposed. Provisioning grants only data operations and checks the resulting role
before committing its changes. A password rotation uses the same stop/migrate/
restart sequence, which also prevents old connection pools surviving the change.

pg-boss schema changes now run through its migration CLI before runtime startup.
Runtime processes can enqueue, claim, schedule, retry and maintain jobs, but
cannot rewrite the schema version or access executable BAM migration commands.
Queue statistics persistence is disabled to avoid runtime partition DDL;
Vardum's delivery analytics remain enabled. Delivery retention visits workspaces
in batches with a transaction-local RLS context. Existing queue data is preserved
when the migrator reruns.

The PostgreSQL instance/database is dedicated to Vardum. For a manually managed
deployment, give the migrator credentials able to apply DDL and provision the
runtime role; set `POSTGRES_APP_PASSWORD` only on that one-shot process. Set API
and worker `DATABASE_URL` to the matching `varda_app` connection and
`NODE_ENV=production`. The local `pnpm dev` workflow still uses its development
schema owner and automatic queue initialization; it is not a production template.

RLS is defense against missing tenant filters, not a replacement for route
authorization: the server selects `app.workspace_id`, auth/workspace-directory
tables remain global, and verified custom-domain lookup has its existing read
policy. A runtime connection must not be exposed to application end users.
PostgreSQL explains the superuser/owner exceptions in its
[row-security documentation](https://www.postgresql.org/docs/17/ddl-rowsecurity.html).

Regression checks (native PostgreSQL binaries; unprivileged OS user):

```sh
PG_BINDIR="$(pg_config --bindir)" pnpm --filter @vardum/api test:runtime-database
PG_BINDIR="$(pg_config --bindir)" pnpm --filter @vardum/api test:private-delivery
bash scripts/smoke-production.sh
```

The first two create disposable PostgreSQL clusters and ignore `.env`. The last
builds the production Compose stack in its own project, checks a real RustFS
upload/ingest, private delivery and the deployed database role, then deletes only
that project's data. Never substitute the deployed database for these fixtures.

## Interrupted upload processing

Apply `0011_asset_ingest_recovery.sql` with the migration service before starting
this API/worker build. Stop old API and worker instances first; do not mix worker
versions during this upgrade. The additive migration retains existing files and
versions, adds processing job/attempt identifiers and a retry flag, and indexes
processing versions. No database reset or npm client update is needed.

An upload and its queued processing job commit together. Transient storage errors
use the queue's existing retries (three retries with backoff). The worker checks
processing versions at startup and every minute: active/queued/retrying jobs stay
processing, while exhausted, cancelled or missing jobs become failed and retryable.
Existing jobs without the new identifier are adopted by singleton version ID.
Each scan uses short workspace-scoped transactions and does not read object bytes.

A crashed worker's active job must first expire or miss its queue heartbeat before
queue maintenance retries/fails it. Recovery is eventual, not an exact one-minute
completion guarantee: queue maintenance, retry backoff and backlog add latency.
At least one worker and PostgreSQL must be running for reconciliation to progress.
If all workers are stopped, restart them; healthy API `/ready` alone does not
confirm a working ingest pipeline.

After repairing storage/connectivity, open the asset's **Version history** and
choose **Retry processing**. It reuses the same stored upload and version number,
requires asset publish permission, and records `asset.version_retried` in activity.
Repeated clicks while processing enqueue nothing extra. A previously ready
current version remains available until a newer version finishes successfully;
an old worker attempt cannot overwrite a replacement. The detail page refreshes
processing state automatically. Invalid image bytes/type/limits are not retryable:
upload a corrected file instead. A deleted source object must be restored or
replaced; retry cannot recreate its bytes.

Check worker logs for storage/queue errors when failures recur. The user-facing
message intentionally omits raw storage credentials and provider diagnostics.
Uploads that were never finalized remain pending and are outside this recovery
path. See worker/queue monitoring below; abandoned-upload cleanup remains separate
work.

Regression coverage runs in `test:private-delivery` (real PostgreSQL/limited role,
HTTP object fixture, concurrent retries, expired attempt fencing and SIGKILL of a
real worker process) and `scripts/smoke-production.sh` (real RustFS outage,
exhaustion, scheduled reconciliation, worker restart and retry). Both own disposable
data; never run outage injection against a deployed stack.

## Worker and queue monitoring

Apply `0012_worker_heartbeat.sql` with the migration service before deploying
matching API and worker images. It adds a global operational table containing
only random worker instance IDs and heartbeat times; existing assets are unchanged.
All three production/Dokploy templates now check each worker locally using
`node dist/worker-healthcheck.js`. The worker binds its health server only to
`127.0.0.1:3001` inside its container; do not publish this port. One worker process
per container is expected.
For multiple development workers on the same host, set a distinct
`WORKER_HEALTH_PORT` for each process (default 3001); the healthcheck command reads
the same setting. Integration fixtures choose an unused port instead of binding
the running development worker's port.

| Probe | Access | Meaning |
| --- | --- | --- |
| `/health` | Public | API process responds |
| `/ready` | Public | Existing API database readiness; does not gate the UI on worker/S3 availability |
| Worker `127.0.0.1:3001/health` | Container loopback | Its pollers are responsive and its database heartbeat is fresh |
| `/api/operations/health` | Monitoring bearer token | Database/queue query, bucket reachability, at least one live worker, and bounded queue wait/active age; 200 or 503 |
| `/api/operations/metrics` | Monitoring bearer token | Prometheus gauges; 200 even when a dependency is down so failure metrics remain scrapeable |

Set `MONITORING_TOKEN` on the API to a random, URL-safe secret of at least 32
characters (`openssl rand -hex 32`). Empty disables both operational endpoints
with 404. Workspace keys, browser sessions and query-string tokens cannot access
them. Keep the token in the monitoring system's secret store and use HTTPS over
untrusted networks. It is read-only fleet access, not a per-workspace credential.
Responses are non-cacheable and expose counts/ages, never asset names, job payloads,
storage endpoints, raw errors or worker IDs. The gateway proxies these API paths.

Each worker publishes a database-clock heartbeat every 15 seconds only while all
four pollers are responsive. Idle pollers must have fetched within 75 seconds;
active jobs may run for up to 360 seconds (the job timeout is 300 seconds).
Graceful shutdown removes its own row; a dead/frozen worker expires after 60
seconds. Other live replicas still count, so one restarting replica does not
report total worker loss. Old rows are pruned after one day. Container health
uses three failed checks at 15-second intervals after a 30-second startup grace.
Docker's restart policy applies to process exits; an unhealthy running container
still needs an orchestrator/operator response.

Probes use a separate single-connection pool with 2-second connection/statement
limits and a 2.5-second client query timeout, plus an abortable 2-second S3
`HeadBucket`. Concurrent scrapes share work and completed results are reused for
at most 5 seconds. Failed database observations omit unknown worker/queue gauges
instead of reporting healthy zeroes. Ensure the storage principal can perform
`HeadBucket` (S3 `ListBucket` permission); this probe checks bucket access, not
successful upload, per-object reads or free storage capacity.

Failed idle application database connections are removed by the pool without
terminating API/worker processes. A database outage still fails database-dependent
requests, but operational probes remain available and reconnect when it returns.
The logs record `database.connection_lost` without connection credentials.

Metrics are gauges, including `vardum_queue_failed_15m`, a sliding count of terminal
queue failures in the last 15 minutes. It may remain positive after retry succeeds;
invalid user image validation completes the queue job and is not an infrastructure
failure. Future scheduled retries do not contribute to oldest-ready age. Completed
and old failed jobs are excluded from the queue query. Queue aggregation relies on
the pinned pg-boss 12 schema and is covered by runtime integration tests.

A minimal Prometheus scrape job (replace the hostname; store exactly the same token
in the credentials file, without a `Bearer` prefix):

```yaml
scrape_configs:
  - job_name: vardum
    scheme: https
    metrics_path: /api/operations/metrics
    scrape_interval: 15s
    scrape_timeout: 8s
    authorization:
      type: Bearer
      credentials_file: /run/secrets/vardum-monitoring-token
    static_configs:
      - targets: [vardum.example.com]
rule_files:
  - /etc/prometheus/vardum-alerts.yml
```

Copy `docker/monitoring/alerts.yml` to the rule path. It covers failed scrapes,
database/S3 probes, unavailable queue observations, no workers, waiting jobs older
than 300 seconds, active jobs older than 360 seconds, and recent terminal failures.
Tune warning thresholds to measured workloads. Wire these rules to your own
Alertmanager receivers and test notification delivery; this repository does not
install a monitoring service or send notifications to an unconfigured destination.
The JSON health endpoint uses the same 300/360-second age thresholds, while recent
failures remain warnings rather than keeping health degraded after recovery.

The production smoke freezes a real worker until its heartbeat expires, resumes
it, and stops/restarts its disposable RustFS and PostgreSQL. It checks authenticated
metrics, readiness independence, unknown values during database loss, and recovery.
The isolated runtime suite covers multiple replicas, future retries, failure-window
expiry and a real SQL lock causing a bounded timeout. Unit tests cover auth,
configuration, poller deadlines, metric format and coalesced probes.

## Asset visibility upgrade

**Do not run old unauthenticated delivery code while accepting private assets.**
Do not use a rolling mixed-version deployment for this migration.

1. Back up the database, objects and secrets. Stop API and worker instances and
   block delivery at every gateway/custom-domain origin during the upgrade.
2. Verify that the bucket, originals, derived objects, imported source objects
   and any separate object-storage CDN are not anonymously readable. Network
   reachability for signed uploads is not permission to read objects publicly.
   Application visibility cannot secure a public bucket or an alternate origin.
3. Review `0009_asset_visibility.sql` before applying migrations. Existing asset
   rows become public to preserve their previous behavior; future inserts default
   private. No file is published by a Vard setting. The migration is tracked by
   the existing Drizzle migrator and its transaction; rerunning the migrator is
   safe. Replaying the raw SQL directly is not supported (the column exists).
4. The migration also changes only enabled workspace keys whose rate limiter is
   enabled and exactly matches the historical 10 requests / 86,400,000 ms default
   to 10,000 requests / 60,000 ms. Both key issuance paths and the plugin use that
   finite new allowance. Private delivery now verifies keys and consumes requests;
   ten/day would break a normal 12-file pull. This is not a throughput guarantee.
   Keys with custom limits, disabled keys and disabled rate limiting are untouched;
   permissions, references, expiry/revocation state, counters and last-request
   timestamps are preserved. **An intentionally configured exact 10/day limit is
   indistinguishable from the old default. Operators must review this UPDATE and
   preserve intentional policy before deployment.** No auth schema regeneration
   is required.
5. Apply the migration with the existing migration service, then start only the
   visibility-aware API/worker and updated gateway. Verify anonymous denial and
   authenticated original/variant/video-range access before reopening traffic.
   This repository change does not migrate a running environment.

Private originals, transformed variants, redirects and errors use
`Cache-Control: private, no-store`; manifests are also no-store, even when public.
Configure reverse proxies/CDNs to honor this, avoid caching authenticated
responses, and forward cookies / `x-api-key` to the API. Private browser URLs
must route through the canonical app origin; a custom domain does not receive
the app's cookie. API clients may use a verified custom domain with a scoped key,
but frozen CLI downloads deliberately stay on canonical immutable URLs and refuse
redirects. Signatures do not grant read permission.

A visibility update affects subsequent origin requests for every ready version;
it does not delete versions or change their URLs/checksums. Old public responses
had up to one-year immutable cache lifetimes. Purge caches you control where
possible, but do not promise immediate revocation from browsers, shared caches,
already downloaded files or offline build outputs. Public Vards containing even
one private mapped asset become entirely unavailable anonymously; authenticated
workspace readers retain complete manifests. Vard public settings never grant
asset permissions.

### Safe rollback constraints

Prefer a forward fix. Old delivery code ignores `asset.is_public` and would
re-expose **all** private rows, even if the new column remains in place. Do not
restart it against the upgraded database. Keep delivery blocked until either a
visibility-aware fix is running, or a reviewed pre-upgrade database/object backup
has been restored with all post-upgrade private writes removed and the former
public exposure explicitly accepted. A schema downgrade alone is not a safe
rollback. The finite key allowance change also needs operator review if restoring
old policy; never reset keys/counters or re-enable revoked keys casually.

### Isolated delivery regression

Run `pnpm --filter @vardum/api test:private-delivery` as an unprivileged user with
native `/usr/bin/initdb`, `pg_ctl`, `postgres` and `psql` installed. The explicit
suite creates a disposable PostgreSQL cluster on a private UNIX socket with no
TCP listener and an unprivileged RLS-bound application role. It replaces ambient
app configuration, uses only local fake object HTTP and disposable credentials,
exercises real routes/auth and normal/frozen CLI downloads, then stops and removes
only its own cluster and fixtures. It never reads `.env` or mutates existing
services. The stress matrix disables fixture key throttling; separate migrated
and newly API/CLI-issued keys prove bulk and frozen access with finite rate
limiting still enabled. Ordinary `pnpm test` needs no database.

## Folder-rule upgrade

This is an unreleased source slice, not a new npm release or a live migration.
Back up database, objects and secrets, stop API writes, and review
`0010_vard_folder_rules.sql`. Apply it with the existing migration service after
0009, then deploy the folder-aware API with the matching gateway/MCP source build.
The non-null JSONB `vard.folder_rules` defaults to `[]`; old Vards and manual rows
keep their identities and behavior. Do not skip the asset-visibility precautions
above. Check authenticated configuration GET separately from resolved manifest GET,
and test that collision/limit errors still allow configuration repair.

Do not serve mixed old/new APIs for Vards using rules. An older API may ignore
`folder_rules`, return only manual items and silently omit generated membership.
An older client may ignore or fail to display rules; normal pulls against an older
API can refresh the snapshot to the wrong membership. Keep rule editing and normal
updates paused until the matching API and clients are available. Prefer a forward
fix. Before a rollback, inventory/export Vard definitions and freeze consumer
updates. Either keep a folder-aware API, or explicitly remove rules using the new
API and review/commit the intended consumer membership change before switching.
A migration rollback requires a reviewed pre-upgrade backup restore and acceptance
of lost post-backup changes. Never roll back to visibility-unaware delivery code
against private data. Keeping the extra database column alone does not preserve
rule behavior in an old API.

Rules are literal recursive prefixes, for example `brand/` → `assets/brand/`.
Empty source/output prefixes mean workspace/project root; nonexistent and empty
folders are valid. Only ready current originals are included, not pending files;
new private members block the whole anonymous public manifest. Limits are 64 rules,
255 characters per prefix, 500 per output path, and 1,000 combined manual/generated
outputs. Explicit + rule, rule + rule, case/Unicode and file/directory collisions
fail resolution without precedence or truncation. Configuration remains editable.

No background project sync is introduced. Normal pull adopts current rules and
membership; frozen pull consumes committed snapshot membership. Removing rules
leaves manual mappings and source assets intact. **Use `--delete` on the
membership-updating normal pull** to remove stale tracked project files. A no-delete
pull drops stale tracking but leaves disk files; a later `--delete` cannot discover
those leftovers, which require deliberate manual cleanup.

Frozen reproduction still requires retained versions, valid signatures and working
delivery URLs. Server/workspace-slug changes, signing-key rotation, expired
signatures or changed transformation rendering can break snapshots. **Source-key
rename can invalidate historical URLs despite retained bytes.** Rule/membership
removal with retained valid source URLs supports frozen restore; normal move tests
do not prove frozen rename support. There is no new retention guarantee or cleanup
ledger. The isolated `test:private-delivery` suite above also exercises folder-rule
migration, authorization/privacy, resolution and real normal/frozen CLI lifecycle.
