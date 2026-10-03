# Production readiness review — 2026-09-20

Scope: the Vardum product, published npm packages and deployment templates,
not the configuration of the current development instance. Reviewed repository
HEAD `0bc5fdf` together with the existing uncommitted changes. This is a point-in-time
engineering review, not a penetration test or a capacity certification.

**Decision: not ready for an unrestricted production release.** The source build
has a credible foundation for a supervised small-team pilot after the security
and distribution blockers below are resolved. The public npm onboarding path
failed before a user could start at the time of the initial review. Remediation
steps below record subsequent fixes; step 5 closes the public npm distribution blocker.

## Dependency refresh — 2026-10-03 (VARD-1)

The dedicated fix on `codex/vard-1-security-refresh`, based on main
`be4e3d3`, addresses the dependency advisories that stopped the September 30 CI
run. The same dependency update was initially checked against the complete local
server/UI stack based on `c6174f1`. A fresh audit found
**17 entries (6 high, 11 moderate)** before the update, including new Fastify
advisories. `pnpm audit --audit-level=moderate` now reports **zero**. The threshold,
seven-day minimum release age and trust protections are unchanged; no advisory
was ignored.

| Dependency | Previous | Validated version |
| --- | --- | --- |
| Fastify | 5.12.1 | 5.12.5 |
| Nodemailer | 9.1.1 | 10.0.10 |
| ip-address (transitive) | 10.5.0 | 10.7.2 |
| fast-uri (transitive) | 3.1.7 / 4.1.4 | 3.1.8 / 4.2.1 |

