# Client 0.8 release

Published and independently verified **2026-10-11** for **VARD-69**: CLI
**0.8.0**, shared **0.4.0** and MCP **0.4.0**. Actual registry tarballs,
independent public CLI/MCP installs with transitive shared 0.4.0, and all four
GitHub release assets match the final tag run's tested batch. See
[release status](npm-release.md) and the publication evidence below.

[Release `v0.8.0`](https://github.com/f-tuma/vardum/releases/tag/v0.8.0) identifies
immutable source `a5b978432556518d895016aa398ff915a9b97224`, tree
`a9ea341bcf5e878cc619f35a2dfdcb21bc4a7b9b`, prepared in
[PR #40](https://github.com/f-tuma/vardum/pull/40). Its feature source is
[PR #27](https://github.com/f-tuma/vardum/pull/27) at
`31e03390d6970ebf6c0a500ec9489b62a7c39e63`. Both final reviews and
[CI 38124816726](https://github.com/f-tuma/vardum/actions/runs/38124816726)
passed; PR #27 was squash merged as `85865e476e851bcc9a3fafb5c4ddc096e8a5a671`,
with the identical tested tree `a050fb79debce16ae33d58d297145f6e1c89a38d`.

Post-publication documentation commits on main do not move that tag, change its
source tree or replace its npm/GitHub archives. Source package README updates
also do not alter the README bytes already packed in the published archives.
Never repack this source under the published versions.

Frozen consumption remains **schema 2**, with minimum compatible CLI **0.6.0**.
The first-project example and server-candidate public compatibility fixture stay
on CLI 0.6.0 / MCP and shared 0.2.0. VARD-14's schema 3 draft and provisional
version numbers remain separate, unmerged and unpublished.

## Publication evidence

The [branch validation-only run](https://github.com/f-tuma/vardum/actions/runs/38126166933)
and the final matching-tag run produced separate tested archive batches. The
branch run could not publish. The final tag run's publisher downloaded its own
successful validation job's exact archives and published shared → CLI → MCP
through OIDC, then verified registry bytes, independent installs and release assets.

| Evidence | Recorded identity |
| --- | --- |
| Final tag run | [Actions tag run](https://github.com/f-tuma/vardum/actions/runs/38127269600), verified attempt **1** |
| Tested npm artifact | **11698490002**, downloaded ZIP **58102** bytes, SHA-256 `6da766317985ecad3678a70087a695801c5ad80e2c7f18601648d5427d97abbc` |
| Sanitized runtime evidence artifact | **11697689675**, downloaded ZIP **10594** bytes, SHA-256 `e68e4bb190ee3ea8f1066bc605b1518347f09aa6d2fff1e36119b151ae88eb20` |
| Package/release bytes | Three npm archives and `release.json`; registry tarballs and all four GitHub release assets compared against the tested batch |

The npm artifact identifies the original tested archives; its `release.json`
records each archive's SHA-512 integrity. Sanitized runtime evidence records the
tag run's image/check outcomes separately from publication. It does not certify
a production server artifact or close residual runtime findings. The retained
0.7 batch and its original publication evidence are unchanged.

## Changes

- CLI 0.8.0 classifies every folder source as **New**, **Update** or **Skip**. The terminal shows totals and the first 15 rows; JSON contains the complete plan. A
  library-only JSON result adds `library` beside mutation `actions`, with
  `source`, exact `key`, `libraryAction` and `applied`. Existing rows report real
  asset/current ready version IDs when available; pending rows retain exact
  journal IDs, phase and original new/update classification with `resumed: true`.
  New dry-run rows reserve no upload IDs. A skipped library-only row adds no
  mutation action or change and keeps `applied: false` because it performed no upload.
- The terminal confirmation uses the same captured checksum plan as JSON. Before
  upload, the CLI revalidates source metadata, pending journal, remote identities,
  current versions and filename/stem alternatives. Imports also recheck their
  mapping plan. A changed source or competing sibling key stops execution and
  requires a fresh plan. Existing filename-key identities and names remain
  preserved; ambiguous keys are rejected rather than merged.
- Resumable upload and additive Vard import behavior from CLI 0.7 is retained.
  Rerun the same command with its original files and journal to reuse exact upload
  identities and finish mappings. Upload/import still does not run a pull or
  advance `.vardum.lock`. A lost response may follow a remote mutation even when
  `applied` is false; keep the journal and retry.
- MCP 0.4.0 retains the **11 tools** and changes Vard editing to dedicated guarded
  `/editor` routes. Editable `get_vard` requires `vardEditRevision: 1` and returns
  the saved definition, opaque `revision`, stable manual IDs and literal nullable
  `pinnedVersionId`. A `resolved: true` live preview remains separate and has no
  editor revision.
- MCP updates, replacements and deletion require the caller's original
  `expectedRevision`. Every replacement item explicitly carries its existing
  manual `id` or `null` for a new mapping and its literal nullable `versionId`.
  Copy `pinnedVersionId` literally, including unavailable pins; do not infer it
  from the resolved delivery version. Missing IDs/pins and the old `pinned`
  boolean are rejected. Pinned items are read-only.
- A stale edit returns a structured MCP tool error (`isError: true`) with
  `status: 409`, `code: "vard_revision_conflict"`, `currentRevision` and a reload
  instruction. Read the latest definition, review it and reapply the intended
  edit; never automatically replay a stale list with a fresh revision. Unsupported
  servers or missing editor endpoints stop edits without legacy fallback.
- Shared 0.4.0 exports the guarded editor definition/input types. Source
  CLI/MCP dependencies remain `workspace:^`; the archives must contain `^0.4.0`.
  CLI and MCP require Node.js **22 or newer**.

See the [folder import guide](folder-import.md), [CLI reference](../apps/cli/README.md)
and [MCP guarded contract](../apps/mcp/README.md#guarded-editing).

## Backend requirements

Apply migrations through **`0015_upload_request_checksum.sql`** and deploy the
matching contracts before upgrading clients. Guarded editing requires no extra
database migration beyond this upload/import baseline. Verify the intended
instance's `GET /api/capabilities` response:

| Operation | Required capability |
| --- | --- |
| Resumable library folder mutation | `folderUploadResume: 1` |
| Vard import with `--output`, including dry-run | `folderUploadResume: 1` and `folderVardImport: 1` |
| MCP editable Vard read/update/replacement/delete | `vardEditRevision: 1` |

Production advertises all three at the October 11 checkpoint. This observation
does not certify a released server/runtime artifact or complete the broader
[production acceptance](production-readiness-2026-09-20.md#current-status).
Library-only dry-run can inspect an older server; unknown unfinished-upload
activity is reported as `uncertain: true`. Mutations require complete resumable
identity metadata. MCP update/replacement requires API read + update permission;
deletion requires delete permission.

## Release preparation and recovery

This release used the source workflow. Branch `validation_only=true` checked
the prepared candidate archives and their download without publishing. The final
matching **`v0.8.0`** tag run packed and tested a **separate batch**; its publisher
downloaded exactly that same run's tested archives. Never substitute the earlier
branch run's archives or repack in the publisher.

If final publication or registry verification fails, rerun only failed jobs in
the original tag run:

```sh
gh run rerun ORIGINAL_TAG_RUN_ID --repo f-tuma/vardum --failed
```

A new dispatch or full rerun repacks and is not recovery of the original batch.
Retain the original run/artifact IDs and hashes. If that artifact is unavailable,
stop and review recovery before publication. The retained 0.7 controller and its
descriptor remain dedicated to their historical exact archives; do not repurpose
them for this source batch. See [release procedure](npm-release.md#publish).

## Upgrade order

1. Verify migrations and the capabilities needed on the target server.
2. Install the published exact CLI in each project:

   ```sh
   npm install --save-dev --save-exact @vardum/cli@0.8.0
   ```

   Commit package.json and its package-manager lockfile. Keep the schema 2
   `.vardum.lock`; no snapshot migration is needed. Update MCP configuration to
   exact `@vardum/mcp@0.4.0` and use the mandatory revision/ID/literal-pin contract.
3. Review `vardum status` and folder `--dry-run --json` before applying. Run a
   separate normal pull when intentionally refreshing delivered files and the
   snapshot. CI continues to use `vardum pull --frozen`.
4. The reviewed version bump can now be promoted and deployed. The Vard's
   **Setup** tab derives Copy setup's exact CLI version from the manifest;
   deploy the matching gateway source to offer the available CLI 0.8.0.

Publication does not complete a new human first-use session, the Musubi pilot,
or server/runtime/provider/backup/restore/capacity acceptance. Keep the
[0.7 release notes and evidence](client-release-0.7.md) unchanged.
