# Client 0.7 release candidate

Prepared **2026-10-10** for **VARD-68**. This candidate contains CLI **0.7.0**,
shared **0.3.0** and MCP **0.3.0**. Public npm lookups for all three versions
returned HTTP 404 on that date. They are not published; a final archive preflight
must still check availability before publication. The last verified public
baseline remains CLI **0.6.0**, shared **0.2.0** and MCP **0.2.0**; see
[release evidence and procedure](npm-release.md).

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

## Rollout order

1. Deploy and verify the matching backend with migration 0015 while its CLI
   manifest still pins **0.6.0**. Confirm both capabilities on the target server.
2. Validate the release commit with the pinned Node/pnpm versions and the release
   workflow. Pack once, test the archives, retain their `release.json` hashes and
   run the final public-registry preflight. Confirm package-side trusted publishing
   for the current repository before publication.
3. Publish the tested archives under tag **`v0.7.0`**, in shared → CLI → MCP order.
   Verify their public registry integrity and independent CLI/MCP installations.
4. Deploy the version bump and upgrade project clients only after that verification.
   If merging the release PR can automatically deploy the gateway, publish from
   the tested tag before merging it. The gateway reads `apps/cli/package.json` to
   generate Copy setup; an early version-bump deployment would advertise an
   unavailable `@vardum/cli@0.7.0` install.

Update availability guidance with the published tag, commit and workflow evidence
after verification. Until then, the first-project example and onboarding smoke
continue to pin the verified public baseline.
