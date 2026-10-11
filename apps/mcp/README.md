# @vardum/mcp

MCP server for [Vardum](https://vardum.com): lets an AI agent manage assets,
Vards using a key scoped to one workspace. Workspace creation, membership,
API-key management and domains are managed in the web app with a signed-in session.

## Setup

The server speaks MCP over stdio, so the client starts it — there is nothing to
run by hand. Create a workspace API key in **Settings // API keys** first; the
key is restricted to that workspace and its selected read/write permissions.
Copy the workspace ID from Settings → General for tool calls.

This README describes **MCP 0.3.0**. The 11-tool surface is unchanged. Check the
[release notes](https://github.com/f-tuma/vardum/blob/main/docs/client-release-0.7.md)
and [release status and compatibility](https://github.com/f-tuma/vardum/blob/main/docs/npm-release.md).
The published 0.1.0 artifact has a broken workspace dependency.

The configurations below pin published **0.3.0**, which uses the legacy Vard
editing contract. Revision-guarded editing is currently **unreleased source for
the next client release**; installing 0.3.0 does not enable it. To test that source,
use `pnpm --filter "@vardum/mcp..." build` and configure the client to run
`node /absolute/path/to/vardum/apps/mcp/dist/index.js`. Deploy the matching
revision-capable server first. See the [guarded editor protocol](../../docs/vard-editor-concurrency.md).

Claude Code:

```sh
claude mcp add vardum --env VARDUM_API_KEY=varda_... -- npx -y @vardum/mcp@0.3.0
```

Any client that reads a JSON config (Claude Desktop, Cursor, …):

```json
{
  "mcpServers": {
    "vardum": {
      "command": "npx",
      "args": ["-y", "@vardum/mcp@0.3.0"],
      "env": { "VARDUM_API_KEY": "varda_..." }
    }
  }
}
```

## Configuration

| Setting | Flag | Environment | Default |
| --- | --- | --- | --- |
| Vardum instance | `--server URL` | `VARDUM_SERVER` | `https://vardum.com` |
| Workspace API key | `--api-key KEY` | `VARDUM_API_KEY` | — (required) |

Point `--server` at your own host when self-hosting. `vardum-mcp --version` and
`--help` answer without needing a key, which is the quickest way to check that a
client can start the binary at all.

## Tools

The 11 tools are:

| Area | Tools |
| --- | --- |
| Assets | `list_assets`, `create_asset`, `upload_asset_version`, `set_asset_visibility`, `delete_asset` |
| Vards | `list_vards`, `create_vard`, `get_vard`, `update_vard`, `delete_vard`, `replace_vard_items` |

A read key can list/read. A write key also permits create, update, delete and
publish. Tools for browser-only administration were removed in 0.2.0; creating
an asset key as an owner does not make it an administration credential.

`list_assets` returns `{ workspaceSlug, assets, nextCursor }`. It lists ready
assets in pages of 100 by default (`limit`: 1–500); pass `nextCursor` as `cursor`
until it is null. Pending/failed versions are not listed.

Images and video are accepted; video is stored and delivered as-is, and cannot
be resized or transformed into variants.

## Asset visibility

New assets are private. `list_assets` reports `isPublic` for each ready asset.
Use `set_asset_visibility` with `workspaceId`, `assetId`, and an explicit boolean
`isPublic` to publish or make an asset private. The API requires asset publish
permission; read-only keys cannot change visibility.

Publishing exposes every ready version and its variants. A public Vard does not
publish its files: its anonymous manifest remains unavailable while any mapped
asset is private. Making a file private cannot revoke downloaded or cached
copies. These tools require the matching visibility-capable API in the compatibility table.

## Folder rules

MCP 0.3.0 retains the folder-rule behavior introduced in 0.2.0 and requires the
matching folder-aware API. `get_vard` with `workspaceId` and `vardId` returns
editable configuration: `items` contains **manual mappings only**, and
`folderRules` contains saved rules. Published 0.3.0 uses legacy mutation routes
without revision guards.
For a separate current live preview use `get_vard` with `resolved: true`; this is
not a committed frozen snapshot or an editable definition. It can fail on collisions or limits without blocking
configuration inspection or repair.

`create_vard` accepts `name`, optional `isPublic` (defaults private), and optional
`folderRules` (defaults empty); it does not require a slug. `update_vard` changes
only supplied fields. For example, call it with:

```json
{
  "workspaceId": "your-workspace-id",
  "vardId": "your-vard-id",
  "folderRules": [{ "sourcePrefix": "brand/", "outputPrefix": "assets/brand/" }]
}
```

This preserves the Vard's name, public flag and manual mappings. Send
`folderRules: []` to remove all rules. `replace_vard_items` replaces only manual
mappings and does not change rules: **never copy resolved folder outputs into it**.
The API remains authoritative for workspace permissions and validation; tools
forward validation, authorization and resolution errors.

Rules include ready current originals recursively: `brand/icons/logo.svg` becomes
`assets/brand/icons/logo.svg`. Generated outputs are read-only, unpinned and
untransformed; pending files are excluded until ready. Empty prefixes mean workspace
or project root. Empty/nonexistent folders are valid. Prefixes must be safe literal
relative directories ending in `/` (or empty), at most 255 characters; no globs or
excludes. Maximum 64 rules and 1,000 total manual + generated outputs, with paths
up to 500 characters. Explicit + rule and rule + rule collisions fail, including
case/Unicode equivalents and file/directory overlaps; no precedence or truncation.
A new private folder member makes the entire anonymous public manifest unavailable.

Normal `vardum pull` intentionally adopts membership changes; `--frozen` consumes
the committed snapshot without live resolution. There is no background sync.
Removing rules leaves source assets/manual mappings intact. Choose `--delete` on
the membership-updating pull: a normal no-delete pull keeps stale disk files but
drops their tracking, so a later `--delete` cannot remove them; deliberate manual
cleanup is then required. See [CLI snapshot limitations](https://github.com/f-tuma/vardum/tree/main/apps/cli#reproducible-asset-consumption)
and [operations](https://github.com/f-tuma/vardum/blob/main/docs/operations.md#folder-rule-upgrade) before upgrading or rolling back.

## Guarded editing — unreleased source

`get_vard` returns a revision and manual mappings with stable IDs and literal
`pinnedVersionId`. `update_vard`, `replace_vard_items`, and `delete_vard` require
the caller's original `expectedRevision`. `replace_vard_items` also requires each
item's `id` (existing manual UUID, or null for a new mapping) and an explicit
`versionId` (UUID or null). Copy `pinnedVersionId` to `versionId` literally,
including an unavailable saved pin. A resolved `versionId` describes delivery and
must never be used to infer the pin. Null follows latest; pinned items must be
read-only. The old `pinned` boolean is rejected.

These editor tools check `vardEditRevision: 1` and use dedicated `/editor`
endpoints. An unsupported server, missing revision or missing endpoint stops the
operation; there is no fallback to a legacy mutation. `update_vard` and
`replace_vard_items` require API read + update permissions because they return the
full definition. `delete_vard` requires delete permission.

The revision is an opaque `v1:<64 lowercase hex digits>` equality token for the
saved definition, not a counter. Keep it unchanged. After a successful update or
replacement, retain the full returned definition and revision for the next edit.
A stale write returns a structured MCP tool error with `status: 409`,
`code: "vard_revision_conflict"`, `error: "Vard changed; reload before saving."`,
`currentRevision`, and a reload instruction. Reload with `get_vard`, review the
current definition, and reapply the intended edit. The tool does not fetch a fresh
token or retry a stale replacement list automatically.

The source `get_vard` uses the dedicated editor endpoint for configuration.
A `resolved: true` preview remains separate and supplies no editor revision.
For a folder-rule update, use the same fields as the published example above
and additionally pass `expectedRevision` from your preceding `get_vard`.
Keep the returned full definition and revision for subsequent changes.
This source contract must be released under a new client version before
using it through npm; the published 0.3.0 archive remains unchanged.
