# One source, multiple library uses

A source asset owns the original file, version history and visibility. A **linked
use** is a library item with its own name, fixed path and output settings. It
references one source in the same workspace; it does not copy the original or
create another version history.

For example, `brand/source/logo` can supply `mobile/icon` as a 128 px PNG and
`website/logo` as a 320 px WebP. Upload or restore a source version once; both
uses follow its latest ready version. Editing the mobile use changes only its
settings.

## In the dashboard

1. Open the destination folder under **Assets** and choose **Use existing**.
2. Search for a source, choose it, then set the use name and full destination
   path. The path includes its folders; missing folders are created.
3. Choose **Original**, or an explicit image format with optional width, height,
   fit and quality. Check the preview and create the use.
4. Open a **Linked** card to change its settings, copy its stable URL, open the
   source, or remove only that use.

The source detail lists its linked uses and offers **Use in another folder**.
Upload, history, restore and visibility remain source actions. Viewers can inspect
uses and copy their URLs; editing follows existing workspace permissions.

Paths and source bindings are immutable in this first version. Create another use
for a different path or source. The default path has no extension. If an extension
is supplied, it must match the output MIME type; switching a fixed `.png` path to
JPEG requires a different use. An unrecognized extension is rejected.

Settings and removal require the revision that was read. A concurrent change
returns `409`; reload the settings before trying again. Removing a use keeps its
source, all source versions and every other use. Empty containing folders can be
removed separately. Source deletion returns `409 source_in_use` while uses remain;
remove or replace those uses first. Whole-workspace deletion explicitly removes
its uses before deleting the workspace and its sources.

## Delivery and privacy

The use URL is `/w/<workspace-slug>/<use-path>`; verified custom domains and the
legacy stable `/assets/` entry route also resolve it. A successful stable request
returns a temporary `302` directly to the **source's existing immutable version
URL**, with the complete signed output transformation when applicable. Changing
use settings never changes the meaning of a previously captured immutable URL.
There is no immutable alias URL that depends on mutable use settings.

Uses inherit source visibility, including later visibility changes. Private
requests require workspace read access before revealing a redirect and again on
the canonical immutable target. Private responses and errors are `no-store`.
Public stable redirects use the existing `max-age=60,
stale-while-revalidate=300` policy; caches may therefore continue using a previous
redirect during that window. Previously public immutable copies cannot be revoked
from downstream caches. Existing canonical HEAD and range behavior is retained:
original byte ranges can return `206`, transformed requests return complete output.

A use always follows the **ready current** source, so a pending or failed newer
upload does not replace its effective version. Original uses retain their chosen
MIME type. A transformed use requires an explicit supported output format. A
source change that cannot satisfy the saved settings returns
`422 linked_use_unavailable`, without a redirect or fallback to original bytes.
The library exposes this as unavailable; repair its settings or source. Caller
transformation overrides on use URLs are rejected: edit the saved settings instead.
The canonical response retains the source's download filename convention.

## API and compatibility

Workspace routes:

- `GET /api/workspaces/:workspaceId/asset-uses`: authenticated, bounded keyset
  traversal (`prefix`, literal `search`, optional `sourceAssetId`, `limit` up to
  100, `cursor` from `nextCursor`). It returns use identities, their direct source,
  inherited visibility/current version, settings, revision, availability and
  canonical preview URLs. The initial workspace limit is 1,000 uses.
- `POST /asset-uses`: `sourceAssetId`, `key`, `displayName`, and nullable
  `transformation`. Creation requires a ready source in the same workspace.
- `PATCH /asset-uses/:useId`: `displayName`, nullable `transformation`, and
  `expectedRevision`. Semantic no-ops preserve revision and timestamps.
- `DELETE /asset-uses/:useId?expectedRevision=…`: removes only the use.

The last three paths share `/api/workspaces/:workspaceId`. Unknown write fields,
reference chains, source/path changes, per-use visibility and pinning are rejected.
The library displays uses separately from source cards, with independently paged
results. The legacy `/assets` listing and sync identity contracts stay source-only.
Their folder listing includes containing folders, so a folder with only uses is
still navigable and cannot be removed while occupied.

Uses are **read-only upload destinations**. They never return a writable source ID
under an alias identity. Source creation at a use's path (or a conflicting ancestor
or descendant) fails before presigning, and a use UUID cannot admit a version
upload. Vard import preflight and commit reject use paths. Server guards protect
an alias target even for old clients; an old multi-file client may already have
completed unrelated files before it encounters a collision. This is not a new
whole-batch transactional upload guarantee.

Existing Vard manual mappings can already reuse a source with independent output
settings. They are not live bindings to library-use settings. **Originals-only
folder rules remain originals-only**: adding a use does not silently add a Vard
output. Explicit live Vard bindings and opt-in folder inclusion are follow-up work
with definition/version guards. Existing schema-2 frozen snapshots keep the same
canonical source URLs, captured transforms, version IDs and checksums.

The known-usage registry continues to describe explicitly registered consumers of
sources. The linked-use list proves internal source references, not a complete
inventory of external clients or their cache state.

## Migration and operations

Migration `0017_asset_uses` is additive. It adds a forced-RLS tenant table,
composite source FK, indexes, and namespace triggers. Source keys, IDs, version
histories, storage keys, existing URLs and data remain unchanged. There is no
automatic deduplication or repointing of existing Musubi artwork.

All use/source/folder namespace writers share the workspace content transaction
guard; database triggers also reject conflicting use paths. Source deletion and
use creation coordinate under the same guard and the FK prevents dangling
references. Existing source/folder overlaps are preserved, but a new use cannot
occupy a conflicting file/folder path. The migrator's normal runtime-role
provisioning grants access to the new table. Runtime probes verify its RLS policy,
and the backup/restore acceptance includes a real linked use and its delivered
bytes. A rollback must not drop this table while references are in use; roll the
application forward or remove uses deliberately before schema rollback.
