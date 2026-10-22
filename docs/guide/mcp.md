# MCP server

`@vardum/mcp` gives an AI agent the library and Vards of one workspace.

```text
agent ── stdio ──> @vardum/mcp
                        │
                        │ HTTPS + key
                        ▼
                      Vardum
```

## Setup

1. Create a workspace API key in **Settings → API keys**.
2. Copy the workspace ID from **Settings → General**; tools take it.
3. Add the server to your client.

Claude Code:

```sh
claude mcp add vardum --env VARDUM_API_KEY=varda_... -- npx -y @vardum/mcp@0.4.2
```

Claude Desktop, Cursor and other JSON configs:

```json
{
  "mcpServers": {
    "vardum": {
      "command": "npx",
      "args": ["-y", "@vardum/mcp@0.4.2"],
      "env": { "VARDUM_API_KEY": "varda_..." }
    }
  }
}
```

The client starts the server; there is nothing to run by hand. These examples
pin published **MCP 0.4.2**. Editable Vard reads and mutations require a server
advertising `vardEditRevision: 1`; see [release compatibility](../npm-release.md).

## Configuration

| Setting | Flag | Environment | Default |
| --- | --- | --- | --- |
| Instance | `--server URL` | `VARDUM_SERVER` | `https://vardum.com` |
| API key | `--api-key KEY` | `VARDUM_API_KEY` | required |

- Self-hosting: point `--server` at your host.
- `vardum-mcp --version` works without a key, to check the client can start it.

## Tools

| Area | Tools |
| --- | --- |
| Assets | `list_assets` `create_asset` `upload_asset_version` `set_asset_visibility` `delete_asset` |
| Vards | `list_vards` `create_vard` `get_vard` `update_vard` `delete_vard` `replace_vard_items` |

- A **read** key lists and reads. A **write** key also creates, updates,
  deletes and publishes.
- `list_assets`: ready assets, 100 per page (`limit` 1–500); pass `nextCursor`
  as `cursor` until it is null.
- New assets are private; `set_asset_visibility` publishes them.
- Video is accepted but has no variants.

## Vards and folder rules

| To | Call |
| --- | --- |
| Read config | `get_vard`: `revision`, manual `items` + `folderRules` |
| Preview the result | `get_vard` with `resolved: true` |
| Change rules or name | `update_vard`: original `expectedRevision` + the fields you send |
| Replace manual mappings | `replace_vard_items`: original `expectedRevision` + manual list; rules stay |

- Never copy resolved folder outputs into `replace_vard_items`.
- Replacement items require `id` and an explicit nullable `versionId`; follow
  the guarded editing contract below.

## Guarded editing

Published MCP **0.4.2** retains the [0.8 client release](../client-release-0.8.md)
editor contract and publishes help for output recipes. See
[0.8.3 publication evidence and upgrade order](../client-release-0.8.3.md#upgrade-order).

MCP 0.4.2 requires `vardEditRevision: 1` for editable Vard reads and mutations.
It uses dedicated `/editor` routes and refuses unsupported servers or missing
endpoints without a legacy fallback. The separate `resolved: true` preview
has no editor revision.

Background, safe-area, SVG layer/adaptive-color and v2 renderer recipes also need
the matching API and worker implementation. `vardEditRevision: 1` establishes
guarded editing only; installing MCP 0.4.2 does not add server rendering support.

Read `get_vard` first and retain the full manual-only definition and `revision`.
Pass that **original** token as `expectedRevision` for update, replacement or
deletion. For example, after reading the definition:

```json
{
  "workspaceId": "your-workspace-id",
  "vardId": "your-vard-id",
  "expectedRevision": "v1:<copy the original revision from get_vard>",
  "folderRules": [{ "sourcePrefix": "brand/", "outputPrefix": "assets/brand/" }]
}
```

Replace the illustrative token with the unchanged revision from your read.
Keep the returned definition and revision after a successful write for the next
edit. Updates preserve omitted fields; `folderRules: []` removes rules.

Whole-list replacements must retain existing manual `id` values, or use `null`
for a new mapping. Each item explicitly supplies `versionId`: copy literal
`pinnedVersionId` from `get_vard`, including an unavailable saved pin or `null`
to follow latest. Do not infer the pin from a resolved delivery version. Pinned
items are read-only; the old `pinned` boolean and missing `id`/`versionId` are
rejected. Include only manual mappings; omitting one removes it. Also supply
`assetId`, `outputPath`, `writable` and nullable `transformation` for each item.

A conflict returns a structured tool error (`isError: true`) with `status: 409`,
`code: "vard_revision_conflict"`, `currentRevision` and a reload instruction.
Keep the intended edit, read `get_vard` again, review the latest definition and
reapply it. Never automatically retry the stale list with a fresh token.
Updates/replacements require API read + update permission; deletion requires
delete permission. The revision is an opaque equality token, not a counter.
See the [tool reference](../../apps/mcp/README.md#guarded-editing)
and [editor protocol](../vard-editor-concurrency.md).

## Not available to agents

Creating workspaces, members, API keys and domains needs a signed-in session in
the app.

Full reference: [MCP README](../../apps/mcp/README.md).
