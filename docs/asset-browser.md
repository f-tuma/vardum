# Asset browsing and search

The Assets page, workspace search and Vard asset picker load folders and files
in pages. Use **Load more** to continue. Counts describe the loaded results,
not the total workspace size. The list view sorts the loaded files; its sort
controls do not reorder results that have not been loaded yet.

An unsuccessful next-page request leaves the loaded items visible. **Retry
loading more** requests the same continuation. **Refresh assets** starts a new
traversal from the first page. Opening a detail and returning through browser
Back or its Assets/folder breadcrumb retains the loaded pages while they remain
in the current browser session's cache. Search origins also retain the query.
The picker keeps its Added indicators as more files load; adding the same source
again is still allowed for another output variant.

Search matches file names/keys and folder paths, including nested empty folders
and folders implied by file keys. Opening a folder starts browsing that folder
and clears the workspace-wide search. Processing status refreshes while any
loaded page contains a processing asset.

## HTTP contract

The browser opts in with
`GET /api/workspaces/:workspaceId/assets?pagination=cursor&prefix=&limit=50`.
Optional parameters are `search` and `cursor`. The default limit is 50 and the
maximum is 100; the limit covers folders and assets together. The response is
`{ folders, assets, nextCursor }`. A null cursor means traversal is exhausted.
Legacy requests without `pagination=cursor` preserve their existing response;
the sync and MCP endpoints retain their separate contracts.

Candidates are ordered by folder first, then complete path/key and stable
identity using PostgreSQL's C collation. Folder paths are deduplicated before
the limit. The opaque signed cursor is bound to workspace, prefix, trimmed
search, limit and ordering version. Keep all those parameters unchanged when
continuing. Malformed, modified or out-of-scope cursors return 400; a cursor
without the opt-in mode also returns 400. Authorization and workspace RLS are
checked again on every request. A same-scope cursor can be reused for retries;
it is not an authorization token.

This is live keyset traversal, not a frozen snapshot. Insertions after the
cursor can appear; changes before it require Refresh. Deleting the cursor row
does not invalidate continuation. A forward rename can repeat an asset ID;
the UI keeps the latest value at its already-rendered position. Secret rotation
invalidates existing cursors; Refresh obtains a new first page.

Candidate selection and current/latest-version hydration share one SQL
statement snapshot. Materialized asset inputs bound hydration to consumed page
assets before latest-version lookups, independently of join order; the hydration
result is materialized once so rescans by the final page join reuse cached
rows without repeating metadata lookups.
Only consumed page assets receive latest-version lookups,
and asset-phase continuation skips folder derivation. Output is bounded; folder
derivation, search, deduplication, sorting and some scans may still scale with
workspace contents. This is not a claim of O(limit) database work.

The isolated PostgreSQL regression command is
`PG_BINDIR="$(pg_config --bindir)" pnpm --filter @vardum/api test:asset-pagination`.
It creates and removes its own cluster and never reads the development `.env`.
