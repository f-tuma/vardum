# npm releases

## Current status

Reviewed **2026-10-10** (planner project **frgtn.VARD**, VARD-75; public baseline VARD-20).
The available public versions are [CLI **0.6.0**](https://registry.npmjs.org/@vardum%2Fcli/0.6.0),
[MCP **0.2.0**](https://registry.npmjs.org/@vardum%2Fmcp/0.2.0) and
[shared **0.2.0**](https://registry.npmjs.org/@vardum%2Fshared/0.2.0).
Their immutable archives were rechecked against registry SHA-512 values.
Independent installs and the disposable Linux first-project flow are verified;
CLI 0.6.0 uses schema **2** frozen snapshots.

CLI **0.7.0**, shared **0.3.0** and MCP **0.3.0** are retained,
unpublished candidates from immutable source
`20495967d0d256b12247720f8bbedbce568b54e1` (VARD-68).
[Origin run 38065972599, attempt 1](https://github.com/f-tuma/vardum/actions/runs/38065972599)
validated their archives and independent download/installs, with **publish skipped**.
VARD-75 adds a separate controller path to validate those exact bytes; a merged
controller or a passing validation does not publish them. This VARD-68 CLI retains
schema **2** frozen snapshots. VARD-14's distinct
[unmerged schema **3** candidate in PR #13](https://github.com/f-tuma/vardum/pull/13)
is not contained in these retained archives.
VARD-6's `server-v0.7` is provisional, with clean artifact acceptance and VARD-53's
residual OS/native assessment still open. See [current readiness status](production-readiness-2026-09-20.md#current-status).
Passing source tests does not make those candidates publicly available or ready
for production.

The current private source repository is `f-tuma/vardum`. npm-owner confirmation
of its package-side trusted publishers remains VARD-45. The successful
[validation-only run](https://github.com/f-tuma/vardum/actions/runs/37129022120)
validated and downloaded archives, with **publish skipped**; it does not prove
current publisher identity or a new npm publication.

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

| Component | Published baseline | Compatibility notes |
| --- | --- | --- |
| `@vardum/cli` | 0.6.0, Node ≥22 | Matching API contract; minimum CLI for schema 2 frozen snapshots |
| `@vardum/mcp` | 0.2.0, Node ≥22 | Matching API contract; 11 asset/Vard tools using a workspace key |
| `@vardum/shared` | 0.2.0 | CLI/MCP archives require `^0.2.0`; resolved automatically by npm |
| API / gateway / worker | Historical server source at tag `v0.6.0` | The September client baseline used migrations through `0010_vard_folder_rules.sql`; newer merged source requires its own migrations and release acceptance |
| Existing CLI ≤0.5.0 / MCP 0.1.0 | Not supported for this workflow | Upgrade; these artifacts are not a fallback for frozen snapshots |

The API has no independent published npm version. This table identifies the
historical tested client/server contract, not a currently certified deployment
artifact or a guarantee for arbitrary server combinations. Merged operational
source adds migrations through `0014_upload_cleanup_fairness.sql`; it is distinct
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

## Prepare and test

Use Node 22.23.3 and the root `packageManager` version of pnpm (12.4.2). From a clean
checkout of the intended release commit:

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
for version tag pushes and manual dispatch. Publication requires the matching CLI
version tag (`v0.6.0` for the September batch), including manual retries from that
tag with the original tested archives. Its validation job runs the checks above
plus database integrations, then uploads the
exact tested archives. A separate publish job
downloads that artifact, checks its SHA-512 manifest, and uses the `npm`
environment and npm trusted publishing (OIDC). No `NPM_TOKEN` secret is needed.
Release runs are serialized and cannot cancel an in-progress publication.

For a safe hosted check of this release path, manually dispatch `Release` from the
candidate branch with `validation_only=true`. This explicit mode runs the same
validation and preserves its tested archives, then downloads them in a separate
read-only job to verify manifests, SHA-512 hashes and independent CLI/MCP installs.
It cannot enter the `npm` environment or publish packages or a GitHub release, even
when dispatched from a matching tag. Manual dispatch defaults to `validation_only=true` and `release_mode=source`.
Publishing source archives requires explicitly setting `validation_only=false`
and selecting the matching CLI tag. No pull request event uploads release artifacts.
A validation run checks new candidate archives; it does not prove their bytes match
already published versions and must not be used to retry publication of those versions.

CI and release jobs pin the GitHub-hosted Ubuntu 24.04 image to keep their native
PostgreSQL baseline stable. The pinned JavaScript actions use their bundled Node 24
runtime; application commands use the separately selected Node 22.23.3. Updating
these pins still requires a successful hosted CI run and a validation-only archive
round trip; local package checks do not verify the hosted runner or action runtime.

### Validate a retained candidate without rebuilding it

Select `release_mode=retained`, `retained_candidate=vard68-upload-import-v1`, and
`validation_only=true` on the controller branch. The retained job has only
`contents: read` and `actions: read`. It has no npm environment, OIDC permission,
tag write or publication step. Setting `validation_only=false` fails its policy
check before download or installation. Fresh-source jobs and their publish job
are excluded from this mode.

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

### Retained publication remains disabled

VARD-75 stays open until hosted retained validation succeeds and the npm owner and
GitHub environment approvals are resolved. `prepare-tag`, `publish`,
`verify-registry` and `github-release` helpers are gated by the descriptor's
`publication.enabled=false`; none is wired to a retained publication job.
No tag, release, npm package, publisher connection or deployment policy is changed
by this delivery.

The future controller must be the reviewed **`refs/heads/main`** implementation of
`.github/workflows/release.yml`; its source SHA must remain distinct from the
immutable artifact source SHA. The existing `npm` environment's tag-only rule
requires a separately reviewed exception for that exact controller branch, plus
VARD-45 owner confirmation of all three package publishers. GitHub checks the
[branch/tag deployment policy against the workflow run's ref](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).
A source tag alone cannot make a main controller satisfy a tag-only rule.
The intended npm identity remains `f-tuma/vardum`, `release.yml`, environment
`npm`; [npm's trust checks](https://docs.npmjs.com/trusted-publishers/) are independent
of artifact validation and cannot be proven by a read-only run.

After those gates, a newly reviewed publication change may prepare or verify
`v0.7.0` at the immutable candidate commit using the built-in `GITHUB_TOKEN`.
[GitHub documents that its token's tag push does not trigger another workflow](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow#triggering-a-workflow-from-a-workflow),
so the old candidate's tag workflow must not be accidentally invoked using a PAT.
Never substitute a fake ref/OIDC claim, a static npm token, a different publisher,
or public provenance for the private source repository. Provenance stays disabled
for private source, and ordinary source publication keeps its matching-tag policy.

### One-time npm setup

The September 20 release exercised the historical publisher identity below
(VARD-40). For the current private repository, an npm owner must inspect each
package (`@vardum/shared`, `@vardum/cli`, `@vardum/mcp`) in npm Settings → Trusted
publishing and confirm the intended identity. That confirmation is still open
under VARD-45; these are not three currently verified connections.

| Field | Historical successful identity | Intended current identity, unverified |
| --- | --- | --- |
| Organization or user | `frgtn-dot-dev` | `f-tuma` |
| Repository | `vardum` | `vardum` |
| Workflow filename | `release.yml` | `release.yml` |
| Environment | `npm` | `npm` |
| Allowed actions | Allow direct `npm publish` | Allow direct `npm publish` |

The GitHub `npm` environment must restrict deployment to tags matching `v*`;
configure any required reviewers there. npm validates trust when the workflow
actually publishes. Saving the form or passing validation-only archive checks
does not test that trust.
The workflow pins Node 22.23.3 and npm 12.0.2, which support trusted publishing.
See the [npm trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/).

The source repository is currently private. npm provenance is therefore disabled
for this repository. OIDC publication worked for the historical identity;
current publisher acceptance remains unverified. The workflow enables provenance
automatically for a public repository.

Repository documentation links require access to the private source repository.
The existing public archives retain `frgtn-dot-dev/vardum` metadata and README
links. Editing current source documentation to use `f-tuma/vardum` neither changes
those immutable archives nor makes the source public; package documentation and
metadata changes need a future versioned release.

### Trigger and verify

After the release commit has passed CI and the three npm publishers are configured,
push the matching version tag. A successful run publishes shared → CLI → MCP,
checks independent installs from npm, and creates a GitHub release with the
archives and integrity manifest. Manual retries must select the same tag.
The source tree, `release.json`, workflow run and GitHub release identify the
published build. Update client availability guidance only after verifying the
new public versions, not after source validation alone.

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
