# npm releases

## Current status

Reviewed **2026-10-03** (planner project **frgtn.VARD**, VARD-20).
The available public versions are [CLI **0.6.0**](https://registry.npmjs.org/@vardum%2Fcli/0.6.0),
[MCP **0.2.0**](https://registry.npmjs.org/@vardum%2Fmcp/0.2.0) and
[shared **0.2.0**](https://registry.npmjs.org/@vardum%2Fshared/0.2.0).
Their immutable archives were rechecked against registry SHA-512 values.
Independent installs and the disposable Linux first-project flow are verified;
CLI 0.6.0 uses schema **2** frozen snapshots.

CLI **0.7.0**, shared **0.3.0**, MCP **0.3.0** and schema **3** belong to VARD-14's
[unmerged, unpublished draft PR #13](https://github.com/f-tuma/vardum/pull/13).
VARD-6's `server-v0.7` is provisional, with runtime hardening and VARD-53's residual
OS/native assessment still open. See [current readiness status](production-readiness-2026-09-20.md#current-status).
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
when dispatched from a matching tag. The default is `false`; branch dispatches with
that default fail the tag check. No pull request event uploads release artifacts.
A validation run checks new candidate archives; it does not prove their bytes match
already published versions and must not be used to retry publication of those versions.

CI and release jobs pin the GitHub-hosted Ubuntu 24.04 image to keep their native
PostgreSQL baseline stable. The pinned JavaScript actions use their bundled Node 24
runtime; application commands use the separately selected Node 22.23.3. Updating
these pins still requires a successful hosted CI run and a validation-only archive
round trip; local package checks do not verify the hosted runner or action runtime.

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

It preflights all three versions before writing anything, publishes the tested
tarballs in shared → CLI → MCP order, and refuses an existing version whose
integrity differs. If a batch is interrupted, rerun with the same archives:
identical published versions are skipped; conflicting versions require a new
version and candidate. `verify-registry` checks all registry integrity values
and independently installs both packages from public npm, without the fixture.
If the registry has not propagated yet, rerun verification; do not overwrite or
unpublish versions to make it pass.

After a future publication, update release status, compatibility and client
availability guidance. Check a clean install from the public registry and record
the release commit/tag. Keep automated integration evidence separate from a new
human first-use session. Publication alone does not complete server/runtime,
provider, backup/restore, capacity or product acceptance in the readiness audit.
