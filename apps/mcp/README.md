# @vardum/mcp

MCP server for [Vardum](https://vardum.com): lets an AI agent manage assets,
Vards using a key scoped to one workspace. Workspace creation, membership,
API-key management and domains are managed in the web app with a signed-in session.

## Setup

The server speaks MCP over stdio, so the client starts it — there is nothing to
run by hand. Create a workspace API key in **Settings // API keys** first; the
key is restricted to that workspace and its selected read/write permissions.
Copy the workspace ID from Settings → General for tool calls.

This README targets MCP **0.2.0**; see [release status and compatibility](https://github.com/frgtn-dot-dev/vardum/blob/main/docs/npm-release.md).
The published 0.1.0 artifact has a broken workspace dependency.

Claude Code:

```sh
claude mcp add vardum --env VARDUM_API_KEY=varda_... -- npx -y @vardum/mcp@0.2.0
```

Any client that reads a JSON config (Claude Desktop, Cursor, …):

```json
{
  "mcpServers": {
    "vardum": {
      "command": "npx",
      "args": ["-y", "@vardum/mcp@0.2.0"],
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

`replace_vard_items` pins with `versionId: "<ready-version-uuid>"` and
`writable: false`. Omit `versionId` or send null to follow latest. The old
`pinned` boolean is rejected: it never identified a specific version for the API.

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

Use MCP 0.2.0 with the matching folder-aware API.
`get_vard` with `workspaceId` and `vardId` returns editable configuration:
`items` contains **manual mappings only**, and `folderRules` contains saved rules.
For a separate current live preview use `get_vard` with `resolved: true`; this is
not a committed frozen snapshot and can fail on collisions or limits without
blocking configuration inspection or repair.

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

This preserves the Vard's name, public flag and manual item IDs. Send
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
cleanup is then required. See [CLI snapshot limitations](https://github.com/frgtn-dot-dev/vardum/tree/main/apps/cli#reproducible-asset-consumption)
and [operations](https://github.com/frgtn-dot-dev/vardum/blob/main/docs/operations.md#folder-rule-upgrade) before upgrading or rolling back.
