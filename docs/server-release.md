# Server candidate preparation

`server-v0.7.0` is a provisional **server-only** candidate name. This procedure
prepares a portable Docker bundle and validates it; it does not create a tag,
GitHub release, npm publication, registry push or deployment. The existing
`release.yml` remains the separate npm publisher: its `v*` tag must match the
CLI version and it publishes shared → CLI → MCP. Do not use that workflow for
this server candidate.

The preparation policy covers API/worker, the standard and Dokploy gateways,
and migrations **0000–0016**. Its explicit public compatibility clients remain
`@vardum/cli` **0.6.0**, `@vardum/mcp` **0.2.0** and `@vardum/shared` **0.2.0** on
Node 22 or newer. `candidate.json` records these as `clientVersions`, separately
from `sourceClientVersions` read from the exact build context. A source version
bump does not change public-npm selection or establish package availability.
CLI and MCP install separately, including verification of transitive shared
versions, for the deployed lifecycle and clean-stack restore drill. First-project
onboarding uses the same explicit CLI baseline.

Frozen snapshots retain **schema 2**, with minimum CLI **0.6.0**. CLI **0.7.0**,
MCP **0.3.0** and shared **0.3.0** were independently published and verified on
October 11; see [npm evidence](npm-release.md#october-11-publication-evidence).
This procedure still selects the historical 0.6/0.2/0.2 compatibility clients;
the publication does not change that explicit contract or certify a server bundle.
The new resumable folder upload/import operations require that client release
and the matching server capabilities (`folderUploadResume: 1`, and
`folderVardImport: 1` for Vard imports). Public baseline compatibility acceptance
does not prove those new CLI operations. Candidate smoke skips newer-client folder
import assertions for the actual public consumer selection; ordinary source CI
continues exercising its packed CLI. The same explicit feature-check guard is the
integration boundary for future guarded MCP editor assertions: public MCP 0.2.0
must continue using its legacy protocol, without `expectedRevision`/editor-shape
claims. Sanitized candidate evidence records both new-client features as outside
public-baseline coverage.

VARD-70 prepares this tooling for review. VARD-6 still requires a new clean bundle
from the final reviewed source and full unchanged-artifact acceptance. The older
07a96faa candidate and source-build CI are not substitutes for that artifact.

## Prepare the bundle

From a clean checkout of the reviewed commit, using Node 22 and the pinned pnpm:

```sh
pnpm install --frozen-lockfile
pnpm audit --audit-level=moderate
pnpm test
pnpm typecheck
pnpm lint
pnpm build
node scripts/server-candidate.mjs prepare /tmp/vardum-server-candidate
node scripts/server-candidate.mjs check /tmp/vardum-server-candidate --require-clean --expected-commit "$(git rev-parse HEAD)"
SMOKE_IMAGE_REPORT_DIR=/tmp/vardum-server-runtime SMOKE_SERVER_CANDIDATE=/tmp/vardum-server-candidate bash scripts/smoke-production.sh
node scripts/server-candidate.mjs check /tmp/vardum-server-candidate --require-clean --expected-commit "$(git rev-parse HEAD)"
node scripts/server-candidate-evidence.mjs /tmp/vardum-server-candidate /tmp/vardum-server-runtime /tmp/vardum-server-sanitized --expected-commit "$(git rev-parse HEAD)" --acceptance-status success
```

Use new, nonexistent candidate, runtime-report and sanitized-output directories.
API, standard gateway (`runtime` target) and Dokploy gateway (`dokploy` target)
are each built once for **linux/amd64**, using a temporary tracked-only `git archive`
of the recorded commit so ignored local files cannot enter clean image builds.
Production and Dokploy development Compose use the saved standard gateway;
production Dokploy Compose uses the distinct saved `gateway-dokploy` image with
its baked marketing template. PostgreSQL 17, RustFS 1.0.1 and the bucket-init
AWS CLI image are included in the same `docker save` archive, with their actual
image IDs. Unique candidate tags preserve existing application/smoke tags.
The manifest records commit, Git tree, platform, image tags/IDs and config IDs, archive SHA-256,
every deployment-file checksum, all migration SHA-256 values, exact source client
versions and the separate public compatibility versions. Migration verification
requires the exact 0000–0016 tag/index order, strict JSON, and positive safe-integer
`when` values in strictly increasing order; Drizzle uses those timestamps.
It also includes Compose files without build sections, nginx routing, example
environment files, monitoring rules, migration review copies, backup tooling and
these instructions. Secrets and an actual `.env.production` are excluded.

The gateway's production upload URL validation accepts HTTP(S) URLs returned by
the API. `VITE_UPLOAD_ORIGINS` is a development-only check, not a production origin
restriction. The optional preparation `--upload-origins` value is recorded as
development metadata and normalized to the gateway's comma-separated format;
its default is `http://localhost:19000`. External-provider acceptance separately
requires correct API `S3_PUBLIC_ENDPOINT`, provider CORS and a real browser UI
upload/download check. Bundled RustFS acceptance does not establish that support.

`--allow-dirty` is an explicit local implementation-proof exception. The manifest
records `source.dirty=true`; loading it requires `--allow-dirty`, and the smoke
requires `SMOKE_ALLOW_DIRTY_CANDIDATE=1`. Such output is not eligible for release
certification. The validation workflow prepares only clean artifacts. Rebuild
and rerun full acceptance after the final reviewed commit; do not relabel a dirty
bundle or replace its manifest.

## Opt-in Node26 compatibility candidate

The default production runtime and Node22 build stage stay unchanged. To prepare
the separately approved **test candidate**, pass `--api-runtime node26` only to
`prepare`; `node22` is the default. Arbitrary image references are not accepted,
and check/load/running cannot override a saved selection. The manual validation
workflow offers the same choice with a Node22 default and read-only permissions.
It does not publish or deploy either candidate.

The Node26 profile pins the authenticated Distroless nonroot index
`sha256:a3bb283a564754266646d6029c5b6aa4f760b9415dae1398db8d7f8142ee1375`.
Its actual runtime is **Node 26.11.0 / OpenSSL 3.5.9**; the official release index
lists newer 26.11.1. Node26 is **Current**, rather than LTS. Before saving and
during running-image acceptance, a bounded network-disabled probe requires that
actual version pair, UID 65532, Linux/amd64 and the release-verified Node ELF hash
`c445d85bb8886e15bbc85973134274fb190088233b174841b9999dbabfeef9f8`.
The selection and observations appear in `candidate.json` and the sanitized
candidate summary. Legacy bundles without this field remain selection-unspecified;
validation never invents a runtime identity from their tags. Profile metadata is
not author authentication, advisory disposition or release approval.

```sh
node scripts/server-candidate.mjs prepare "$CANDIDATE" --api-runtime node26
node scripts/server-candidate.mjs check "$CANDIDATE" --require-clean --expected-commit "$(git rev-parse HEAD)"
SMOKE_SERVER_CANDIDATE="$CANDIDATE" SMOKE_IMAGE_REPORT_DIR="$REPORTS" bash scripts/smoke-production.sh
node scripts/server-candidate.mjs check "$CANDIDATE" --require-clean --expected-commit "$(git rev-parse HEAD)"
node scripts/server-candidate-evidence.mjs "$CANDIDATE" "$REPORTS" "$SERVER_SUMMARY" --expected-commit "$(git rev-parse HEAD)" --acceptance-status success
node scripts/runtime-evidence.mjs "$REPORTS" "$RUNTIME_SUMMARY" --expected-commit "$(git rev-parse HEAD)" --acceptance-status success --job-status success
```

Choose distinct, new local directories with space for full archives and the
scanner database. Keep them unchanged for acceptance and local replay. The second
projection retains detailed native/TLS evidence; the server projection retains
candidate identity and aggregate compatibility results. Raw image archives,
scanner databases, environments and logs must not be added to workflow uploads.

The existing suite covers the public 0.6/0.2/0.2 client baseline, native codecs,
RLS, 42 actual TLS cases and unchanged-image clean-stack restore. It preserves
older frozen snapshots created within that same candidate lifecycle; it does
not establish a historical Node22-to-Node26 upgrade or newer published-client
editor/import protocol coverage. Inspect each actual result before claiming PASS.
Reconcile all fresh findings and the 14 OpenSSL advisory records separately.
Debian system zlib CVE-2026-85091 remains unresolved; Sharp's zlib-ng is a separate
component. This optional preparation cannot mark VARD-55/74 or formal VARD-6 Done,
authorize production adoption, or replace external-provider acceptance.

See [runtime security](runtime-image-security.md),
[Node lifecycle](https://nodejs.org/en/about/previous-releases), the
[official security advisory](https://openssl-library.org/news/secadv/20260929.txt)
and the [Distroless catalog](https://github.com/GoogleContainerTools/distroless#what-images-are-available).

## Accept the exact artifact

Keep the tested directory intact and retain full image exports/scanner database
locally. CI uploads only sanitized evidence, so it does not offer a downloadable
portable bundle or self-contained offline replay. Separately obtained copies
can be checked and loaded
without the source repository, Node dependencies or build tools (Node 22, Docker
Compose and GNU tar are required):

```sh
cd /path/to/downloaded-candidate
node scripts/server-candidate.mjs check . --expected-commit REVIEWED_COMMIT_SHA
node scripts/server-candidate.mjs load . --expected-commit REVIEWED_COMMIT_SHA
```

Use the reviewed commit identity and manifest/archive hashes from independently
retained source-review and workflow evidence, not values copied solely from an
untrusted manifest. Checksums detect changed files; they do
not authenticate an artifact's author. Inspect `candidate.json` and retain it
alongside the workflow run and acceptance log. A conflicting existing candidate
tag is rejected before loading. Validation rejects changed hashes, wrong
versions/platform/commit, missing/extra files, unsafe archive paths, symlinks,
hard links, ambiguous or duplicate TAR names, unsupported TAR extension records,
unexpected image IDs/tags, duplicate decoded JSON keys, case/Unicode aliases of
known Docker/OCI structural fields, schema 1 discriminators, invalid typed
Docker/OCI metadata, invalid selected OCI media types and
layer/config identity mismatches before Docker mutations. Annotation and label
map keys remain case-sensitive. Structured Docker/OCI metadata requires integer
number tokens within the verifier's exact safe-integer range; decimal and exponent
spellings are unsupported even when they evaluate to integers. In-toto predicate
content remains generic JSON. TAR preflight checks every consumed header number,
including mode, owner/group IDs, timestamps and device numbers. Supported numeric
encodings are nonnegative octal and base-256 within the same exact integer range;
GNU access/change times must be valid numbers, without a legacy prefix fallback.
Layer validation streams the exact
uncompressed SHA-256 in config order. The supported saved-layer encodings are
uncompressed and gzip; other codecs require a separately reviewed verifier.

OCI graph validation covers every present reachable index/manifest, including
foreign-platform images and configs/layers. Each candidate must have one
unambiguous runnable linux/amd64 leaf bound to the recorded Docker config.
Duplicate matching paths, platform-less index children, normalized platform
aliases, contradictory nested platform declarations and AMD64 variants are
rejected. Missing references are permitted only for explicitly canonical foreign
manifest platforms consistent with every ancestor declaration. Missing strictly
marked build attestations must reference a declared canonical foreign runnable
manifest; attestations for the certified platform must be present. Matching,
platform-less and index references must be present. Inline descriptor data must
match its digest, size and archived content; inline-only content is unsupported.
Root and nested indexes must have the supported index shape, without manifest
config/layers, subjects or artifact types.

Supported inert artifacts are explicitly marked unknown/unknown Docker build
attestations with verified in-toto JSON layers. The current form uses the Docker
attestation artifact type, an exact empty config and a subject bound to a validated
runnable leaf. The retained legacy BuildKit form has no artifact type/subject,
requires an exact unknown/unknown config with empty runtime metadata and RootFS
IDs equal to its raw JSON layer digests, and binds each statement to the descriptor's
reference digest and a validated runnable leaf. Other artifact/subject forms are
rejected. Graph budgets are shared across all
candidate roots: depth 16, 1,024 references, 64 MiB of JSON metadata and 64 GiB each
of encoded and decoded content. Per-document and per-layer limits also apply.
These rules support the tested Docker-save forms, not every possible OCI layout.

From the matching source checkout, acceptance uses the saved tags in **both**
the primary and restore Compose projects, with `up --no-build --pull never`
and `run --pull never` (the bundled Compose has no build definitions), and
checks actual container image IDs/tags including the migrator. Saved config IDs
and OCI descriptor IDs are authenticated against the archive. If a receiving
containerd store translates a classic archive into a new descriptor, a read-only
export must bind that descriptor to the original config and validated layers
before its host ID is accepted; running containers must use that exact verified
host ID. The producer IDs in the manifest remain unchanged. It never overwrites
`vardum-api:smoke` or `vardum-gateway:smoke`. Dokploy routing probes obtain the
verified host ID of the saved `gateway-dokploy` role; candidate smoke performs no
later application image build. Standard routing and the application TLS matrix
also reuse the verified running image IDs. The existing source-build smoke mode
remains available by omitting `SMOKE_SERVER_CANDIDATE`.

Acceptance checks readiness, the limited runtime database role and unscoped RLS,
including forced tenant RLS for the private known-usage inventory and SELECT/INSERT
without effective table/column UPDATE or table DELETE grants on immutable manual
check records. The inventory policies must have the exact workspace USING and
WITH CHECK predicates, PUBLIC roles and PERMISSIVE/ALL properties. It also checks
deployed AVIF encoding/decoding, authorization/private delivery, public client
login/pull/push/frozen restore/logout, every advertised MCP tool, onboarding,
resource budgets, worker heartbeat expiry, PostgreSQL/RustFS outages, queued
ingest recovery, corrupt/occupied-destination backup rejection and clean-stack
restore with signing/session/key/version-history preservation. Disposable projects
use separate ports and are removed by the production-smoke cleanup trap.

The restore drill also checks two unfinalized uploads with non-null
`expected_checksum` bindings. Before restored application startup it compares
their exact rows, reservations, audits and original object bytes. Same-ID replay
must preserve the checksum and deadline without another asset/version or creation
audit; changed-checksum replay must return 409 without changing that state.
Unchanged bytes must become ready, while same-size altered bytes must fail the
worker's checksum check without publishing and remain nonretryable. These API
checks run with the public compatibility clients; they do not establish new CLI
journal/resume behavior. Final VARD-6 acceptance still requires a new clean bundle
from the reviewed source and full unchanged-artifact acceptance of this drill.

Certification is bounded to the tested **linux/amd64, PostgreSQL 17, bundled
RustFS** stack. It does not establish external storage-provider support, other
architectures, provider-specific restore, production capacity or SLOs. Dokploy
Compose/routing examples are bundled for review but require separate deployment
acceptance. No candidate preparation constitutes deployment approval.

For a separately authorized installation, copy `.env.production.example` to
`.env.production`, replace its secrets/URLs/storage settings and use the bundle's
Compose file. After `load`, startup uses `docker compose --env-file .env.production
-f compose.production.yml up -d --no-build --pull never --wait`. With bundled
RustFS, first run `up -d --no-build --pull never --wait rustfs` with `--profile rustfs`,
then `run --rm --pull never rustfs-init` with that profile, before application
startup without the profile. Configure the API's public storage endpoint and
provider CORS for the installation, and retain the same archive for startup and
restore. These instructions do not
authorize deployment during preparation.

## Upgrade and rollback review

Back up database, all objects and deployment secrets together, and verify a
restore before upgrading. Preserve `BETTER_AUTH_SECRET`, `TRANSFORM_SECRET`,
canonical server URL, workspace slugs and historical source keys: old sessions
and signed/frozen URLs depend on these. Keep backup bundles encrypted off-host;
secrets are a separate restricted record. Derived cache, imported source objects,
provider version history, logs and backups need retention outside original-byte
workspace quotas.

Stop old API and **all old workers** before migrations or restoring; block writes
and delivery while switching. Apply migrations with the bundled migrator and
start only matching API/worker/gateway images. Review the existing runtime-role,
visibility and folder-rule precautions in [operations](operations.md), then:

| Migration | Review |
| --- | --- |
| `0011_asset_ingest_recovery.sql` | Durable ingest intent/recovery; preserve uploaded objects and jobs, and stop older workers before switching. |
| `0012_worker_heartbeat.sql` | Additive worker liveness; old heartbeat rows are excluded from backups and cannot prove a restored worker is alive. |
| `0013_upload_cleanup.sql` | Pending-upload deadlines/cleanup; review workspace storage and unfinished-upload budgets before deployment. |
| `0014_upload_cleanup_fairness.sql` | Nullable cleanup scheduling timestamps and indexes; retain additive fields/indexes during image rollback. |
| `0015_upload_request_checksum.sql` | Nullable `asset_version.expected_checksum` plus a lowercase 64-hex constraint; historical rows remain null. New upload requests bind resumable attempts to their source SHA-256. Preserve the field and pending journals during retry/restore. |
| `0016_known_usage_inventory.sql` | Private `known_usage` and `known_usage_check` tables with forced workspace RLS. Run the matching migrator to grant consumer CRUD and check SELECT/INSERT while revoking direct check UPDATE/DELETE. Preserve declared source identities and manual reports in backup/restore; asset/Vard deletion retains them, while authorized inventory/workspace deletion cascades reports. |

The current worker independently reconciles interrupted ingest at startup,
including when an existing recovery queue job delays fresh scheduling. Stop all
old workers before applying migrations or restoring and start only the matching
worker image. Keep `.vardum.push.pending.json` after partial uploads/imports;
retry must preserve ready versions and mapping progress. Source/API integration
checks do not prove this behavior on the final portable artifact.

Review all environment defaults and workspace settings before starting: storage
and pending limits, pending expiry, API/delivery admission, transform concurrency,
queue/output/time limits, container CPU/memory, organization creation, SMTP and
monitoring token. Lower quotas block new writes without deleting retained ready
versions; old pending uploads can expire automatically. Settings and queued work
must be treated as data in backup/restore.

Prefer a forward fix. Retaining additive schema permits an older compatible
image to start, but does not preserve new recovery, liveness or cleanup behavior.
Never restore visibility-unaware delivery against private data or a rule-unaware
API against active folder rules. Freeze client updates and review the loss of
post-backup changes before any database/object restore. Never run old and new
workers against a restored destination or delete volumes as a rollback shortcut.

## Validation workflow and npm trust

`Server candidate validation` is **workflow_dispatch-only**. Normal CI retains
its existing source-build acceptance and runs the candidate verifier/projection
fixtures through `scripts/*.test.mjs`; it does not automatically trigger portable
image preparation/export on a pull request. Choose the final reviewed source
boundary before explicitly dispatching full portable validation.

The manual workflow has only `contents: read`, runs frozen install/audit and
regression checks, prepares the bundle once, accepts its saved images with the
fixed public compatibility clients, and checks the unchanged bundle afterward.
It has no npm publishing, OIDC permission, tag/release creation or deployment.
Full archives and scanner database stay runner-local and are discarded when that
job ends; use local preparation when those full exports must be retained.

Only these three named files from a **separate sanitized projection directory**
are retained for 30 days: `candidate-summary.json`, `acceptance-summary.json` and
`checksums.txt`. The projection reconstructs approved identity, versions, findings,
status and count fields, and hashes selected local reports. It excludes raw image
configs/environment, invocation arguments, arbitrary errors/logs/URLs, TARs and
scanner databases. File extensions are not a sanitization policy. Missing,
malformed or unsafe selected report inputs are recorded with fixed status labels;
the projection never copies their error text. These reports explicitly retain
`offlineReplay: false` and `releaseCertification: pending`.

Final clean artifact acceptance, external-provider/deployment acceptance and
security disposition remain VARD-6 gates. The existing runtime ledger's bundled
OpenSSL 3.5.8 / CVE-2026-35189 finding is not fixed by a passing ordinary TLS
matrix. Deployment-specific acceptance of that LOW finding does not certify an
unrestricted public server release; fresh vendor review remains required before
promotion.

The historical npm release at `v0.6.0` was published and verified under
`frgtn-dot-dev`; [the npm procedure](npm-release.md) preserves that evidence.
The current repository owner is `f-tuma`. All three corresponding trusted
publishers were verified by actual OIDC publication on October 11 (VARD-45),
with package 2FA preserved; see [current npm evidence](npm-release.md#october-11-publication-evidence).
Server artifact preparation only reads published clients and does not depend on
future npm publishing trust.

Action pins were checked against the official repositories: [checkout](https://github.com/actions/checkout),
[setup-node](https://github.com/actions/setup-node), [upload-artifact](https://github.com/actions/upload-artifact)
and [pnpm action-setup](https://github.com/pnpm/action-setup). Keep full commit pins
and the repository's seven-day dependency age/trust policy and moderate audit gate.
