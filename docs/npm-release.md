# npm releases

Status on 2026-09-20: **published and verified on npm** — CLI 0.6.0, MCP 0.2.0
and shared 0.2.0. Their registry SHA-512 values match the tested archives;
CLI and MCP each install independently, resolving shared transitively.

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
immutable. Install the new versions below.

## Compatibility

The VARD-14 source candidate is **unpublished**: CLI 0.7.0, shared 0.3.0 and
MCP 0.3.0. CLI 0.7.0 requires a server supporting the explicit
`delivery=version-id-v1` manifest contract for normal pull and schema 3 creation.
Its frozen reader also supports schema 2 unchanged; `migrate-lock` is an explicit
authenticated upgrade with byte verification. CLI 0.6.0 does not understand schema
3 and does not gain rename-safe delivery automatically. Server manifest defaults
remain compatible with published CLI 0.6.0/MCP 0.2.0. MCP 0.3.0 retains that default
contract; its new package version accounts for the shared 0.3.0 dependency in its
archive. All three candidates need a new tested archive set before any release;
never publish changed bytes under the already released versions. The first-project
example remains pinned to the published CLI 0.6.0. No publication or tag is implied
by these source versions.

| Component | Released version | Required counterpart |
| --- | --- | --- |
| `@vardum/cli` | 0.6.0, Node ≥22 | Matching server release; minimum CLI for schema 2 frozen snapshots |
| `@vardum/mcp` | 0.2.0, Node ≥22 | Matching server release; 11 asset/Vard tools using a workspace key |
| `@vardum/shared` | 0.2.0 | CLI/MCP archives require `^0.2.0`; resolved automatically by npm |
| API / gateway / worker | Server source at tag `v0.6.0` | Apply migrations through `0010_vard_folder_rules.sql` and follow runtime-role/visibility upgrade instructions |
| Existing CLI ≤0.5.0 / MCP 0.1.0 | Not supported for this workflow | Upgrade; these artifacts are not a fallback for frozen snapshots |

The API has no independent published npm version. This table describes the
tested release set, not a guarantee for arbitrary older/newer server combinations.
Deploy the matching server and migrations before rolling out these clients.
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
require a fresh candidate directory and another validation run.

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
version tag (`v0.6.0` for this batch), including manual retries from that tag. Its
validation job runs the checks above plus database integrations, then uploads the
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

For each existing package (`@vardum/shared`, `@vardum/cli`, `@vardum/mcp`), open
its npm Settings → Trusted publishing and add GitHub Actions with:

| Field | Value |
| --- | --- |
| Organization or user | `frgtn-dot-dev` |
| Repository | `vardum` |
| Workflow filename | `release.yml` |
| Environment | `npm` |
| Allowed actions | Allow direct `npm publish` |

These three connections were configured and exercised on 2026-09-20.
Create the GitHub environment `npm` and restrict its deployment policy to tags
matching `v*`. Configure any required reviewers there. npm validates this trust
when the workflow publishes; simply saving the form does not test the connection.
The workflow pins Node 22.23.3 and npm 12.0.2, which support trusted publishing.
See the [npm trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/).

The source repository is currently private. npm provenance is therefore disabled
for this repository; OIDC authentication still works. The workflow enables
provenance automatically for a public repository. The public package metadata
continues to point to this repository; this does not change repository visibility.

### Trigger and verify

After the release commit has passed CI and the three npm publishers are configured,
push the matching version tag. A successful run publishes shared → CLI → MCP,
checks independent installs from npm, and creates a GitHub release with the
archives and integrity manifest. Manual retries must select the same tag.
The source tree, `release.json`, workflow run and GitHub release identify the
published build. Review npm results before changing the gateway's pending-release
guidance.

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

After successful publication, update release status and the gateway's temporary
unreleased-CLI guidance. Run a first-user install from the public registry and
record the release commit/tag. Publication alone does not close worker recovery,
backup/restore, capacity or external user-acceptance work in the readiness audit.
