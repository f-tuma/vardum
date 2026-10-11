# @vardum/mcp

MCP server for [Vardum](https://vardum.com): lets an AI agent manage assets and
Vards using a key scoped to one workspace. Workspace creation, membership,
API-key management and domains are managed in the web app with a signed-in session.

This README describes **MCP 0.4.0**, including revision-guarded Vard editing.
Check the [0.8 client release notes](https://github.com/f-tuma/vardum/blob/main/docs/client-release-0.8.md)
and [release status and compatibility](https://github.com/f-tuma/vardum/blob/main/docs/npm-release.md)
for publication evidence and compatibility. Older MCP 0.3.0 uses the legacy
editing contract; installing it does not enable revision guards.
The published 0.1.0 artifact has a broken workspace dependency.

## Setup

The server speaks MCP over stdio, so the client starts it. Create a workspace
API key in **Settings // API keys** first; it is restricted to that workspace
and its selected permissions. Copy the workspace ID from Settings → General
for tool calls. Use Node.js 22 or newer.

These configurations pin published **MCP 0.4.0**. Deploy the matching server
advertising `vardEditRevision: 1` before editing Vards. See the
[MCP guide](../../docs/guide/mcp.md) for setup and guarded editing.

Claude Code:

```sh
claude mcp add vardum --env VARDUM_API_KEY=varda_... -- npx -y @vardum/mcp@0.4.0
```

Any client that reads a JSON config (Claude Desktop, Cursor, …):

```json
{
  "mcpServers": {
    "vardum": {
      "command": "npx",
      "args": ["-y", "@vardum/mcp@0.4.0"],
      "env": { "VARDUM_API_KEY": "varda_..." }
    }
  }
}
```

For a source checkout, build with `pnpm --filter "@vardum/mcp..." build` and
configure the client to run `node /absolute/path/to/vardum/apps/mcp/dist/index.js`.
This does not establish npm availability.

## Configuration

| Setting | Flag | Environment | Default |
| --- | --- | --- | --- |
| Vardum instance | `--server URL` | `VARDUM_SERVER` | `https://vardum.com` |
| Workspace API key | `--api-key KEY` | `VARDUM_API_KEY` | — (required) |

Point `--server` at your own host when self-hosting. `vardum-mcp --version` and
`--help` answer without needing a key.

## Tools

The 11 tools remain:

| Area | Tools |
| --- | --- |
| Assets | `list_assets`, `create_asset`, `upload_asset_version`, `set_asset_visibility`, `delete_asset` |
| Vards | `list_vards`, `create_vard`, `get_vard`, `update_vard`, `delete_vard`, `replace_vard_items` |

A read key can list/read. A write key also permits create, update, delete and
publish within its scope. `update_vard` and `replace_vard_items` require API read
and update permission because they return the full definition. `delete_vard`
requires delete permission. Tools for browser-only administration were removed
in 0.2.0; an owner-created workspace key is still not an administration credential.

`list_assets` returns `{ workspaceSlug, assets, nextCursor }`. It lists ready
assets in pages of 100 by default (`limit`: 1–500); pass `nextCursor` as `cursor`
until it is null. Pending/failed versions are not listed. Images and video are
accepted; video is stored and delivered as-is without variants.

## Asset visibility

New assets are private. `list_assets` reports `isPublic` for each ready asset.
Use `set_asset_visibility` with `workspaceId`, `assetId`, and an explicit boolean
`isPublic` to publish or make an asset private. This requires publish permission.

Publishing exposes every ready version and its variants. A public Vard does not
publish its files: its anonymous manifest remains unavailable while any mapped
asset is private. Making a file private cannot revoke downloaded or cached
copies. These tools require the matching visibility-capable API in the
compatibility table.

## Guarded editing

Read `get_vard` first. Its editable definition contains `revision`, saved
`folderRules` and **manual mappings only**, including stable mapping `id` values
and literal `pinnedVersionId`. A separate `get_vard` with `resolved: true` returns
a live preview without an editor revision. It can fail on collisions or limits
without blocking configuration inspection or repair. Never persist resolved
folder outputs as manual mappings.

`update_vard`, `replace_vard_items` and `delete_vard` require the caller's
**original `expectedRevision`**. It is an opaque `v1:<64 lowercase hex digits>`
equality token for saved state, not a counter. Keep it unchanged. After a
successful update or replacement, retain the full returned definition and its
revision for the next edit.

`replace_vard_items` takes the complete intended manual list. Each item must
contain `id` (its existing manual UUID, or `null` for a new mapping), `assetId`,
`outputPath`, `writable`, `transformation` (object or `null`) and an explicit
`versionId` (UUID or `null`). Keep existing IDs; omitting an existing item removes
it. Copy each saved `pinnedVersionId` into `versionId` literally, including an
unavailable saved pin. A resolved delivery `versionId` is not the saved pin.
`null` follows latest; pinned items must be read-only. Omitting `id` or
`versionId`, or supplying the old `pinned` boolean, is invalid.

These editor tools check `vardEditRevision: 1` and use dedicated `/editor`
endpoints. An unsupported server, missing revision or missing editor endpoint
stops the operation; there is no fallback to a legacy mutation.

A stale write returns a structured MCP tool error (`isError: true`) with
`status: 409`, `code: "vard_revision_conflict"`,
`error: "Vard changed; reload before saving."`, `currentRevision` and an
instruction to reload. Keep the intended edit, read `get_vard` again, review the
current definition, then reapply the edit with that reviewed definition's
revision. Do not automatically repeat a stale replacement list with a new token.
See the [guarded editor protocol](../../docs/vard-editor-concurrency.md).

## Folder rules

`create_vard` accepts `name`, optional `isPublic` (defaults private) and optional
`folderRules` (defaults empty); it does not require a slug. `update_vard` changes
only supplied fields. After reading `get_vard`, update rules with:

```json
{
  "workspaceId": "your-workspace-id",
  "vardId": "your-vard-id",
  "expectedRevision": "v1:<copy the original revision from get_vard>",
  "folderRules": [{ "sourcePrefix": "brand/", "outputPrefix": "assets/brand/" }]
}
```

Replace the illustrative token with the unchanged revision from your read. This
preserves the Vard's name, public flag and manual mappings. Send `folderRules: []`
to remove all rules. `replace_vard_items` preserves rules.

Rules include ready current originals recursively: `brand/icons/logo.svg` becomes
`assets/brand/icons/logo.svg`. Generated outputs are read-only, unpinned and
untransformed; pending files are excluded until ready. Empty prefixes mean
workspace or project root. Empty/nonexistent folders are valid. Prefixes are
safe literal relative directories ending in `/` (or empty), at most 255
characters; no globs or excludes. Maximum 64 rules and 1,000 total manual +
generated outputs, with paths up to 500 characters. Explicit + rule and rule +
rule collisions fail, including case/Unicode equivalents and file/directory
overlaps. A new private member blocks the entire anonymous public manifest.

Normal `vardum pull` intentionally adopts membership changes; `--frozen`
consumes the committed snapshot without live resolution. There is no background
sync. Removing rules leaves source assets/manual mappings intact. Choose
`--delete` on the membership-updating pull: a normal no-delete pull keeps stale
disk files but drops their tracking, so a later `--delete` cannot remove them.
See [CLI snapshot limitations](https://github.com/f-tuma/vardum/tree/main/apps/cli#reproducible-asset-consumption)
and [operations](https://github.com/f-tuma/vardum/blob/main/docs/operations.md#folder-rule-upgrade)
before upgrading or rolling back.
