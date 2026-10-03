# Operations

These commands assume the production Compose stack and `.env.production` from
the repository root. Keep that environment file outside public backups: it
contains the secrets needed to keep sessions and signed delivery URLs valid.

For operations on the existing deployment, load its values and set the Compose
shortcut once per shell. Restore uses a separate, fresh shell as described below.

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

## Object storage compatibility and RustFS upgrade

The bundled provider is [RustFS 1.0.1](https://github.com/rustfs/rustfs/releases/tag/1.0.1),
pinned in all four Compose templates to image digest
`sha256:1803faef57627e2d9c2e7d89d655d712ddded5389040054987163043fecb6a3c`.
It is the minimum supported RustFS version for large presigned POST uploads.
RustFS 1.0.0's multipart parser can return `500` / `InternalError` with
`FileStreamError: BoundaryBufferTooLarge` for a legal
large JPEG when a retained carriage return plus the next 64 KiB body chunk
exceeds its boundary buffer. 1.0.1 uses the bounded parser from s3s 0.17.0.
The API's presigned POST contract and CLI 0.6.0 upload transport are unchanged.

An external S3 provider must accept SigV4 presigned POST with exact key and
Content-Type conditions, enforce its size range and expiration, and expose CORS
at the actual public upload origin. The app also needs HEAD, GET (including ranges),
PUT, COPY, paginated LIST and batch DELETE. An S3-compatible label alone does not
establish these capabilities. Amazon S3 and Hetzner are configuration examples;
the automated production smoke currently validates the pinned bundled RustFS.
Run upload/policy, ingest, delivery, import, deletion and backup/restore acceptance
against your chosen endpoint and any proxy before relying on it.

For an existing RustFS deployment:

1. Block bucket writers, including outstanding signed uploads. Follow [Backup](#backup)
   for a verified matched database/object backup; it leaves app services stopped.
   Stop RustFS and preserve an offline snapshot of its volume before upgrading.
2. Rehearse on an independent copy of that volume and its matching database/config.
   Preserve the bucket, keys and endpoints. The disposable 1.0.0→1.0.1 probe checked
   existing object SHA-256/ETag, listing, CORS, copy/get/delete and a still-valid
   pre-upgrade POST grant. Those fixture results do not certify your own volume.
3. In the rehearsal, compare existing object hashes and metadata; run a native
   FormData large JPEG upload, finalize/ingest and decode delivery. Check CORS,
   configured upload limits (default 25 MiB image / 200 MiB video), rejection one
   byte above each limit, and altered key, MIME, signature and expired policies.
4. After acceptance, use the updated template on the original deployment and
   recreate only storage, retaining its volume:

   ```sh
   # Reuse the exact project name selected and verified during Backup.
   : "${deployment_project:?Set the existing Compose project name used for backup}"
   compose -p "$deployment_project" --profile rustfs pull rustfs
   compose -p "$deployment_project" --profile rustfs up -d --no-deps --wait rustfs
   compose -p "$deployment_project" up -d --wait api worker gateway
   ```

   Repeat object/upload acceptance before reopening writers. For Dokploy use its
   matching template and maintenance/redeploy controls. Never use `down -v` on an
   existing deployment. If rollback is required, restore the verified pre-upgrade
   backup/snapshot in an independent deployment; do not assume an older image can
   read a volume modified by the newer one.

`bash scripts/smoke-production.sh` creates fresh disposable volumes. It checks a
seeded, decodable 4 MP JPEG with legal CR-filled comment segments through the
normal app grant and native FormData POST, verifies the stored SHA-256 before
finalize, and fully decodes delivered bytes after ingest. The separate random
4 MP resource/transform fixture remains part of the same smoke. This fresh-volume
check is not an upgrade rehearsal for an existing volume.

## Resource budgets and unfinished uploads

Deploy migrations `0013_upload_cleanup.sql` and `0014_upload_cleanup_fairness.sql`
before updating the API and worker images. Back up first. Migration 0014 adds
nullable scheduling timestamps and indexes; older images remain compatible with
the migrated schema. Cleanup fairness takes effect after the workers are updated.
For an image rollback, retain these additive columns and indexes. Existing
ready/processing versions are retained; old **pending** versions become eligible
for automatic expiry after the configured deadline.
Choose limits for existing workspaces before deployment. Lowering a quota below
current usage blocks new uploads/imports without deleting existing files.

| Setting | Default | Scope |
| --- | --- | --- |
| `WORKSPACE_STORAGE_MB` | 10240 MiB | Reserved original bytes per workspace, across all API replicas |
| `WORKSPACE_PENDING_UPLOADS` | 100 | Pending + processing versions per workspace, including retries |
| `UPLOAD_PENDING_HOURS` | 24 hours | Time to finalize an upload; presigned POST itself lasts 15 minutes |
| `API_MAX_INFLIGHT` | 128 | Requests per API process, through response/stream completion |
| `DELIVERY_MAX_INFLIGHT` | 64 | Delivery requests per API process, including HEAD/redirects/ranges |
| `DELIVERY_REQUESTS_PER_SECOND` | 100 | Delivery token bucket per API process, with a one-second burst |
| `TRANSFORM_CONCURRENCY` | 2 | Uncached transforms across API replicas sharing the database |
| `TRANSFORM_QUEUE_LIMIT` | 8 | Additional transform requests per process; at most two seconds of waiting |
| `TRANSFORM_MAX_OUTPUT_PIXELS` | 16000000 | Total output pixels including all animation frames |
| `TRANSFORM_TIMEOUT_SECONDS` | 15 | Encode timeout and storage-operation deadline |
| `API_MEMORY_LIMIT` / `API_CPU_LIMIT` | 2g / 2 | Hard Compose container limits per API replica |
| `WORKER_MEMORY_LIMIT` / `WORKER_CPU_LIMIT` | 1g / 1 | Hard Compose container limits per worker replica |

MiB is 1,048,576 bytes. Reservation and version insertion share a short, locked
database transaction. All retained versions count, including failures and uploads
that have not reached storage yet. S3 import and manual ingest retry use the same
admission rules. `GET /api/workspaces/:workspaceId/storage-usage` returns reserved
bytes, byte limit, unfinished count and unfinished limit to authorized readers.
Storage overflow returns `413`; unfinished/rate limits return `429`; busy request
or transform capacity returns `503`. `429`/`503` include `Retry-After: 1` and are
not cacheable. Clients may retry those responses with bounded backoff. Health and
protected operational probes remain outside request admission.

The storage quota accounts for **original-version reservations**, not total bucket
or database usage. Derived cache objects, source import objects, provider version
history, logs and backup bundles need separate storage monitoring and retention.
Use a provider lifecycle rule scoped to `derived/` for derived-cache retention;
never apply that rule to `originals/`. Request/rate limits multiply with the number
of API replicas; enforce a fleet-wide edge budget when needed. Keep the same
`TRANSFORM_CONCURRENCY` on every replica. Its PostgreSQL session advisory locks
require a direct connection or session pooling, not transaction-mode PgBouncer.
Connections are released on completion/failure, and locks disappear when the
database session ends. See [PostgreSQL advisory locks](https://www.postgresql.org/docs/17/explicit-locking.html#ADVISORY-LOCKS).

Cached variants and original downloads bypass encoder slots but still consume
delivery admission. Identical variants share work within one process. API libvips
concurrency is one thread per image with a 32 MiB operation cache; neither is a
hard total-memory bound. Input reads reject bytes beyond the reservation, output
estimation includes animation and extreme aspect ratios, and oversized transforms
return `422` with guidance to request smaller dimensions. Sharp timeout cancellation
is cooperative; container limits remain the hard boundary. See [sharp limits](https://sharp.pixelplumbing.com/api-utility/)
and [encoding timeout](https://sharp.pixelplumbing.com/api-output/#timeout).

The monitored `upload-cleanup` queue runs at worker startup and every minute in
batches of at most 100 versions and at most 100 workspace visits per invocation.
The database retains the last workspace visit and version cleanup attempt, so
failed keys move behind less-recent attempts even after a worker restart. Later
workspaces and versions receive a turn while failed reservations remain counted.
It changes only expired pending versions to a non-retryable failure, with an
audit entry; processing/ready versions and current
version pointers remain unchanged. Finalize rechecks the deadline while locking
the version, so it cannot race the transition. The worker deletes the exact
original key outside the transaction and releases its reservation only after a
successful S3 response. Partial deletion errors preserve the reservation and retry.
Failed-version tombstones are re-swept daily in those same bounded batches, since
an upload already in flight can finish late. These rows remain in version history;
they are not silently removed. New uploads get a new version/key. A stopped worker
does not clean expired reservations, so monitor its heartbeat and cleanup queue.

The production smoke includes real RustFS expiry, cross-session transform
saturation/recovery, a 200-request admission burst, and twelve concurrent WebP
requests from a synthetic 2048×2048 JPEG. It records successful-request p95 and
the API container's peak memory. These are functional load samples, not an SLO or
tenant-capacity certification. Before opening a deployment to untrusted users,
measure your codecs, animations, cache miss ratio and replica count; set edge
limits, bucket retention and alerts for disk/memory, rejections and queue delay.

## Backup

`node scripts/backup.mjs` creates and verifies a matched PostgreSQL + object-store
backup. It requires Node 22+, a Unix host with Docker Compose, and API images built
from this revision. It uses the deployment's configured S3 endpoint, so the same
exporter handles bundled RustFS and an external S3-compatible bucket. Always name
the existing Compose project explicitly (`docker compose ls`); do not guess it.
For Dokploy, also pass `--compose-file compose.dokploy.yml` (or the dev template)
and its environment file/project name. Dokploy/external providers need their own
restore rehearsal before relying on them; the automated drill tests the production
template with PostgreSQL 17 and RustFS.

Schedule a maintenance window. Block direct/public S3 uploads and any other bucket
writers, including still-valid presigned uploads, and pause external schedulers or
replicas outside this Compose project. The command stops every gateway/API/worker
replica in the selected project before dumping. It **leaves them stopped on both
success and failure**. PostgreSQL and storage stay available to the exporter.
The before/after bucket inventories must agree; a concurrent change fails the
export rather than accepting a mixed snapshot. This is a maintenance backup,
not a zero-downtime database/object snapshot.

```sh
deployment_project=vardum  # replace with the existing deployment's project name
backup_dir="$PWD/backups/$(date -u +%Y%m%dT%H%M%SZ)"
node scripts/backup.mjs create --project "$deployment_project" \
  --env-file .env.production --directory "$backup_dir"
node scripts/backup.mjs verify --project "$deployment_project" \
  --env-file .env.production --directory "$backup_dir"
# Resume only after a successful backup, or after investigating a failure.
docker compose --env-file .env.production -p "$deployment_project" \
  -f compose.production.yml up -d --wait api worker gateway
```

A bundle has four parts:

- `postgres.dump`: custom-format dump, including users, sessions, keys, Vards,
  histories, audit/delivery records and durable queue jobs. Expiring worker
  heartbeat **rows** are omitted; their table remains.
- `references.json`: ready/processing versions' required original keys, sizes and
  available checksums. Missing originals or bytes inconsistent with the database
  fail the backup instead of producing a complete-looking but unusable bundle.
- `objects/`: streamed original and derived bytes under opaque filenames, including
  empty objects. S3 keys are stored in the manifest, never interpreted as local paths.
- `backup.json`: written last, with database/object SHA-256 checksums, sizes,
  object keys, content headers/custom metadata, migration hashes, PostgreSQL version
  and the source API image ID. Incomplete exports have no valid completion manifest.

The directory is created with mode 0700 and files with mode 0600. It must be a new
path; the command never reuses an existing backup directory. Verification checks
archive structure, every byte and original-file references, and rejects missing
files, duplicate keys and symlinks. SHA-256 detects corruption; it is not
authentication against someone who
can rewrite the manifest. Restore only a trusted, protected backup: a PostgreSQL
archive can contain executable database definitions.

Keep the **whole bundle** and an encrypted copy of the deployment environment in
an access-controlled, encrypted off-host backup store. The tool does not copy
secrets, encrypt, schedule, expire or remotely replicate backups. Back up the exact
application revision/image references too. Preserve `BETTER_AUTH_SECRET` and
`TRANSFORM_SECRET`; the latter is needed for existing signed/frozen URLs. The
bundled image ID is provenance, not a portable registry reference. `backups/` and
production environment files are ignored by Git; backups are excluded from the
Docker build context. Use a dedicated bucket: every current object is exported.

This format preserves current object bytes and content metadata (including MIME
type, cache headers and custom metadata), not provider version IDs/history, delete
markers, tags, ACLs, lifecycle/replication rules, bucket policy or encryption/KMS
configuration. Recreate provider configuration separately and keep restored buckets
private. Objects larger than 5 GiB need a provider-native backup/restore method.
The exporter streams bytes but retains the object inventory in memory; its commands
have a 30-minute limit. Measure runtime/capacity on your real data before scheduling
this path for a large installation.

## Restore

Use a **new Compose project, empty PostgreSQL database and empty dedicated bucket**.
The tool never drops a database, cleans a bucket or offers a force-overwrite mode.
It checks the complete bundle, then both destinations, before restoring anything.
Keep application services and all external writers stopped until acceptance passes.
If a restore fails halfway, keep that target isolated and retry into another fresh
target; do not start a partially restored instance.

Prepare `.env.restore` from the backed-up secrets with separate target storage,
ports and credentials, and the matching application images. PostgreSQL/runtime/S3
passwords can differ if the target configuration and runtime grants agree; retain
the application signing secrets. Use PostgreSQL 17 for this tested procedure and
first restore the matching application revision. Older PostgreSQL/application
versions are not supported downgrade targets.

Run the restore commands in a **fresh shell without exported source deployment
variables**. Do not run the `.env.production` initialization from the top of this
guide in that shell. Both Compose and the backup script follow normal
[Compose environment precedence](https://docs.docker.com/compose/how-tos/environment-variables/envvars-precedence/):
exported shell variables override values in `--env-file .env.restore`. Check that
the target configuration names the new stores, bucket and ports before starting it.

```sh
restore_project=vardum-restore
backup_dir="$PWD/backups/20260921T120000Z"  # select a verified bundle
restore_compose() {
  docker compose --env-file .env.restore -p "$restore_project" \
    -f compose.production.yml "$@"
}
# Bundled storage: start only the fresh stores and create the private bucket.
restore_compose --profile rustfs up -d --wait postgres rustfs
restore_compose --profile rustfs run --rm --no-deps rustfs-init
# External storage: provision an empty private bucket separately; start postgres only.
node scripts/backup.mjs restore --project "$restore_project" \
  --env-file .env.restore --directory "$backup_dir"
restore_compose up -d --wait api worker gateway
```

Do **not** run the migrator before restore: it would populate the empty target.
The command uses `pg_restore --single-transaction --exit-on-error --no-owner
--no-acl`, restores and re-reads all objects to verify bytes/metadata, then runs
the migrator to recreate the restricted runtime role and grants and runs `ANALYZE`.
Source owner/ACL assignments are intentionally replaced by the current least-
privilege provisioning. See PostgreSQL's [pg_restore documentation](https://www.postgresql.org/docs/17/app-pgrestore.html).

Before routing users to the restored stack, verify login, organization/workspace
membership, private anonymous denial, API key scope, an old version and signed
transform, Vard configuration, and a normal/frozen CLI pull from the restored
origin. Historical URLs contain the original application origin: preserve it at
cutover, or use isolated local DNS/port routing during a drill so the old URLs
actually reach the restored instance. Keep the old target isolated to avoid two
writers. Restored queued jobs resume with the new worker; jobs previously active
may first need queue expiry/reconciliation. Use authenticated operational health
as well as `/ready` to check the recovered pipeline.

### Automated recovery drill

```sh
bash scripts/smoke-production.sh
```

The CI/release production smoke creates a backup and restores it into a second
fresh PostgreSQL 17/RustFS Compose project with independent volumes. It compares
application row counts before starting workers, preserves version/current pointers,
checks sessions and password login, private delivery, key scope, pre-backup signed
transforms, saved Vards and byte-identical frozen pulls with the installed npm CLI.
A job queued before backup must finish after restore. It also tests empty objects
and metadata, corrupt-backup refusal, and refusal to overwrite either a populated
bucket or database. Both disposable projects are removed; development data is
untouched. Do not inject this drill into an existing deployed project.

The output records object count/bytes and elapsed backup and restore/acceptance
time. These tiny-fixture timings are **not** a production RTO. Choose and monitor
backup frequency/retention from an explicit recovery-point objective, and rehearse
on representative data to set a recovery-time objective. Off-host retention,
credential recovery, provider failover, notification delivery and an actual
production-size upgrade/rollback rehearsal remain operator work.

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
delivery URLs. Schema 2 URLs still depend on source keys and workspace slugs.
The unpublished CLI 0.7.0 candidate creates schema 3 with opt-in
`delivery=version-id-v1` manifests and `/w/__id/{workspaceId}/__v/{versionUUID}`
URLs. These identities survive key renames/moves, slug changes and Vard deletion
while source versions are retained. Default manifests stay unchanged for published
CLI 0.6.0/MCP 0.2.0. There is no database migration for this delivery contract.

`vardum migrate-lock` requires a workspace read key and explicitly resolves only
the retained schema 2 version IDs and transformation parameters; it does not consult
the current Vard, old keys/slugs or current-version pointers. It verifies all bytes
before atomically rewriting the lock, preserving membership, paths, versions,
fingerprints and checksums without modifying files. A failure leaves the old lock
unchanged. The authenticated resolver is bounded to 1,000 outputs and cannot be
used as an anonymous transformation signer. Frozen commands never perform migration,
refresh signatures, fetch a current manifest or silently fall back to latest.

Server-origin changes, signing-key rotation or changed transformation rendering can
still break snapshots. Current transformation signatures have no expiry field;
rotation invalidates signed transformed URLs, while originals do not use that secret.
Retain signing configuration for historical builds; the schema 2 migration can
explicitly re-sign old intent only after downloaded-byte verification. Schema 3 has
no automatic signature refresh. Asset deletion cascades all version rows and queues
original/derived-object cleanup; deleting retained rows or original objects also
removes availability. There is no new ready-version deletion API, retention guarantee,
archive or cleanup ledger. Keep original objects outside derived-only lifecycle rules.
Current asset privacy is checked on every identity delivery, including HEAD and
ranges. Previously cached public bytes and matching local files cannot be revoked.

The isolated `test:private-delivery` suite exercises SQL renames/moves, old key/slug
reuse, newer current versions, Vard deletion, absent local files, identity signature
replay denials and schema 2 migration failures. To additionally exercise the actual
published clients, provide `VARD14_RELEASED_CLIENTS` pointing to a private npm fixture
containing the integrity-verified published CLI 0.6.0/MCP 0.2.0/shared 0.2.0 archives.
Mount that fixture read-only alongside the repository in the isolated PG test container;
the fixture tests do not connect to configured or production databases.
