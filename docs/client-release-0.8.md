# Client 0.8 candidate

Proposed next immutable client batch, status **2026-10-11**: CLI **0.8.0**,
shared **0.4.0** and MCP **0.4.0**. These versions are **not published**; all three
exact registry versions returned 404 at this checkpoint. Currently published
and verified packages remain CLI **0.7.0**, shared **0.3.0** and MCP **0.3.0**.
Check [release status](npm-release.md) for availability. Package README install
commands that pin 0.8/0.4 target this candidate and become usable only after
publication is verified.

The feature source is [PR #27](https://github.com/f-tuma/vardum/pull/27) at
`31e03390d6970ebf6c0a500ec9489b62a7c39e63`. Both final reviews and [CI38124816726](https://github.com/f-tuma/vardum/actions/runs/38124816726)
passed; PR #27 was squash merged as `85865e476e851bcc9a3fafb5c4ddc096e8a5a671`,
with the identical tested tree `a050fb79debce16ae33d58d297145f6e1c89a38d`.
The release commit/tag and tested archive identities are not yet assigned. Main's CLI
manifest and Copy setup stay on **0.7.0** until real publication and independent
public installation verification complete.

Frozen consumption remains **schema 2**, with minimum compatible CLI **0.6.0**.
The first-project example and server-candidate public compatibility fixture stay
on CLI 0.6.0 / MCP and shared 0.2.0. VARD-14's schema 3 draft and provisional
version numbers remain separate, unmerged and unpublished.

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

After final feature CI, merge and fresh review, prepare the new versions and
release documentation on a candidate branch. Use `release_mode=source` and
`validation_only=true` for the branch archive/download check. It cannot publish.
The final matching **`v0.8.0`** tag run packs and tests a **separate batch**; its
publisher downloads exactly that same run's tested archives. Do not substitute
the earlier branch run's archives or repack in the publisher.

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
2. Complete final candidate validation and tag publication; verify actual npm
   archive bytes, separate public CLI/MCP installs with transitive shared 0.4.0,
   and all four GitHub release assets against that tag run's tested batch.
3. **Only after publication is verified**, install the exact CLI in each project:

   ```sh
   npm install --save-dev --save-exact @vardum/cli@0.8.0
   ```

   Commit package.json and its package-manager lockfile. Keep the schema 2
   `.vardum.lock`; no snapshot migration is needed. Update MCP configuration to
   exact `@vardum/mcp@0.4.0` and use the mandatory revision/ID/literal-pin contract.
4. Review `vardum status` and folder `--dry-run --json` before applying. Run a
   separate normal pull when intentionally refreshing delivered files and the
   snapshot. CI continues to use `vardum pull --frozen`.
5. Promote the reviewed version bump and availability docs to main after real
   publication verification; Copy setup then advertises the available CLI 0.8.0.

Publication does not complete a new human first-use session, the Musubi pilot,
or server/runtime/provider/backup/restore/capacity acceptance. Keep the
[0.7 release notes and evidence](client-release-0.7.md) unchanged.
