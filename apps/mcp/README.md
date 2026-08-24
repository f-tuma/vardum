# @vardum/mcp

MCP server for [Vardum](https://vardum.com): lets an AI agent manage assets,
Vards, workspaces, members, API keys and custom domains through the same API
the dashboard and the CLI use.

## Setup

The server speaks MCP over stdio, so the client starts it — there is nothing to
run by hand. Create a workspace API key in **Settings // API keys** first; the
key carries the permissions of whoever created it.

Claude Code:

```sh
claude mcp add vardum --env VARDUM_API_KEY=varda_... -- npx -y @vardum/mcp
```

Any client that reads a JSON config (Claude Desktop, Cursor, …):

```json
{
  "mcpServers": {
    "vardum": {
      "command": "npx",
      "args": ["-y", "@vardum/mcp"],
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

Assets (`list_assets`, `create_asset`, `upload_asset_version`, `delete_asset`),
Vards (`list_vards`, `create_vard`, `get_vard`, `update_vard`, `delete_vard`,
`replace_vard_items`), workspaces (`list_organizations`, `create_workspace`,
`get_workspace`, `update_workspace`), members and invitations, API keys, and
custom domains (`get_domain`, `configure_domain`, `verify_domain`).

Images and video are accepted; video is stored and delivered as-is, and cannot
be resized or transformed into variants.
