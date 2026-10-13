# Client 0.8.2: adopt existing matching outputs

**Source candidate; publication pending.** This release selects CLI **0.8.2**
with unchanged published shared **0.4.1** and MCP **0.4.1**. Active onboarding
and gateway Copy setup continue to pin verified CLI **0.8.1** until the final
tag batch, actual registry bytes and independent public installs are verified.

## Existing project files

CLI 0.8.2 adds explicit lock-only adoption for projects whose mapped outputs
already exist. Inspect the plan first, then record their verified snapshot:

```sh
npx --no-install vardum status --adopt-existing --json
npx --no-install vardum pull --adopt-existing --json
```

All current outputs must be present and match their actual immutable downloads,
including pinned versions and transformed outputs. Missing or outdated outputs
are `download` decisions; different or locally edited tracked files are
`conflict` decisions. Either blocks adoption. No asset file is replaced.
Status and dry-run retain no project or update-cache writes. Apply publishes one
complete schema 2 lock after rechecking captured files, parent paths,
configuration and the previous snapshot.

The flag is also available through `sync`. It cannot combine with `--frozen`,
`--force`, `--delete`, context overrides or positional arguments. Ordinary pull
conflict behavior remains unchanged. Current CLI pull, push and pull-asset
writers share a cooperative mutex; older clients and arbitrary editors do not.
Detected drift aborts adoption. Atomic snapshot publication does not promise a
filesystem transaction that excludes future edits. If a process crashes,
confirm it has stopped before removing `.vardum.snapshot.mutex`.

## Compatibility and package batch

Schema **2**, minimum CLI **0.6.0**, folder upload/resume/import behavior and
guarded MCP editor protocols remain unchanged. This feature uses existing
manifest and immutable-delivery routes; it requires no new server capability.
The separate first-project/server compatibility fixture stays **0.6/0.2/0.2**.
Source dependencies stay `workspace:^`; the CLI archive requires shared
`^0.4.1`.

The source workflow packs all three packages. Shared and MCP source content is
unchanged; their archives must remain byte-identical to the published 0.4.1
archives. Complete-batch registry preflight must verify that identity before
skipping their existing versions and publishing only CLI 0.8.2. Any difference
is a publication blocker. No historical version, tag or archive is replaced.

## Publication evidence

Pending: final reviewed release source/tree, successful exact-head PR CI,
branch validation-only run with its own archive/download checks, immutable
`v0.8.2` source tag, the final tag run's tested batch, actual registry tarball
comparisons, independent public CLI/MCP installs and installed adoption checks,
and all four matching GitHub release assets. A branch-validation batch cannot
substitute for the final tag-run batch.

This client release does not certify a production server artifact, deploy the
gateway or complete the Musubi pilot. An accepted Node 26 candidate is separate;
the source-release workflow retains Node **22.23.3**.
