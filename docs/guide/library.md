# Library

Getting files in, keeping their history, deciding who can read them.

## Upload

```text
1  client ──> api       signs an upload
2  client ──> bucket    bytes skip the server
3  worker ──> ready     SHA-256 checked
```

| From | How |
| --- | --- |
| App | Choose or drop files on the Assets page |
| CLI | `vardum push-folder <dir> [prefix]`; see [Upload from a project](push.md) |
| Agent | MCP `create_asset`, then `upload_asset_version` |

- Size ceilings per type: `GET /api/upload-limits`.
- A checksum declared up front (the CLI does) must match, or the upload fails.

## Versions

- A new upload to an existing asset adds a version.
- **Restore** on the asset page moves the current pointer back.
- Pinned projects keep their version. Projects on latest get the restored one
  at their next pull; stable URLs follow at once.

## Visibility

- New assets are private.
- Change it in the asset settings, with MCP `set_asset_visibility`, or:

```sh
curl -X PATCH "$SERVER/api/workspaces/$WORKSPACE/assets/$ASSET/visibility" \
  -H "x-api-key: $VARDUM_API_KEY" -H "content-type: application/json" \
  -d '{"isPublic": true}'
```

- Versions, checksums and locked URLs do not change.
- One private file in a public Vard hides the **whole** anonymous manifest.

## Import an existing bucket

- Assets page, **Import from S3**, or `POST /api/workspaces/{id}/imports`
  with a `source` prefix.
- Objects are **copied** in; deleting the asset never touches the original.
- One call = one page of the listing; pass `nextToken` for the next.
- Skipped: Vardum's own `originals/` and `derived/`, and names or types that
  cannot become an asset.

## Find files

- Assets, search and the Vard picker load in pages: **Load more**.
- Counts show loaded results, not the workspace total.
- Search matches file keys and folder paths.

Details: [browsing and its HTTP contract](../asset-browser.md).
