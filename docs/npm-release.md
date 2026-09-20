# npm release candidates

Status on 2026-09-20: **prepared locally, not published**. The public registry
still has CLI 0.5.0, MCP 0.1.0 and shared 0.1.0. CLI/MCP contain an unsupported
`workspace:^` dependency and cannot provide the documented new-user install path.
Those versions are immutable; release the new versions below together.

## Compatibility

| Component | Candidate | Required counterpart |
| --- | --- | --- |
| `@vardum/cli` | 0.6.0, Node ≥22 | Matching server candidate; minimum CLI for schema 2 frozen snapshots |
| `@vardum/mcp` | 0.2.0, Node ≥22 | Matching server candidate; 11 asset/Vard tools using a workspace key |
| `@vardum/shared` | 0.2.0 | CLI/MCP archives require `^0.2.0`; resolved automatically by npm |
| API / gateway / worker | Server source accompanying this candidate, intended tag `v0.6.0` | Apply migrations through `0010_vard_folder_rules.sql` and follow runtime-role/visibility upgrade instructions |
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

Use Node 22 and the root `packageManager` version of pnpm. From a clean checkout
of the intended release commit:

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
only for a matching CLI version tag (`v0.6.0` for this batch), including manual
dispatch from that tag. Its validation job runs the checks above plus database
integrations, then uploads the exact tested archives. A separate publish job
downloads that artifact, checks its SHA-512 manifest, and uses the `npm`
environment and npm trusted publishing (OIDC). No `NPM_TOKEN` secret is needed.
Release runs are serialized and cannot cancel an in-progress publication.

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

Create the GitHub environment `npm` and restrict its deployment policy to tags
matching `v*`. Configure any required reviewers there. npm validates this trust
when the workflow publishes; simply saving the form does not test the connection.
The workflow pins Node 22.23.2 and npm 12.0.2, which support trusted publishing.
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
