# npm releases

## Current status

Published and independently verified **2026-10-11** (frgtn.VARD, VARD-77):
[CLI **0.8.1**](https://www.npmjs.com/package/@vardum/cli/v/0.8.1),
[MCP **0.4.1**](https://www.npmjs.com/package/@vardum/mcp/v/0.4.1) and
[shared **0.4.1**](https://www.npmjs.com/package/@vardum/shared/v/0.4.1).
Actual registry tarballs match the final tag run's tested archive bytes and
SHA-512 values; independent public CLI/MCP installs resolve shared 0.4.1
transitively, and all four GitHub release assets match that batch. See
[0.8.1 release notes and publication evidence](client-release-0.8.1.md#publication-evidence).

Published CLI 0.8.0 / MCP and shared 0.4.0 remain immutable, with their
[original publication evidence](#october-11-client-08-publication-evidence)
and [feature notes](client-release-0.8.md) preserved.

Published CLI 0.7.0 / MCP and shared 0.3.0 remain immutable, with their
[October 11 publication evidence](#october-11-publication-evidence) preserved below.
Their verified public CLI/MCP installs resolved shared 0.3.0 transitively and
passed CLI init dry-run, creation, repeat and conflict checks.

This release retains **schema 2** frozen snapshots, with minimum CLI **0.6.0**.
The September CLI 0.6.0 / MCP/shared 0.2.0 release remains the explicitly selected
server compatibility baseline and first-project fixture. Schema **3** remains in
VARD-14's separate [unmerged draft PR #13](https://github.com/f-tuma/vardum/pull/13);
its provisional version numbers are not reservations.
VARD-6's `server-v0.7` is provisional, with clean artifact acceptance and VARD-53's
residual OS/native assessment still open. See [current readiness status](production-readiness-2026-09-20.md#current-status).
Passing source tests does not release the server or schema 3 candidates or
complete their production acceptance.

The private source repository is `f-tuma/vardum`. All three package-side OIDC
publishers are verified for that repository, `release.yml`, environment `npm`,
with direct `npm publish` allowed and dist-tag management disabled. Their old
`frgtn-dot-dev` connections were replaced with owner approval and security-key
verification; package 2FA settings were preserved. Actual Actions publication,
not a browser login or validation-only run, completes VARD-45.

## Verified public onboarding patch (VARD-77)

CLI **0.8.1**, MCP **0.4.1** and shared **0.4.1** are published and independently
verified. Their packaged READMEs contain standalone setup, public npm version
links and backend/retention contracts. The exact archive check rejects
private/relative setup links and mismatched installation pins. Schema 2, existing
client behavior, historical retained batches and the 0.6/0.2/0.2 server
compatibility fixture are preserved.

[PR #43](https://github.com/f-tuma/vardum/pull/43) passed independent review,
[PR CI](https://github.com/f-tuma/vardum/actions/runs/38161671539) and the
[branch validation-only run](https://github.com/f-tuma/vardum/actions/runs/38161676456),
whose publish job was skipped. Final tag `v0.8.1` identifies source
`2e5c62a1da587d1dfc1f8f7508142715971c1075`, tree
`99b42aebdbd657de873f343e3605802af87f31dc`. Its
[tag run 38162972385](https://github.com/f-tuma/vardum/actions/runs/38162972385)
validated and published its own separate batch. Attempt 1 published all three
packages, then failed the independent public CLI install with npm `ETARGET`
during propagation. Only failed jobs were rerun: attempt **2** reused original
artifact **11710699527**, skipped identical published bytes and passed registry
verification, independent installs and GitHub release creation. The downloaded
original npm ZIP is **58,768 bytes**, SHA-256
`a2ec0a844b656ff363f43c199124578fdfa1c58b01d7be3e6eba957dfcbdf5e8`.

Active guides and the separately reviewed gateway Copy setup constant now pin
verified CLI **0.8.1**; MCP guidance pins **0.4.1**. Production Copy setup needs
the matching gateway deployment. Candidate package manifests do not promote
that constant. [Detailed publication evidence](client-release-0.8.1.md#publication-evidence)
records the manifest, package integrities, public installs, all four release
assets and sanitized runtime evidence limits. Do not repack these published
versions or move the tag. Recover a failed publisher only through failed jobs
of the original tag run; bounded install-propagation retry work is tracked
separately in VARD-96.

## October 11 client 0.8 publication evidence

[Release `v0.8.0`](https://github.com/f-tuma/vardum/releases/tag/v0.8.0) identifies
source `a5b978432556518d895016aa398ff915a9b97224`, tree
`a9ea341bcf5e878cc619f35a2dfdcb21bc4a7b9b`. Its final
[tag run](https://github.com/f-tuma/vardum/actions/runs/38127269600), verified
attempt **1**, published the original tested artifact
**11698490002** using source mode and OIDC. Actual registry bytes,
independent public CLI/MCP installs and all four release assets were compared
with that run's tested batch. Archive ZIP sizes/hashes and sanitized runtime
evidence are recorded in [the 0.8 evidence table](client-release-0.8.md#publication-evidence).

The [branch validation-only run](https://github.com/f-tuma/vardum/actions/runs/38126166933)
and final tag run are distinct artifact batches. The publisher downloaded the
exact tested archives from its own tag run. Post-publication documentation
commits do not change the immutable tag, source tree or archives. Do not repack
these published versions or route them through the retained 0.7 controller.

Production advertises `folderUploadResume: 1`, `folderVardImport: 1` and
`vardEditRevision: 1` at this checkpoint. Verify the intended instance before
upgrading clients. Publication and advertised capabilities do not certify a
released server/runtime artifact or complete broader production acceptance.
The client batch keeps schema **2**, minimum CLI **0.6.0**, and the unchanged
0.6/0.2/0.2 compatibility fixture. At the 0.8.0 publication checkpoint, active
onboarding pinned CLI 0.8.0 and MCP 0.4.0; current pins are listed above. Copy setup
uses a separately reviewed published-version constant in the gateway, independent
of candidate package manifests.

## October 11 publication evidence

- [Release `v0.7.0`](https://github.com/f-tuma/vardum/releases/tag/v0.7.0) and its tag
  identify immutable source `20495967d0d256b12247720f8bbedbce568b54e1`, tree
  `3405984fa763ce78394c69cbc66e2c987501671d`.
- [Origin run 38065972599, attempt 1](https://github.com/f-tuma/vardum/actions/runs/38065972599),
  artifact **11674484014**, validated the original four files; its publish job
  remains **skipped**. That run was never rerun and its archives were not repacked.
- [Publication run 38119764030](https://github.com/f-tuma/vardum/actions/runs/38119764030)
  used main controller `89371efa56a79091c5e5ed5609edd72252860731` and retained mode.
  Attempt 1 published all three packages through OIDC, then hit npm `ETARGET`
  during public installation while version lists propagated. Failed-job retry,
  attempt **2**, skipped identical published bytes and completed successfully.
- Actual registry tarballs and all four downloaded GitHub assets were independently
  compared with the original archives/manifest. Public CLI and MCP installations
  passed locally and in the successful hosted job.
- Sanitized publication artifact **11694778291** (1,308 bytes), ZIP SHA-256
  `51d91fbd54918d82c17b9ed42eccf467c1fbf62b0d38ea387649fc5c20230fa7`, contains
  only `retained-publication.json`, `retained-publication.txt` and `checksums.txt`.
  Checksums, source/controller identities and all nine successful outcomes were verified.

Source integration and documentation edits after publication do not change those
immutable npm archives. Never publish a new pack under these existing versions.
This publication does not certify a server artifact or complete the Musubi pilot.

## September 20 publication evidence

CLI 0.6.0, MCP 0.2.0 and shared 0.2.0 were published and verified on 2026-09-20.
Their registry SHA-512 values matched the tested archives; CLI and MCP each
installed independently, resolving shared transitively.

- Release: [`v0.6.0`](https://github.com/frgtn-dot-dev/vardum/releases/tag/v0.6.0)
- Source commit: `e8d17667933601ea7055bda8cabee26ac510e40f`
- [Successful release workflow](https://github.com/frgtn-dot-dev/vardum/actions/runs/35520781363)
- The release assets contain the three published archives and `release.json`.

The initial post-publication check ran before npm had propagated the new versions.
Verification then passed locally and in a retry of the publish job using the same
archives; already-published matching versions were skipped. Future verification
waits up to 18 checks, 10 seconds apart, for missing versions. Registry errors
and conflicting integrity values fail immediately.

Older CLI 0.5.0 / MCP 0.1.0 have unsupported `workspace:^` dependencies and remain
immutable. Install the published compatible versions below.

The separate [server candidate procedure](server-release.md) validates the new
server with the explicit public compatibility versions through migrations 0011–0015.
The npm release workflow does not prepare or publish that server artifact.

## Compatibility

### September server compatibility baseline

| Component | Published baseline | Compatibility notes |
| --- | --- | --- |
| `@vardum/cli` | 0.6.0, Node ≥22 | Matching API contract; minimum CLI for schema 2 frozen snapshots |
| `@vardum/mcp` | 0.2.0, Node ≥22 | Matching API contract; 11 asset/Vard tools using a workspace key |
| `@vardum/shared` | 0.2.0 | CLI/MCP archives require `^0.2.0`; resolved automatically by npm |
| API / gateway / worker | Historical server source at tag `v0.6.0` | The September client baseline used migrations through `0010_vard_folder_rules.sql`; newer merged source requires its own migrations and release acceptance |
| Existing CLI ≤0.5.0 / MCP 0.1.0 | Not supported for this workflow | Upgrade; these artifacts are not a fallback for frozen snapshots |

The API has no independent published npm version. This table identifies the
historical tested client/server contract, not a currently certified deployment
artifact or a guarantee for arbitrary server combinations. Client 0.7 requires
matching operational source with migrations through `0015_upload_request_checksum.sql`; it is distinct
from the September release and from the unmerged schema 3 candidate. Follow the
[operations upgrade instructions](operations.md) and complete the server/runtime
release gates before deployment. Align server contracts and migrations before
rolling out clients.
Keep the locked files, source versions, keys and signing configuration needed
for historical builds; see [snapshot limitations](../apps/cli/README.md#reproducible-asset-consumption).

MCP 0.2.0 changes: browser-only administration tools are removed; use the web app.
`list_assets` returns a page object with `assets` and `nextCursor`.
`replace_vard_items` uses nullable `versionId` to pin and rejects `pinned`.
Asset/Vard keys do not receive administrative permissions.

### Published client 0.7

| Component | Published version | Compatibility notes |
| --- | --- | --- |
| `@vardum/cli` | 0.7.0, Node ≥22 | Schema 2 snapshots; resumable uploads require `folderUploadResume: 1`; Vard imports also require `folderVardImport: 1` |
| `@vardum/mcp` | 0.3.0, Node ≥22 | Existing 11 asset/Vard tools; shared dependency and repository metadata updated |
| `@vardum/shared` | 0.3.0 | Media naming exports; CLI/MCP archives require `^0.3.0` |
| Matching backend | Migrations through `0015_upload_request_checksum.sql` | Verify deployed capabilities before using upload/import |

Source dependencies remain `workspace:^`; pinned pnpm rewrites them to `^0.3.0`
in these archives. The minimum schema 2 consumption CLI remains **0.6.0**.
See [release notes and upgrade order](client-release-0.7.md).

### Published client 0.8.1

| Component | Published version | Compatibility notes |
| --- | --- | --- |
| `@vardum/cli` | 0.8.1, Node ≥22 | Standalone package setup; retains complete folder plan and all-file library report, schema 2, upload resume and Vard import contracts |
| `@vardum/mcp` | 0.4.1, Node ≥22 | Standalone package setup; same 11 tools and guarded editor routes with `vardEditRevision: 1` for editable reads and update/replacement/delete |
| `@vardum/shared` | 0.4.1 | Guarded-editor definition/input wire types; CLI/MCP archives require `^0.4.1` |
| Matching backend | Migrations through `0015_upload_request_checksum.sql` | Library mutations need `folderUploadResume: 1`; imports also need `folderVardImport: 1`; guarded MCP reads/writes need `vardEditRevision: 1` |

Source dependencies stay `workspace:^`; pinned pnpm rewrites them to `^0.4.1`
in these published archives. Independent public CLI and MCP installs each resolved
shared 0.4.1 transitively. See [0.8.1 evidence and upgrade order](client-release-0.8.1.md).
The existing schema 2 lock requires no migration. Guarded editor source introduces
no database migration beyond the upload/import baseline.

## Prepare and test

Use Node 22.23.3 and the root `packageManager` version of pnpm (12.4.2). From a clean
checkout of a future release commit with new, unpublished version numbers:

```sh
pnpm install --frozen-lockfile
pnpm audit --audit-level=moderate
pnpm test
pnpm typecheck
pnpm build
node scripts/release-packages.mjs pack artifacts/npm
bash scripts/smoke-publish.sh artifacts/npm
SMOKE_RELEASE_DIR="$PWD/artifacts/npm" bash scripts/smoke-production.sh
node scripts/release-packages.mjs preflight artifacts/npm
```

The output directory must be empty. It contains three `.tgz` archives and
`release.json` with their versions and SHA-512 integrity values. Keep this exact
directory for review and publication; do not repack after testing. Source edits
require a fresh candidate directory and another validation run. A candidate built
from changed source can differ from published archives even if its package version
has not changed. Existing npm versions cannot receive those different bytes;
prepare new versions for a new publication.

Packing checks ordinary semver workspace dependencies, runtime entries, version
numbers, the Node engine requirement, archive contents and hashes. The prepack
guard rejects npm/raw-source publication; use the pinned pnpm to produce archives.
The installation test serves only the candidate `@vardum` scope on a loopback
registry and installs CLI and MCP into separate empty npm projects by name.
Shared must resolve transitively. Third-party dependencies come from npmjs.
This local registry is a fixture, not a public release.

The production smoke uses those installed binaries against disposable PostgreSQL,
RustFS, API, worker and gateway services. It exercises the CLI login callback
(simulated browser grant), credential permissions, private pull/push, pinned and
transformed outputs, old-lock frozen restoration after Vard deletion and logout.
It also calls every advertised MCP tool, reads resources and checks read-key and
cross-workspace denials. A real browser authorization screen remains a separate
UI check. The auth/RLS/private-delivery database integrations run in CI/release too.

## Publish

Publication is a separate, deliberate action. The GitHub `Release` workflow runs
for version tag pushes and manual dispatch. Future source publication requires
the matching new CLI version tag. Its `validate` job runs the checks above plus
database integrations, packs a new batch and uploads its exact tested archives.
The separate `publish` job downloads **that same run's** artifact, checks its
SHA-512 manifest and uses the `npm` environment and trusted publishing (OIDC).
It does not pack source. No `NPM_TOKEN` secret is needed. Release runs are
serialized and cannot cancel an in-progress publication.

For a safe hosted check of this release path, manually dispatch `Release` from the
candidate branch with `validation_only=true`. This explicit mode runs the same
validation and preserves its tested archives, then downloads them in a separate
read-only job to verify manifests, SHA-512 hashes and independent CLI/MCP installs.
It cannot enter the `npm` environment or publish packages or a GitHub release, even
when dispatched from a matching tag. Manual dispatch defaults to `validation_only=true` and `release_mode=source`.
Publishing source archives requires explicitly setting `validation_only=false`
and selecting the matching CLI tag. No pull request event uploads release artifacts.
A branch validation-only run and the later matching-tag publication run are
**distinct tested artifact batches**. The final tag run packs and tests its own
archives; its publisher uses only that run's downloaded batch. Branch validation
does not authorize substituting its archives into a later run and does not prove
matching bytes for already-published versions.

If the final source publication or registry verification fails, preserve the
original run and rerun **only its failed jobs**:

```sh
gh run rerun ORIGINAL_TAG_RUN_ID --repo f-tuma/vardum --failed
```

This reuses the successful original `validate` job's artifact for publication.
A new workflow dispatch or full run rerun executes validation and packs a new
batch, even at the same commit; neither is a recovery path for an interrupted
immutable publication. If the original validation artifact is missing/expired,
stop and review recovery before any further publication. Preflight skips only
byte-identical existing versions and refuses conflicts. Preserve the original
run ID, artifact ID, manifest and tested hashes in the release evidence.

CI and release jobs pin the GitHub-hosted Ubuntu 24.04 image to keep their native
PostgreSQL baseline stable. The pinned JavaScript actions use their bundled Node 24
runtime; application commands use the separately selected Node 22.23.3. Updating
these pins still requires a successful hosted CI run and a validation-only archive
round trip; local package checks do not verify the hosted runner or action runtime.

### Validate a retained candidate without rebuilding it

Select `release_mode=retained`, `retained_candidate=vard68-upload-import-v1`, and
`validation_only=true` on the controller branch. The retained job has only
`contents: read` and `actions: read`. It has no npm environment, OIDC permission,
tag write or publication step. Setting `validation_only=false` requests the
separate publication path described below and requires the reviewed main
controller. Fresh-source jobs and their publish job are excluded from retained mode.

The reviewed descriptor in
[`scripts/retained-release-contract.mjs`](../scripts/retained-release-contract.mjs)
selects source commit `20495967d0d256b12247720f8bbedbce568b54e1`, tree
`3405984fa763ce78394c69cbc66e2c987501671d`, repository ID `1342641877`, owner ID
`261622887`, workflow ID `341146915`, origin run `38065972599` attempt **1**, and
artifact `11674484014`. These values cannot be replaced by workflow inputs.
The artifact expires **2026-11-09T16:16:23Z**; expiry or missing origin metadata
fails validation and requires a newly reviewed retention decision.

Before extracting or installing anything, the controller verifies repository and
workflow identity, immutable commit/tree, current and attempt-specific run success,
the exact `validate` and `validate-download` jobs, and skipped `publish`. The
Artifacts API has no attempt field: the verifier binds exact artifact metadata
and run membership to its creation within the successful `validate` job interval.
It verifies the **52,666-byte** ZIP SHA-256
`e119d2c87c683e2ce058251899c7c697bbd4d2e750dde8829c5dfabfa79ac590`, a strict set
of four regular basename entries, no duplicate/traversal/symlink entries, bounded
inflation and CRCs. The **713-byte** `release.json` SHA-256 is
`7af041283b7027a3f11e06dd500dedff01cf655aff7e311a49bf2cdb5b5a18ae`; all three
archive sizes and SHA-512 values are independently pinned in the descriptor.
A manifest's own integrity claims cannot replace those reviewed values.
GitHub authentication is used only for API requests and is never sent to the
signed blob-storage redirect.

The checker uses that explicit artifact contract rather than controller package
versions. CLI and MCP install separately by name from a loopback candidate
registry, resolve shared transitively and exercise executable permissions and
versions. The installed CLI then runs the existing upload/import contract against
the controller API, disposable PostgreSQL and the integration fixture's object
HTTP server via `VARDUM_TEST_CLI_PATH`. The controller builds only its shared API
test dependency; it never packs or rebuilds the retained archives. This is an
installed client/controller compatibility check, not a new server release or full
production-runtime acceptance.

The workflow uploads only the original `release.json` and three named tarballs,
plus a separate allowlisted `retained-summary.json`, `retained-summary.txt` and
`checksums.txt`. Reports distinguish the controller commit from the artifact source
commit and project only identities and check outcomes. Failed/skipped integration
stays failed/skipped in evidence; raw runtime files, logs, environment values and
signed URLs are never a fallback upload.

To check an already retained directory locally, without source packing:

```sh
node scripts/retained-release.mjs check vard68-upload-import-v1 /path/to/retained/npm
node scripts/retained-release.mjs smoke vard68-upload-import-v1 /path/to/retained/npm
PG_BINDIR=/path/to/postgresql/bin node scripts/retained-release.mjs integration vard68-upload-import-v1 /path/to/retained/npm
node scripts/retained-release.mjs preflight vard68-upload-import-v1 /path/to/retained/npm
```

The `download` command requires `GH_TOKEN` with repository contents/actions read
access and a new output directory. It queries the pinned origin and performs the
same verified ZIP download as hosted validation. `preflight` only reads npm: it
compares both registry integrity metadata and bounded downloads of actual tarball
bytes. Publication retries preflight the entire shared → CLI → MCP batch and skip
only byte-identical published versions. A conflict fails before any package write.
GitHub release retries also verify the source tag and every existing asset's actual
bytes before uploading any missing file; an existing release never silently skips
archive verification.

### Publish the retained candidate through Actions

The descriptor enables deliberate retained publication. VARD-75 was completed
by the October 11 publication above; the command below is a recovery path for
that same immutable batch, not a way to publish changed source. From the reviewed main controller:

```sh
gh workflow run release.yml --repo f-tuma/vardum --ref main \
  -f release_mode=retained -f retained_candidate=vard68-upload-import-v1 \
  -f validation_only=false
```

The separate `retained-publish` job requires successful retained validation,
manual retained dispatch from `refs/heads/main`, and explicit
`validation_only=false`. Every mutation helper independently requires the actual
`RELEASE_VALIDATION_ONLY=false` value, the reviewed repository/main controller,
and a controller SHA distinct from the immutable artifact source. Safe validation
still skips the entire publication job, including its `npm` environment and OIDC
permission. Its report records the configured flag separately from publication
being disabled for that validation run.

The existing `npm` environment's tag policy `v*` remains necessary for ordinary
source releases. Retained publication additionally requires the exact branch
`main`. That policy was added with owner approval and independently read back on October 11; the
tag rule and other protections were preserved.
[GitHub checks deployment policies against the workflow run's ref](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).
A source tag alone cannot make a main controller satisfy a tag-only rule.
For another repository, an enabled descriptor alone does not establish its external policy.

Actions uses npm trusted publishing directly. The intended npm identity is
`f-tuma/vardum`, workflow `release.yml`, environment `npm`, with direct
`npm publish` allowed. An npm browser session and static npm token are not needed
for a working OIDC connection. Archive validation cannot prove publisher trust:
the actual publish attempt must establish acceptance. If npm rejects it, retain
the same candidate and inspect the error before requesting owner login to correct
the affected publisher. Preserve 2FA and do not replace OIDC with a static token.
See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

The job uses Node 22.23.3 and npm 12.0.2, independently downloads the original
pinned artifact, checks its reviewed contract, and preflights all npm versions
and existing GitHub release assets before the first tag or npm write. Publication
runs shared → CLI → MCP without packing source. Byte-identical published versions
and assets permit retries; conflicts stop before further writes. An authentication
or transport failure can leave earlier packages published. Inspect recorded
outcomes and registry bytes, then rerun this same selection from main; never
repack or silently choose a new version to get past a failure.

The workflow prepares or verifies `v0.7.0` at the original candidate commit using
its built-in `GITHUB_TOKEN`.
[That token's tag write does not trigger another workflow](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow#triggering-a-workflow-from-a-workflow),
so do not push the historical candidate tag with a PAT or local Git credentials.
The publication report allowlists only identities, mode, configured enable flag
and exact step outcomes. Failed/skipped evidence cannot claim a successful release.
Private source provenance remains disabled; ordinary source publication retains
its matching-tag policy.

### One-time npm setup

The September 20 release exercised the historical publisher identity below
(VARD-40); the October 11 release verified the current identity (VARD-45). For
a future move, first attempt the authorized Actions publication. If npm
rejects publisher trust, an owner can inspect the affected packages
(`@vardum/shared`, `@vardum/cli`, `@vardum/mcp`) in npm Settings → Trusted
publishing and correct their connections. Do not assume a connection is broken
merely because the browser is logged out.

| Field | Historical successful identity | Current identity, verified October 11 |
| --- | --- | --- |
| Organization or user | `frgtn-dot-dev` | `f-tuma` |
| Repository | `vardum` | `vardum` |
| Workflow filename | `release.yml` | `release.yml` |
| Environment | `npm` | `npm` |
| Allowed actions | Allow direct `npm publish` | Allow direct `npm publish` |

The GitHub `npm` environment must restrict source release deployment to tags `v*`
and additionally allow the exact branch `main` for the reviewed retained controller. Keep
any configured reviewers and other protections. npm validates trust when the workflow
actually publishes. Saving the form or passing validation-only archive checks
does not test that trust.
The workflow pins Node 22.23.3 and npm 12.0.2, which support trusted publishing.
See the [npm trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/).

The source repository is currently private. npm provenance is therefore disabled
for this repository. OIDC publication worked for both the historical and current
identities. The workflow enables provenance automatically for a public repository.

Repository documentation links require access to the private source repository.
The September archives retain `frgtn-dot-dev/vardum` metadata and README links;
the October archives use `f-tuma/vardum`. Editing source documentation neither
changes immutable archives nor makes the source public. Further package edits
require separately tested new versions.

### Trigger and verify

For the published 0.7 batch, use the retained recovery path above. Do not push
its historical tag with local credentials or a PAT: the YAML at that source commit
predates the retained controller and would rebuild archives and upload raw reports.
Keep `v0.7.0` at its original source; use the reviewed main controller for retry.

For future source releases, use new versions, review the release commit and run
source validation-only checks on its candidate branch before the matching new CLI
tag. The final tag run creates a separate batch and publishes its own exact tested
archives. Recover a failed publisher only with `gh run rerun ORIGINAL_TAG_RUN_ID
--repo f-tuma/vardum --failed`; a fresh dispatch or full rerun repacks. Verify
actual registry bytes, independent public installs and all four GitHub release
assets before advertising the new version.

For published CLI 0.8.1/MCP 0.4.1, verify backend migration `0015` and all applicable
capabilities in the [upgrade order](client-release-0.8.1.md#upgrade-order).
The gateway uses an independently reviewed, verified-public-version constant for
Copy setup; deploy that gateway source to offer CLI 0.8.1. It does not derive this
pin from a candidate package manifest. Source documentation changes after publication
do not alter the immutable tag or packed READMEs. The existing
[0.7 release notes](client-release-0.7.md#upgrade-order) remain historical evidence.

The equivalent archive publication commands are:

```sh
node scripts/release-packages.mjs publish artifacts/npm
node scripts/release-packages.mjs verify-registry artifacts/npm
```

It preflights all three versions and actual registry tarball bytes before writing anything, publishes the tested
tarballs in shared → CLI → MCP order, and refuses an existing version whose
integrity differs. If a batch is interrupted, rerun with the same archives:
identical published versions are skipped; conflicting versions require a new
version and candidate. `verify-registry` checks all registry integrity values and actual archive bytes
and independently installs both packages from public npm, without the fixture.
If the registry has not propagated yet, rerun verification; do not overwrite or
unpublish versions to make it pass.

After a future publication, update release status, compatibility and client
availability guidance. Check a clean install from the public registry and record
the release commit/tag. Keep automated integration evidence separate from a new
human first-use session. Publication alone does not complete server/runtime,
provider, backup/restore, capacity or product acceptance in the readiness audit.
