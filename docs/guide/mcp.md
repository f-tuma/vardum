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
claude mcp add vardum --env VARDUM_API_KEY=varda_... -- npx -y @vardum/mcp@0.2.0
```

Claude Desktop, Cursor and other JSON configs:

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

The client starts the server; there is nothing to run by hand.

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
| Read config | `get_vard`: manual `items` + `folderRules` |
| Preview the result | `get_vard` with `resolved: true` |
| Change rules or name | `update_vard`: only the fields you send |
| Replace manual mappings | `replace_vard_items`: rules stay |

- Never copy resolved folder outputs into `replace_vard_items`.
- Pin with `versionId`; omit it to follow latest.

```json
{
  "workspaceId": "your-workspace-id",
  "vardId": "your-vard-id",
  "folderRules": [{ "sourcePrefix": "brand/", "outputPrefix": "assets/brand/" }]
}
```

## Not available to agents

Creating workspaces, members, API keys and domains needs a signed-in session in
the app.

Full reference: [MCP README](../../apps/mcp/README.md).
