# Production readiness review — 2026-09-20

Scope: the Vardum product, published npm packages and deployment templates,
not the configuration of the current development instance. Reviewed repository
HEAD `0bc5fdf` together with the existing uncommitted changes. This is a point-in-time
engineering review, not a penetration test or a capacity certification.

**Decision: not ready for an unrestricted production release.** The source build
has a credible foundation for a supervised small-team pilot after the security
and distribution blockers below are resolved. The public npm onboarding path
currently fails before a user can start.

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
release-gate contracts in source; public publication is still pending.

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

- **Worker failure recovery:** storage failures throw outside the image-validation
  error handler after the version is marked `processing`. Queue retries exist,
  but there is no application-level final retry exhaustion reconciliation or
  operator retry flow. A version can stay in processing after a persistent outage.
  Add terminal status, retry/reconciliation and a recovery test.
- **Readiness and alerting:** `/ready` checks PostgreSQL only. The worker has no
  health/heartbeat check in Compose. Add queue age/failure visibility and object-store
  checks/alerts so healthy HTTP does not conceal a stopped ingest pipeline.
- **Resource budgets:** per-file limits exist, but no workspace storage quota,
  general delivery/transform admission limit or global transform concurrency cap
  was found. The in-process variant map only deduplicates identical work. Establish
  load limits and measure memory/latency before an untrusted multi-tenant service.
- **Recovery:** backup/restore procedures exist, but this review did not execute
  a matched database-and-object restore, upgrade/rollback rehearsal, or disaster
  recovery timing. Schedule and test those against the release candidate.
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
