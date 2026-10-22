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
   fit and quality. Enable **Solid background** to choose an opaque color.
   Check the preview and create the use.
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
source, all source versions and every other use. A use explicitly bound by a Vard
cannot be removed: the API returns `409 asset_use_in_use` after checking its
revision. Remove or rebind those Vard outputs first. Empty containing folders can
be removed separately. Source deletion returns `409 source_in_use` while uses remain;
remove or replace those uses first. Whole-workspace deletion explicitly removes
its Vards, then its uses, before deleting the workspace and its sources.

## Link a use to a Vard

In a Vard, choose **Add asset**, then **Linked library use**. Select a ready use,
choose the project output path and save. **Live library use** outputs inherit the
use's settings; **Use settings** opens the library settings rather than storing
another recipe in the Vard. A source mapping still has independent output settings.

Changing a use's dimensions, safe area or background updates every Vard output
linked to that use when its live manifest is resolved. Other uses of the same
source keep their own settings. The Vard's project path stays fixed. A source or
format change incompatible with that path makes the linked output unavailable;
it does not substitute the original bytes. Existing unavailable links can still
be inspected, rebound or removed.

Linked outputs have no separate pin, transformation or writable setting. They
are read-only for push and Vard import, including an **Original** use and a target
whose checksum already matches. A normal pull captures the current resolution;
`pull --frozen` retains its captured source version, complete transformation,
canonical immutable URL and checksums. Editing the use never changes that lock.

## Include uses with a folder rule

Folder rules include originals by default. Enable **Include linked library uses**
on an individual rule to also include uses whose own library paths match its
prefix. The source may live outside that prefix. The saved
output format determines the generated extension; two uses of one source remain
separate outputs. Existing rules do not opt in automatically.

Generated use outputs follow the saved dimensions, safe area, background and ready
source version. They have no independent Vard recipe or pin and are read-only for
push and import, including Original uses and files with matching checksums. Their
identity starts with `folder:use:` and remains stable while the use and output
path stay the same. Changing the format of an extensionless use can change its
generated path and identity. Manual outputs, originals and generated uses share
the same collision rules and 1,000-output limit.

Removing a use included only by a folder rule removes that generated output;
it does not delete its source or change a captured frozen lock. An unavailable
use remains unavailable without falling back to original bytes. One private
matching source or use hides the whole anonymous manifest, including a private
use beyond the output limit. Turn off the rule's opt-in to return that rule to
originals-only membership.

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
source MIME change that cannot satisfy the saved format, or a known source size
that exceeds the configured output pixel budget, returns
`422 linked_use_unavailable`, without a redirect or fallback to original bytes.
The library exposes these metadata incompatibilities as unavailable; repair its
settings or source. Canonical delivery still checks actual bytes, all animation
frames and storage availability; this list is not a full rendering/availability
probe. Caller
transformation overrides on use URLs are rejected: edit the saved settings instead.
The canonical response retains the source's download filename convention.

## API and compatibility

### Output padding

Use optional `pad` with an explicit width, height, raster format and `fit: "contain"`
to reserve centered space within the final canvas. The integer percentage (0–45)
applies to each edge relative to the shorter final side. It works with solid or
transparent backgrounds. See [Output padding](output-padding.md) for exact geometry,
rounding and compatibility.

### Solid output backgrounds

`transformation.bg` accepts an opaque six-digit RGB hex color, such as `#e8e4d9`.
The API normalizes letters to lowercase and requires an explicit PNG, WebP,
AVIF or JPEG output format. Alpha hex colors, CSS expressions and named colors
are rejected. Omit `bg` to retain the existing transformation behavior.

The selected color fills transparent pixels and any `contain` padding. Static
outputs have no alpha channel; animated formats can retain an opaque alpha band
while all rendered pixels remain opaque. The original bytes, transparency and
version history are unchanged. Background is an output setting, not an edit to
the source. Original SVG delivery keeps its vector styles and adaptive behavior;
adding a solid background produces a raster output.

Each use and Vard manual output can choose its own background. Their previews
show the output settings; Vard previews retain the selected source version.
The signed query, derivative cache key and Vard fingerprint include `bg`.
Changing a background produces a new output identity; existing captured URLs and
schema-2 frozen locks continue to identify the previously selected output. With
`bg` absent, existing canonical queries, signatures and cache keys are unchanged.

No database migration is required for this optional transformation field. Deploy
the updated API to every serving instance before creating background settings;
older API binaries reject the new strict query/body field. Existing clients can
pull the signed outputs through the current manifest and frozen-lock protocols.

Workspace routes:

- `GET /api/workspaces/:workspaceId/asset-uses`: authenticated, bounded keyset
  traversal (`prefix`, literal `search`, optional `sourceAssetId`, `limit` up to
  100, `cursor` from `nextCursor`). `recursive=true` includes descendants for
  the Vard picker; omission or `recursive=false` keeps direct-child listing. It returns use identities, their direct source,
  inherited visibility/current version, settings, revision, availability and
  canonical preview URLs and source-processing state. Active library views refresh
  while a referenced source is processing, retaining its previous ready preview
  until the new one is ready. The initial workspace limit is 1,000 uses.
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

Vard manual outputs explicitly choose a source mapping or a live library-use
binding. **Originals-only folder rules remain originals-only**: adding a use does
not silently add a Vard output. Schema-2 rules can explicitly set
`includeUses: true` when the server advertises `vardFolderUses: 1`; false or
omission means originals only. Existing schema-2 frozen snapshots keep the same
canonical source URLs,
captured transforms, version IDs and checksums. The matching gateway/API use
[editor definition schema 2](vard-editor-concurrency.md#live-library-use-definitions)
for linked configuration; immutable manifest and lock schemas do not change.

The known-usage registry continues to describe explicitly registered consumers of
sources and records live Vard bindings in its configuration identity. The
linked-use list proves internal source references, not a complete inventory of
external clients or their cache state.

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

Migration `0020_vard_definition_bindings` adds Vard/item format markers and
workspace/use/source foreign keys. Deploy the matching migrator, API and gateway
before creating live bindings. Old definition writers cannot edit a format-2
Vard. After removing its last binding, use **Return to source-only editing** to
explicitly restore source-only editing; removal alone keeps format 2. Keep the
migration during image rollback and never grant old binaries persistent schema-2
capability. See [upgrade and rollback review](server-release.md#upgrade-and-rollback-review).

Migration `0021_vard_folder_uses` adds stored format 3 for folder opt-in. Wire
definition and frozen-lock schemas stay 2. Deploy its matching migrator, API and
gateway before enabling the checkbox. Current API transactions declare local
capability 3; physical connections retain baseline 1. A format-2 API can continue
working with formats 1/2 while format-3 definitions are hidden and protected from
its writes and cascades. Keep the migration on rollback. Removing every opt-in
and manual use does not silently downgrade the definition; **Return to source-only
editing** performs the explicit safe return to format 1.
