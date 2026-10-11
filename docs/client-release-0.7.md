# Client 0.7 release

Published and independently verified **2026-10-11** for **VARD-68**: CLI **0.7.0**,
shared **0.3.0** and MCP **0.3.0**. [Release `v0.7.0`](https://github.com/f-tuma/vardum/releases/tag/v0.7.0)
uses original source `20495967d0d256b12247720f8bbedbce568b54e1` and archives from
origin run **38065972599 attempt 1**, artifact **11674484014**. The separate main
controller `89371efa56a79091c5e5ed5609edd72252860731` published those exact bytes
through [Actions 38119764030, attempt 2](https://github.com/f-tuma/vardum/actions/runs/38119764030).
Actual registry tarballs, public CLI/MCP installs with transitive shared resolution,
and all four GitHub release assets were verified. See [publication evidence](npm-release.md#october-11-publication-evidence).

Frozen asset consumption continues to use **schema 2**, with minimum compatible
CLI **0.6.0**. Schema 3 from VARD-14's
[draft PR #13](https://github.com/f-tuma/vardum/pull/13) is separate, unmerged and
unpublished. That draft's provisional version numbers do not reserve npm versions.

## Changes

- Folder uploads can resume with stable asset/version IDs after storage failures,
  lost responses and processing timeouts. The pending journal binds the target
  and source checksums; unchanged completed uploads do not create new versions.
- `vardum push-folder <directory> [prefix] --output <output-prefix>` adds missing
  explicit mappings to the configured Vard after upload. A complete read-only
  preflight checks permissions, existing mappings, folder rules, collisions and
  the 1,000-output limit. Retry preserves exact ready versions and mapping progress.
- New folder asset keys and display names omit the supported media suffix;
  project output paths retain it. Existing matching filename keys keep their
  identity. Ambiguous keys and output collisions fail before upload.
- `push` and `push-folder` check server upload limits before reading file contents,
  including dry-runs and unchanged files. Folder JSON results expose phases and
  applied work; Vard imports report library and mapping actions separately.
- Shared 0.3.0 exports `mediaStem` and `mediaOutputPath`. Source CLI/MCP dependencies
  stay `workspace:^`; their packed dependencies become `^0.3.0`.
- MCP 0.3.0 retains the existing **11 tools**. Its release updates the shared
  dependency and package metadata. All three packages point repository, homepage
  and bug links at `f-tuma/vardum`; CLI and MCP still require Node.js **22 or newer**.

See the [folder import guide](folder-import.md) and
[CLI recovery instructions](../apps/cli/README.md#commands). Preserve
`.vardum.push.pending.json` after a failed upload or import. These operations do
not update `.vardum.lock` or pull over local source files; run a normal pull
separately to intentionally refresh delivered files and the frozen snapshot.

## Backend requirements

Deploy the matching API, worker and gateway from the folder upload/import changes,
including migrations through **`0015_upload_request_checksum.sql`**. Verify the
actual server's `GET /api/capabilities` response before client upgrades:

- Resumable library folder uploads require `folderUploadResume: 1`.
- Vard imports with `--output` require **both** `folderUploadResume: 1` and
  `folderVardImport: 1`, including dry-run preflight.

The client refuses unsupported operations on older servers. Passing source tests,
merging a PR or publishing client packages does not establish backend deployment
or complete the broader [server/runtime acceptance](production-readiness-2026-09-20.md#current-status).

## Upgrade order

1. Apply backend migrations through **0015** and verify both capabilities on the
   target server. Existing CLI 0.6 projects can continue their schema 2 pull flow.
2. In the project root, install the published exact version:

   ```sh
   npm install --save-dev --save-exact @vardum/cli@0.7.0
   ```

   Commit package.json and the package-manager lockfile. Do not delete the existing
   `.vardum.lock`; CLI 0.7 consumes schema 2 without a snapshot migration.
3. Check `vardum status` and review folder import with `--dry-run --json` before
   applying it. Upload/import updates the library and optional mappings; a separate
   normal `vardum pull` refreshes project files and the snapshot. CI keeps using
   `vardum pull --frozen` for the committed snapshot.
4. Deploy the reviewed source version bump after its CI passes. Copy setup reads
   the CLI manifest and can now advertise the available 0.7.0 package.

The first-project example and server-candidate smoke intentionally retain their
CLI 0.6.0 public compatibility fixture and lockfile. New projects can follow the
[quick start](guide/quick-start.md) with 0.7.0. Changes to source README files after
publication do not change the immutable published tarballs; retries must use the
[retained archive procedure](npm-release.md#publish-the-retained-candidate-through-actions).
Do not repack these versions or move the source tag.
