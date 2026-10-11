# Guarded Vard editor protocol

Deployments supporting guarded edits advertise `vardEditRevision: 1` from
`GET /api/capabilities`. Clients must use the dedicated editor routes to obtain
and submit revisions. The legacy definition, PATCH, item-replacement and DELETE
routes retain their previous behavior; an `expectedRevision` field on a legacy
request does not make that request guarded.

| Request | Required guard | Response |
| --- | --- | --- |
| `GET /api/workspaces/:workspaceId/vards/:vardId/editor` | None | Full manual-only editable definition with `revision` |
| `PATCH .../editor` | Body `expectedRevision`, plus at least one of `name`, `isPublic`, `folderRules` | Full next editable definition |
| `PUT .../editor/items` | Body `expectedRevision`, `items` | Full next editable definition |
| `DELETE .../editor` | Query `expectedRevision` | 204 |

Editor schemas reject unknown properties and require a valid `v1:` SHA-256 token
on writes. PATCH omission preserves that field. Each item in PUT's complete
intended manual list has an `id`: an existing manual mapping UUID preserves the
mapping, while `null` allocates a new UUID. Duplicate, unknown, another Vard's,
and generated mapping IDs are rejected. Omitted existing IDs remove those rows.
Literal saved pins are returned as `pinnedVersionId`, independently of the live
resolved `versionId`; every PUT item must explicitly supply `versionId` as the
intended literal pin, or `null` to follow the current original. Omitting it is
invalid and cannot silently remove a saved pin.

Authorization precedes domain reads: GET requires read; PATCH and PUT require
read and update because they return the full definition; DELETE requires delete.
A foreign or absent Vard returns 404 only after workspace authorization. No
revision is included in unauthorized or missing responses.

All editor reads and writes acquire the workspace content advisory lock inside
one tenant-scoped transaction. A write reads persisted state and compares its
guard before domain validation, no-op detection, mutation, or audit. Its response
is read within that same transaction, without opening a nested transaction. A
stale write returns HTTP 409:

```json
{
  "code": "vard_revision_conflict",
  "error": "Vard changed; reload before saving.",
  "currentRevision": "v1:<64 lowercase hexadecimal characters>"
}
```

The client should keep its unsaved draft, reload the editor definition, and let
the user reconcile it with the latest state before submitting a new revision.
The conflict token is not permission to blindly repeat the stale desired list.

A fresh semantic no-op preserves the revision, IDs, timestamps, and audit.
Unchanged rows are not updated. Setting edits retain existing IDs. Output-path
moves preserve IDs and the exact creation timestamp/creator: all removed and
moved rows are deleted before moved rows are reinserted, accommodating swaps and
cycles under the immediate unique output-path index.

The editor retains existing domain validation and repair behavior. It validates
manual path duplicates, workspace asset ownership, pinned-version existence and
ownership, writable settings, and supplied fields before mutation. New or changed
pins must be ready. An existing manual UUID may retain its exact persisted asset
and non-null pin IDs even when that version is no longer ready, allowing no-op
saves and unrelated edits without losing the saved pin. It does not
require a currently valid expanded manifest to inspect or repair a definition;
folder-rule changes can still repair collisions or overflow.

## Revision meaning

The token hashes canonical persisted workspace/Vard identity, name, public flag,
ordered folder rules, the Vard's exact UTC PostgreSQL `updated_at` value (including
microseconds), and manual rows sorted by ID. Manual row values include literal
asset/pin IDs, output path, transformation, writable setting, and exact creation
metadata. Object keys are canonicalized; ordered arrays remain ordered.

This is **state-equivalence optimistic concurrency**, not a monotonic mutation
counter or an event history. Restoring an exactly identical persisted state,
including its IDs and timestamps, can restore a token. It does not promise strict
ABA detection for a mutation-and-restoration inside one timestamp value. A hash
collision has the usual SHA-256 probability.

Live current asset versions, source names/keys/privacy/MIME/checksum/size, delivery
URLs, and generated folder membership are excluded. Source-only changes do not
invalidate a draft's editable configuration. Additive imports, legacy item
replacements or field updates, and item cascades from asset deletion or failed
S3-copy cleanup change hashed persisted state. These writers already share the
workspace content lock, so they require no schema migration or revision bump.

The real PostgreSQL editor fixture runs with private-delivery's disposable
cluster and production RLS role. It observes advisory-lock waiters to force both
import/editor orderings, two editors, and folder-rule orderings. It also checks
stable IDs, pins, swaps/cycles, exact creation metadata, no-op and import replay,
legacy invalidation, source-only stability, asset-delete and failed-copy
cascades, strict guard validation, atomic stale/invalid rejection, coherent
responses, and tenant authorization.
