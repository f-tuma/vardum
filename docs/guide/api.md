# HTTP API

The app, the CLI and the MCP server all use this API. Your automation can too.

## OpenAPI

```sh
curl https://vardum.com/api/openapi.json
```

- Generated from the schemas the routes validate with, so it matches the
  running version.

## Authentication

```sh
curl "https://vardum.com/api/workspaces/$WORKSPACE/assets" \
  -H "x-api-key: $VARDUM_API_KEY"
```

| Key | Allows |
| --- | --- |
| `read` | List and read assets, Vards and private files |
| `write` | Also create, update, delete and publish |

- Create keys in **Settings → API keys**. One key, one workspace.
- `vardum login` creates one per machine: `cli@<machine>`.
- New keys: 10,000 requests per 60 seconds, private file requests included.
- Workspaces, members, keys and domains need a signed-in session, not a key.

## Endpoints worth knowing

| Endpoint | For |
| --- | --- |
| `GET /api/capabilities` | What this server supports |
| `GET /api/upload-limits` | Size ceilings per type |
| `PATCH /api/workspaces/{id}/assets/{assetId}/visibility` | Public or private |
| `POST /api/workspaces/{id}/imports` | Adopt objects already in the bucket |
| `GET /v/{vardId}` | A Vard's manifest |
| `GET /w/{workspace}/{key}` | Stable delivery URL ([Delivery](delivery.md)) |
| `GET /health`, `GET /ready` | Liveness; readiness incl. PostgreSQL |

Everything else, with request and response shapes, is in the OpenAPI document.