Nodemailer requires a major upgrade for the current fixes. Its
[Node 20 minimum](https://github.com/nodemailer/nodemailer/releases/tag/v10.0.0)
fits our Node 22 runtime. A regression test included in this fix exercises the real
`sendActionEmail` transport with an authenticated loopback SMTP receiver:
verification, password reset, email change and invitation messages retain their
sender/recipient envelopes, plain-text/HTML parts and escaped links; recipient
rejection propagates to the caller. External provider TLS and account recovery
acceptance remain VARD-13.

Validation of the dedicated main-based fix passed:

- Frozen-lockfile installation; **76 unit/release-script tests** (API 38,
  CLI 20, gateway 11, MCP 2, release scripts 5); typecheck and build.
- **41 PostgreSQL integration checks**, including parent/nested cases, in an
  isolated Node 22 / PostgreSQL 15 container.
- All three Compose configurations and independently installed candidate
  CLI/MCP tarballs.
- The production smoke with PostgreSQL 17 and real RustFS: signup, ingest,
  private delivery, native AVIF/codecs, transforms/cache, installed CLI/MCP and
  restricted runtime DB privileges. Its disposable stack was removed.

Additional validation of the same dependency update on the pre-existing local
server/UI stack (`c6174f1` plus the fix) passed 93 aggregate unit/release-script
checks, 60 DB checks, lint, Prometheus rules and the extended production smoke.
That smoke covers worker/storage/database outages, resource limits, upload
cleanup and clean-stack backup/restore of 22 objects / 7,833,862 bytes. These
features belong to the separate PR #3–#6 stack, not to this main-based fix.

Published-package impact was checked separately through a clean npm installation
of CLI **0.6.0**, MCP **0.2.0** and shared **0.2.0**. Both binaries run; the installed
tree has zero audit findings. CLI/shared do not depend on the affected families.
MCP resolves patched `fast-uri` and `ip-address` through its SDK dependency under
the existing ranges. A package release is not required just for these fixes;
existing MCP consumers with old lockfiles must refresh the affected transitive
resolutions and rerun their audit. The server must be rebuilt and deployed to
receive its fixes.

The dedicated security fix subsequently passed the full
[hosted CI gate](https://github.com/f-tuma/vardum/actions/runs/37117354545)
on commit `2b9ce10` and was merged in [PR #7](https://github.com/f-tuma/vardum/pull/7)
as `0f89a8c`. VARD-1 is complete. No new npm publication or production deployment
was performed. PRs #3–#6 require review and fresh CI after incorporating the fix;
the pre-fix PR #6 failure is historical. The following sections retain historical
measurements.

## Verified results

| Check | Result | Meaning and limits |
| --- | --- | --- |
| `pnpm test` | 60 passing tests | API 35, CLI 14, gateway 9, MCP 2; rerun outside the restrictive sandbox for local test servers |
| `pnpm typecheck` and `pnpm build` | Passed | All workspace projects build |
| `bash scripts/smoke-publish.sh` | Passed | Newly packed source tarballs install together through npm; CLI and MCP report their versions. This does not validate the already published artifacts or all commands. |
| `npm install @vardum/cli@0.5.0` in an empty temporary directory, scripts disabled | Failed | `EUNSUPPORTEDPROTOCOL: workspace:^` |
| Published CLI tarball inspection | No frozen implementation | Confirms the documented mismatch between npm 0.5.0 and the source build |
| `bash scripts/smoke-production.sh` | Failed after successful startup and ingest | Docker images built, migrations ran, API/worker/gateway started, RustFS upload and ingest succeeded. The test then expected anonymous delivery of a new private asset and received 401. |
| `test:private-delivery` in an isolated Node 22 / PostgreSQL 15 container | 19 passing tests, including nested test cases | Real database, migrations, authorization, folder resolution, normal/frozen CLI; object storage is a local HTTP fixture, not S3. |
| Isolated production-template auth checks | Confirmed problems below | Unverified allowlisted signup can create an organization; application database role is a superuser; owner-created write API key gets 401 on advertised administrative MCP endpoints. |
| `pnpm audit --prod --json` | 10 high, 9 moderate entries | Includes duplicate advisories for multiple dependency versions and optional/transitive dependencies; these are not 19 demonstrated exploits. |
| Added tab guides | Gateway build and existing tests passed; browser checked | All 17 tabs expose the appropriate collapsed guide; expanded guidance checked on desktop and mobile. |

Disposable Docker projects used separate databases, volumes and ports and were
removed after each run. No production deployment or npm publication was made.
The existing development data was not reset.

## Remediation progress

### Step 1 — verified ownership for organization allowlists (2026-09-20)

Fixed in the working tree; not deployed or released. Both the organization
creation endpoint and the directory's UI capability now require `emailVerified`
for allowlisted addresses. Client-supplied verification flags cannot grant this
permission. An unverified allowlisted user sees resend/check actions, including
invalid-link errors; without SMTP, creation stays blocked with administrator
guidance. `open` still explicitly allows every signed-in account, and existing
memberships are unaffected. Bootstrap and upgrade instructions are in
`docs/operations.md`.

Validation: API and gateway unit suites, API typecheck and gateway production
build passed. The new disposable-PostgreSQL integration check passes both SMTP
variants: real signup, direct creation denial, forged signup/update flags,
resend, invalid token, signed verification callback, successful verified
creation, and denial of a verified address outside the allowlist. Only outbound
verification delivery is stubbed. Browser QA covers the blocked state, resend,
recheck, invalid-link feedback, callback to the creation form and the blocked
no-SMTP state, including 384px mobile layout. Browser console was clean. No
production mail provider was contacted.

The regression check is wired into CI; pnpm setup now uses the root
`packageManager` version. GitHub Actions was not run here. The separate production
smoke/private-delivery mismatch remains, as do the database-role, dependency,
package-release and MCP blockers below. This step does not certify all password
reset, invitation or account-recovery flows.

### Step 2 — limited runtime database role (2026-09-20)

Fixed in the working tree; no live deployment changed. All three production /
Dokploy templates now give API and worker a separate `varda_app` connection.
The existing administrator is used only by PostgreSQL initialization and the
one-shot migration service. Deployments need a distinct, URL-safe
`POSTGRES_APP_PASSWORD`; existing databases do not need a reset. See the
[upgrade instructions](operations.md#runtime-database-role-upgrade).

The migrator prepares both Drizzle and pg-boss schemas, then provisions a
non-owner runtime role with data permissions. Runtime startup rejects superuser,
BYPASSRLS, elevated role attributes, memberships, ownership, schema creation and
TRUNCATE privileges. The app cannot edit the queue schema version or access BAM
migration commands. Queue DDL moved out of runtime startup; delivery retention
now sets a separate transaction-local workspace context for each deletion.

Validation: **27 passing integration checks**, including nested cases, using
disposable Node 22 / PostgreSQL 15 clusters. These exercise production migrations,
role grants, cross-workspace read/write denial, context cleanup after commit and
rollback, queue send/schedule/fetch/complete/maintenance, retention across two
workspaces, migration reruns preserving data/jobs, and entrypoint rejection of
administrator credentials. The existing private-delivery/folder/frozen-CLI suite
now uses the same `varda_app` grants as production. API unit tests and typecheck,
integration-fixture typecheck, and all three Compose configuration checks passed.

The **production Compose smoke also passes** with PostgreSQL 17 and real RustFS:
image builds, migrations, app startup, signup, organizations/workspaces, upload,
worker ingest, authorized private delivery, anonymous denial and analytics. An
extra probe inside the API container confirms `current_user=varda_app` and zero
asset rows without workspace context. Its old anonymous-200 expectation was
corrected to match private-by-default assets. Test containers and volumes were
removed; current development data and credentials were not changed.

These checks are wired into CI, but GitHub Actions and a live Dokploy deployment
were not run. Local development intentionally retains its schema-owner role.
RLS does not replace route authorization or protect against arbitrary SQL that
can choose another workspace context; auth and workspace-directory tables are
global, and verified-domain lookup retains its explicit read policy. Dependency,
package-distribution, MCP and broader acceptance blockers remain.

### Step 3 — dependency security and image compatibility (2026-09-20)

Fixed in the working tree; no release or live deployment made. A fresh full
`pnpm audit --json` went from **10 high / 9 moderate entries to zero known
vulnerabilities**, including development dependencies. No advisory was ignored.
This is a point-in-time dependency check, not a claim that the product has no
security defects.

| Dependency | Previous | Validated version |
| --- | --- | --- |
| sharp | 0.35.3 | 0.35.4 |
| nodemailer | 9.0.5 | 9.1.1 |
| fast-uri | 3.1.5 / 4.1.2 | 3.1.7 / 4.1.4 |
| qs | 6.15.3 | 6.16.0 |
| hono | 4.13.2 | 4.13.7 |
| esbuild through `@esbuild-kit/core-utils` | 0.18.20 | 0.25.12 |

The [sharp advisory](https://github.com/lovell/sharp/security/advisories/GHSA-rgj7-g3m4-5g8c)
matters directly here: production uses glibc Linux and accepts AVIF. The final
API image reports sharp **0.35.4** and libheif **1.23.2**, and successfully encodes
and decodes AVIF. The seven-day dependency age policy and trust protections stay
enabled. Transitive updates preserve their parent version ranges. The exception
is a narrowly scoped esbuild override for Drizzle's deprecated loader, matching
Drizzle's own supported esbuild line; remove it when Drizzle drops that loader.
Both its CJS/ESM transforms and SQL generation from the application's two schemas
were checked, with generated files confined to a temporary directory.

Validation:

- **62 unit tests**, workspace typecheck and production builds passed.
- **41 integration checks**, including nested cases, passed in disposable
  PostgreSQL clusters. New image checks exercise the real ingest and variant
  functions under `varda_app`: all seven accepted input types, AVIF/JPEG/PNG/WebP
  outputs, default-format behavior, decoded pixels/dimensions, checksums and
  repeated cache reads. Invalid bytes, MIME mismatch and excess pixels fail
  without becoming the current version. Storage for these checks is a local
  HTTP fixture.
- The **production Compose smoke passed with PostgreSQL 17 and real RustFS**.
  It now checks all four transformed output formats twice, byte-identical cached
  responses and delivery/cache analytics, plus AVIF decoding inside the API
  image. Existing ingest, authorization and runtime database checks also pass.
- Actual `sendActionEmail` calls delivered verification, reset and invitation
  template messages through nodemailer 9.1.1 to an isolated loopback SMTP
  fixture. No external email was sent. This was a local compatibility probe;
  production-provider authentication/TLS and full recovery flows remain separate
  acceptance work.
- Source tarballs still install and both CLI/MCP binaries run in a clean npm
  project (`smoke-publish.sh`). This does not repair the already published
  packages or validate every MCP command.

CI and the release workflow now fail on moderate-or-higher dependency advisories,
including build tools. Both workflows take pnpm from root `packageManager`;
GitHub Actions itself was not executed here. Disposable services were removed
and development data stayed intact. npm distribution, MCP authorization and the
broader acceptance/recovery items remain open.

### Step 4 — installable npm candidates and executable release gate (2026-09-20)

Prepared **CLI 0.6.0, MCP 0.2.0 and shared 0.2.0**, with repository metadata,
first-project instructions and a [compatibility/release procedure](npm-release.md).
The public versions are still unchanged: publication is pending. The new version
numbers were confirmed available by a read-only registry preflight.

The pinned pnpm produces three archives plus a SHA-512 release manifest.
Source `npm pack`/`npm publish` is blocked before it can ship `workspace:` ranges.
Archive checks require ordinary `^0.2.0` shared dependencies, matching versions,
runtime entrypoints and clean contents. Both CLI and MCP install independently
by package name from a temporary scoped registry: shared resolves transitively,
instead of being explicitly installed alongside a potentially broken CLI/MCP.
Modified-archive rejection and the raw-npm packing guard were exercised.

The release workflow now requires the matching CLI tag and publishes these exact
tested archives in shared → CLI → MCP order. It checks all version/integrity
conflicts before starting; only identical existing archives may be skipped on a
retry. Auth/RLS/private-delivery integrations and the real production Compose
smoke run before publication. A post-publication check verifies registry hashes
and installs both packages independently from npmjs. Hosted Actions and actual
publication/post-publication checks have **not** run locally.

MCP now advertises **11 asset/Vard tools** that its workspace key can use.
Session-only administration tools were removed and documentation directs users
to the web app. No API authorization was broadened. Actual API tests exposed and
fixed another contract bug: manual pins must send `versionId`, not the previously
ignored `pinned` boolean. The old boolean is now rejected. Asset listing returns
explicit pagination, and the MCP handshake reports the actual package version.

Validation passed: **62 unit tests**, **41 integration checks** (including nested
cases), workspace typecheck/build and a clean dependency audit. The disposable
PostgreSQL 17 / RustFS production stack was tested using independently installed
candidate binaries, with no tsx/source fallback:

- CLI init, login callback with a real session-created key, wrong-state rejection,
  mode-0600 credentials, private pull, normal update, writable push, pinned and
  transformed outputs, schema 2 frozen restore of the original four files after
  deleting the live Vard, unchanged lock bytes, logout and server-side revocation.
- All 11 advertised MCP tools and resources, multipart upload through RustFS,
  ingestion, explicit public/private delivery, pagination, folder resolution,
  exact-version pinning, rejection of the obsolete pin flag, read-key mutation
  denial and cross-workspace denial. Owner-created keys still get 401 on the
  browser-only members endpoint.
- Existing production codec, transform-cache, analytics and runtime-role probes.

The browser grant was simulated; this is not a new browser UI acceptance test.
The test services/volumes were removed and existing development data preserved.
The public-install blocker remains open until these candidates are published and
the registry checks pass. Remaining worker recovery, backup/restore, resource
budget and external-user acceptance work is unchanged.

The findings below preserve the original audit evidence. The creation bypass in
blocker 2, runtime-role bypass in blocker 3, dependency findings in blocker 4,
and the specific CI version/smoke/missing-integration gaps in blocker 6 are
addressed by steps 1–3. Step 4 prepares the npm fix and addresses MCP/tool and
release-gate contracts in source. Step 5 below completes public publication.

### Step 5 — verified public npm release (2026-09-20)

Published **CLI 0.6.0, MCP 0.2.0 and shared 0.2.0** from tag `v0.6.0`, commit
`e8d17667933601ea7055bda8cabee26ac510e40f`, through GitHub Actions and npm OIDC.
Each package trusts only `frgtn-dot-dev/vardum` workflow `release.yml` using the
`npm` environment; that environment accepts only `v*` tags. No persistent npm
token was added. npm provenance is unsupported for the private source repository.

The [release workflow](https://github.com/frgtn-dot-dev/vardum/actions/runs/35520781363)
passed its dependency audit, unit tests, typecheck/build, PostgreSQL integrations,
independent candidate installations and production Compose smoke with real RustFS.
The exact tested archives were published in dependency order. Registry hashes
matched, and independent clean public-npm installs of CLI and MCP passed,
including transitive shared resolution and CLI init checks.

The first registry check ran before npm propagation finished. Retrying the publish
job reused the same archives and skipped identical versions; verification and
GitHub release creation then succeeded. The release gate now retries missing
registry versions for a bounded period without retrying integrity or registry errors.

This closes blocker 1 for the new versions and validates hosted release execution.
Historical findings below remain for context. No production instance was deployed;
worker recovery, backup/restore drills, resource budgets and external-user acceptance
remain open. See [release status and compatibility](npm-release.md).

### Step 6 — interrupted ingest recovery (2026-09-21)

Implemented in source; no live production deployment or new npm release.
Migration `0011_asset_ingest_recovery.sql` adds durable job/attempt identifiers,
a retry flag and a partial processing index. Enqueue and version state commit
atomically. Startup/minute reconciliation follows pg-boss state across workspaces:
live jobs remain processing, while exhausted or missing jobs become failed and
retryable. Existing queued jobs are adopted without duplicate enqueueing.

Version history now shows the failure and **Retry processing** for authorized
publishers. Retry reuses the stored object and version; concurrent requests enqueue
one job. Attempt fencing and abort signals protect against expired workers;
older ready versions stay current until a newer version successfully finishes.
Invalid image bytes/type/limits require a replacement upload. Detail/history
refresh while processing and clear the failure after success.

Validation:

- Workspace unit tests, typecheck and build passed.
- **38 private-delivery integration checks**, including seven new recovery cases,
  passed against disposable PostgreSQL with the limited production role. They cover
  transaction rollback, temporary storage outage, retry exhaustion, role/tenant
  denial, concurrent retry, invalid bytes, missing/legacy jobs, stale attempt
  completion and actual SIGKILL/restart of a worker process. Object storage in
  this suite is an HTTP fixture.
- **Eight runtime-database checks** passed, including migration reruns and queue
  operations with the restricted role.
- **Production Compose smoke passed with real RustFS**: stop object storage,
  exhaust a queued upload's attempts, allow scheduled reconciliation, restart
  storage/worker, retry through the authorized API and verify the original
  version ID, current pointer and checksum. Retry backoff is shortened only in
  that disposable stack. Existing installed CLI/MCP acceptance, transformations,
  private delivery and deployed database role checks also passed.
- Browser QA on localhost covered failure → Retry processing → processing → ready
  without a manual reload, and desktop/mobile layout. Errors use a full-width
  row beneath the action to remain readable on narrow screens. No relevant
  browser console errors were observed. Only temporary QA fixture data was used.

See [operations](operations.md#interrupted-upload-processing) for upgrade and
recovery instructions. Recovery requires a running worker/database and waits for
queue expiry/maintenance; the minute schedule is not a one-minute SLA. This closes
the stuck-processing/operator-retry gap. Worker health/queue alerts, never-finalized
upload cleanup, backup/restore rehearsal, resource budgets and first-user acceptance
remain open.

### Step 7 — worker health and operational monitoring (2026-09-21)

Implemented in source; no live production deployment or npm release. Additive
migration `0012_worker_heartbeat.sql` stores expiring worker heartbeats, with no
tenant data or job payloads. A heartbeat requires responsive queue pollers;
process liveness alone is insufficient. All three production/Dokploy templates
now include a container-local worker health check.

The optional `MONITORING_TOKEN` enables private fleet health and Prometheus
endpoints. They check PostgreSQL/queue state, S3 bucket reachability, live worker
count, eligible waiting-job age, active-job age and recent terminal failures.
Probes have bounded timeouts and a short shared cache; failed database observations
omit unknown queue/worker metrics instead of reusing stale successful readings.
Public API readiness retains its existing database-only meaning.

Six Prometheus alert rules cover dependency failure, failed scrapes, missing queue
observations, no workers, stalled queues and exhausted retries. Configuration and
response instructions are in [operations](operations.md#worker-and-queue-monitoring).
These are tested rules, not an installed monitoring/notification service: operators
must configure the scrape target, secret and Alertmanager receivers, then verify
real notification delivery.

The database-outage drill also exposed an unhandled idle-connection pool error
that terminated the API. The shared application pool now handles that event,
leaving ordinary query errors visible and allowing subsequent connections to recover.

Validation:

- **81 unit tests**, workspace typecheck and production builds passed.
- **49 integration checks** (38 private-delivery and 11 runtime-database) passed
  in disposable PostgreSQL clusters. Monitoring checks use the limited runtime
  role and cover multiple replicas, deferred retries, failure-window expiry,
  aggregate-only responses and a blocked SQL query timing out and recovering.
- **Production Compose smoke passed with real RustFS and PostgreSQL 17**: freeze
  a worker until its heartbeat expires, resume it, stop/restart object storage,
  exhaust/retry an upload, stop/restart the database and confirm monitoring recovery.
  Existing installed CLI/MCP, transforms, private delivery and role checks passed.
- All three Compose configurations and Prometheus rule validation passed. Alert
  simulations check delayed firing and recovery; CI and release gates run them.

The earlier recovery PR's hosted CI timeout was also corrected: its worker restart
test now allows the production queue's 30-second fallback polling interval when
the initial notification is missed. The rerun passed without changing worker behavior.

Development data was retained; outage drills used disposable services. This closes
the missing worker/queue visibility gap in source. Deployment, alert routing,
never-finalized upload cleanup, matched backup/restore rehearsal, resource budgets
and first-user acceptance remain operational/release work.

### Step 8 — matched backup and clean-stack restore (2026-09-21)

Implemented the maintenance backup/verify/restore tool in `scripts/backup.mjs`.
The previous instructions copied objects with `aws s3 sync` and restored over
an existing schema; they neither verified the matched bundle nor retained all
content metadata. The new format stores a custom PostgreSQL dump, required original
references, streamed object bytes, metadata and SHA-256 checksums. The complete
manifest is written last. Missing/corrupt originals for ready or processing
versions prevent completion, and files named by S3 keys cannot escape the bundle.

Restore requires stopped application services, an empty database and an empty
bucket. It validates every local byte and the archive before destination writes,
restores the database transactionally without source owner/ACL assignments,
re-reads uploaded objects to verify their bytes and metadata, then provisions the
restricted runtime role/grants through the normal migrator. It never wipes a
destination or automatically starts a partially restored application. Expiring
worker heartbeat rows are omitted while durable queue jobs are retained.

Validation:

- **86 unit tests**, workspace typecheck/build and script syntax checks passed.
  New cases cover byte corruption, missing/symlinked/path-traversing entries,
  empty objects, duplicate keys, changing buckets, occupied targets and missing
  or mismatched database-referenced originals.
- The production smoke creates a backup of a real PostgreSQL 17/RustFS stack
  and restores into a second project with independent empty volumes. It compares
  application row counts, version/current pointers and object bytes/metadata;
  validates sessions, password login, private anonymous denial, API key scope,
  pre-backup signed transforms, saved Vards and byte-identical frozen pulls with
  the installed npm CLI. A pre-backup queued upload must complete in the new worker.
- The drill rejects a corrupt backup and refuses an occupied bucket/database
  without overwriting their contents. Both projects are cleaned up. The same
  drill is required by CI and the npm release validation gate.

A local run used 10 objects (1,460 object bytes and approximately 106 KiB of
database archive): backup took 1.8 seconds and fresh-target recovery/acceptance,
including refusal checks, took 35.6 seconds. This measures the small functional
fixture, not production recovery time.

No live production deployment, new npm release, scheduled backup or off-host copy
was created. Existing development data was retained. This closes the missing
matched restore rehearsal for the production template, not a universal disaster
recovery guarantee. Operators still need encrypted off-host retention, recoverable
secrets, a provider/Dokploy-specific rehearsal and production-scale RPO/RTO tests.
The tool covers current object bytes/content metadata, not bucket policies, tags,
provider version history, KMS configuration or infrastructure. It requires a write
freeze and is limited to 5 GiB per object; larger workloads need a provider-native
strategy. See [backup/restore instructions](operations.md#backup).

Resource budgets, never-finalized upload cleanup, first-user acceptance and an
actual production-size upgrade/rollback rehearsal remain separate work.

## Release blockers

### 1. Public npm CLI and MCP artifacts have unresolved workspace dependencies

On the registry, `@vardum/cli` latest is **0.5.0**, `@vardum/mcp` latest is **0.1.0**,
and `@vardum/shared` latest is **0.1.0**. Both CLI and MCP declare
`"@vardum/shared": "workspace:^"` in their published metadata. A clean npm CLI
installation reproduced the unsupported-protocol error. MCP has the same
invalid dependency declaration; its full published installation was not separately
executed. Registry metadata was checked directly with `npm view`.

The current source packaging smoke succeeds, so packaging the current source
through the tested pnpm path is promising. However, source and published packages
still have identical version numbers despite different capabilities. Publishing
without version changes will skip existing versions; immutable registry versions
cannot simply be replaced.

Before release: assign new versions, verify the packed manifests contain ordinary
semver dependency ranges, publish in dependency order, then install the actual
registry artifacts in a clean project. Test login, private pull, frozen pull and
the advertised MCP tools using those installed packages. Publish an API/CLI/MCP
compatibility table and minimum frozen-capable CLI version. The changelog also
needs explicit snapshot, visibility and folder-rule entries.

Evidence: `apps/cli/package.json`, `apps/mcp/package.json`,
`scripts/smoke-publish.sh`, `apps/cli/README.md` (minimum compatible CLI),
[CLI registry metadata](https://registry.npmjs.org/@vardum%2Fcli/latest),
[MCP registry metadata](https://registry.npmjs.org/@vardum%2Fmcp/latest).

### 2. Organization allowlisting does not prove email ownership

`auth.ts` sends verification mail when SMTP is configured but does not require
email verification for password authentication. Organization creation checks the
email string only. In a disposable production stack using `allowlist`, a fresh
signup with the allowlisted address returned `emailVerified: false`, received a
session and successfully created an organization (HTTP 200).

This permits claiming an unused allowlisted address before its owner signs up;
it is not evidence that an existing account or organization was taken over.
The runtime reproduction used SMTP disabled. Enabling SMTP adds mail sending,
but source inspection shows no verification gate on the privilege check.

Before release: require verified ownership before email-derived privileges;
define a deliberate bootstrap path when SMTP is unavailable. Cover both SMTP
and no-SMTP policies, signup, verification, reset and invitation acceptance with
integration tests and clear UI states.

Evidence: `apps/api/src/auth.ts:21`, `apps/api/src/auth.ts:35`,
`apps/api/src/auth.ts:69`, `apps/api/src/organization-policy.ts`.

### 3. The production database connection bypasses RLS

All three production/Dokploy templates set `POSTGRES_USER=varda` and connect
the application using that same role. The isolated production stack reported
`rolsuper=true` for `varda`. PostgreSQL superusers bypass row-level security,
including forced RLS.

Route authorization still exists and its integration tests passed; this finding
does not demonstrate a cross-workspace HTTP leak. It means the database isolation
layer tested with an unprivileged fixture role is absent in the shipped stack,
and a query bug has a larger impact.

Before release: separate bootstrap/migration privileges from the runtime role,
grant the runtime only the necessary permissions, and run tenant-isolation tests
against the actual production role configuration. Verify pg-boss initialization
and migrations still work under the intended roles.

Evidence: `compose.production.yml:3`, `compose.production.yml:33`, corresponding
Dokploy templates, `apps/api/src/db/tenant.ts`,
`apps/api/integration/private-delivery.test.ts`.

### 4. Vulnerable image-processing dependency is on the upload path

The API pins `sharp` **0.35.3** and accepts AVIF. Its upstream advisory affects
versions below **0.35.4** and specifically concerns untrusted image decoding on
glibc Linux. The production API uses Debian/glibc, and both ingest and variant
generation decode uploaded images. This is a relevant release blocker, not just
an unused tool dependency. No exploit payload was run.

Upgrade and revalidate accepted formats and transformations. Triage the remaining
audit entries rather than treating the total as proof of exploitability:
`fast-uri`, `nodemailer`, `qs`, `hono` and optional `esbuild` are also reported.
MCP uses stdio, so HTTP-only SDK dependency findings need a reachability check.
The app constructs mail bodies itself, which also affects Nodemailer exposure.

Evidence: `apps/api/package.json:33`, `apps/api/src/asset-processor.ts`,
`apps/api/src/image-variant.ts`, `packages/shared/src/mime.ts`,
[sharp advisory](https://github.com/lovell/sharp/security/advisories/GHSA-rgj7-g3m4-5g8c),
[Nodemailer advisory](https://github.com/nodemailer/nodemailer/security/advisories/GHSA-2x7j-588g-ccc2).

### 5. Advertised MCP administration is incompatible with its authentication

The MCP client only supplies `x-api-key`. Administrative endpoints require a
browser session via `authorizeWorkspaceAdmin` or `auth.api.getSession`.
In an isolated stack, an owner-created write key successfully listed assets but
received 401 from organization listing, member listing and API-key listing.
`get_workspace` also depends on the member endpoint, so it cannot complete.

Before release: either remove/clearly mark unsupported tools or design explicit,
scoped administrative authorization. Do not fix this by accepting ordinary asset
keys as unrestricted administrator credentials. Test every advertised tool
against the real API; the current two MCP tests primarily check forwarded requests.

Evidence: `apps/mcp/src/index.ts:65`, `apps/mcp/src/index.ts:254`,
`apps/mcp/src/index.ts:299`, `apps/api/src/authorization.ts:20`,
`apps/api/src/organization-routes.ts`.

### 6. The release gate is out of sync with current behavior

The production smoke test uploads a private asset and expects an anonymous 200.
It reproducibly fails with 401. Update it to prove anonymous denial, authenticated
delivery and deliberate public delivery, then include a real Vard and normal/frozen
CLI cycle. Do not change the private-by-default behavior to satisfy the old test.

The deeper private-delivery integration suite is not invoked by CI or the release
workflow. CI and release also pin pnpm 10.32.1 while `package.json` declares 12.4.2;
reconcile that before expecting reproducible runner behavior. The hosted Actions
workflow itself was not executed in this review.

Evidence: `scripts/smoke-test.js:119`, `.github/workflows/ci.yml`,
`.github/workflows/release.yml`, `package.json:7`.

## Operational and lifecycle gaps before dependable external use

- **Worker failure recovery (addressed in step 6):** the original audit found
  versions stuck in `processing` after a persistent storage outage exhausted the
  queue retries. Terminal reconciliation, authorized retry and outage/restart
  tests now cover this path. Deploy the migration and matching worker/API/gateway
  together; step 7 adds worker monitoring.
- **Readiness and alerting (implemented in step 7):** worker heartbeat/Compose
  health, queue age/failure metrics and storage probes now have dedicated protected
  endpoints and tested alert rules. `/ready` still checks PostgreSQL only. Operators
  must deploy these changes and configure/test external notification delivery.
- **Resource budgets:** per-file limits exist, but no workspace storage quota,
  general delivery/transform admission limit or global transform concurrency cap
  was found. The in-process variant map only deduplicates identical work. Establish
  load limits and measure memory/latency before an untrusted multi-tenant service.
- **Recovery (matched restore covered in step 8):** the production-template drill
  now restores verified database/object bundles into a clean stack and exercises
  auth, delivery, CLI and queued work. Encrypted off-host retention, real-data
  recovery timing, provider-specific failover and upgrade/rollback rehearsals
  still need deployment-level validation.
- **Frozen delivery lifetime:** snapshots lock membership and verified bytes, but
  are not an archive. URLs still depend on the current source key, workspace slug,
  signing configuration, retained versions and reachable server. Source-key changes
  can invalidate historical URLs despite retained bytes. Prefer an immutable
  identity-based delivery contract before promising broad historical rebuilds.
- **Deletion:** a normal pull without `--delete` drops stale tracking while leaving
  stale files on disk. This is documented behavior; the UI guide now explains the
  timing. Consider retaining a cleanup ledger if real users repeatedly miss it.

## Product plan status

| Plan item | Assessment |
| --- | --- |
| Versioned library, intentional public/private assets | Implemented and covered by real auth/database tests; upgrade and public-cache limitations remain important |
| Manual project mappings, pins, image transformations | Implemented; npm distribution currently blocks ordinary onboarding |
| Recursive folder rules | Implemented in source; ready originals, collision rejection, bounded output count, repairable configuration tested |
| Intentional updates vs locked CI builds | Schema 2 and frozen source CLI pass integration; no released compatible npm version and lifecycle caveats remain |
| First real app-and-web acceptance scenario | Still open: no evidence of the full two-project Musubi scenario, old-commit rebuild, independent update and reviewed result |
| Reusable templates, input slots, platform previews/checks | Planned, not implemented by existing resize presets |
| Usage inventory and outdated-asset monitoring | Planned; delivery analytics are not a project usage inventory or outdated-logo detector |
| Generic non-media files | Not supported yet; accepted formats are images and video |
| Validation with two additional teams | Still open |

Templates and monitoring are not prerequisites for the first dependable handoff
milestone. Shipping them before fixing distribution, authorization, isolation and
the release gate would expand the surface without completing that milestone.

## First-use assessment and changes made

An experienced developer can infer the data model after reading the repository.
A new user is likely to stall at the handoff from uploading an asset to getting
that asset into a project. The prior CLI tab contained JSON and a tooltip, without
an ordered setup/build workflow. The terms asset, Vard, public manifest, latest,
pin and frozen refer to different concepts that need a concrete example.

Added collapsed **Quick guide** sections to all 17 Vard, workspace, organization
and account tabs. They explain purpose, examples, next actions and relevant
consequences. Tooltips remain for short field explanations; multi-step guidance
stays open while the user works and can be used with keyboard or touch. The CLI
guide explicitly notes the current published-version limitation rather than
claiming a working npm install. Workspace “Public path” was renamed to “Delivery
path” because a URL does not imply public access.

Follow-up after UI feedback: narrowed the guides from 17 tabs to five workflows
that benefit from instructions: Vard files, folder rules, CLI configuration,
custom domains and API keys. Routine workspace, organization and account
settings, activity, previews and destructive actions have no guide panel.

The next UI/CLI pass added a copyable terminal setup command to each Vard
(exact CLI install → init with the selected IDs → browser login → pull).
CLI init now honors dry-run, reports missing non-interactive arguments, reuses
identical configurations and protects different/invalid files unless forced.
Login preselects the project's workspace. File cards show saved output previews;
the edit dialog shows the selected source version, including pinned versions.
Desktop/mobile checks covered copying the command and existing/new file previews.
CLI tests (20), gateway tests (11), independent npm archive installations and
the disposable production smoke passed. Updated unpublished candidate archives
are in `artifacts/npm/init-setup`; the earlier archives remain unchanged.

Still needed for a convincing first use:

1. One guided path: create/open workspace → upload → create Vard → map an output
   → connect CLI → first successful pull → commit lockfile → frozen CI example.
2. Ready-to-copy setup commands tied to a verified, installable package version
   and the selected Vard; ideally a downloadable `vardum.json`.
3. A small sample project and an onboarding check that confirms a real successful
   pull, not merely creation of empty records.
4. Clearly display whether SMTP, custom domains and organization creation are
   available, instead of presenting unavailable actions followed by errors.
5. First-user sessions with someone unfamiliar with the terminology. This review
   is a heuristic assessment, not evidence that users can complete the workflow.

## Recommended order and exit criteria

1. **Security:** gate email-derived privileges, separate runtime DB role, update
   the reachable image-processing dependency and triage remaining advisories.
2. **Distribution and compatibility:** new CLI/MCP/shared versions, clean registry
   installation, supported MCP tool/auth contract and explicit server compatibility.
3. **Release gate:** repair smoke assertions, run private/frozen integration in CI,
   align toolchain versions, test one complete production install and recovery.
4. **Product acceptance:** execute the real two-project scenario, then a first-user
   session. Ship the concise setup path alongside the tab guides.
5. **Later milestones:** templates with useful previews, then configured usage
   monitoring; choose additional file formats from those real workflows.

No authentication, role, dependency version, published artifact or production
deployment was changed during this review. The implemented changes are the
contextual guides and the delivery-path wording.
