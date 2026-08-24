# Changelog

All notable changes to Vardum are documented here.

## Unreleased

### Added

- Restore any ready version of an asset from its version history.
- Import objects that are already in the bucket from an S3 prefix.
- OpenAPI 3 document at `/api/openapi.json`, generated from the route schemas.
- Per-asset delivery figures and a transform cache ratio.
- `vardum status` and `--json` output for CI.
- `vardum login`: browser authorization that stores a scoped workspace key.
- Video assets: MP4, WebM, MOV, AVI and MPEG are stored and delivered as-is.
- `vardum whoami` and `vardum version`; `push-folder` shows a per-file plan,
  an upload counter and asks before deleting remote assets.
- Upload progress in the dashboard queue.
- `@vardum/mcp`: 25 tools for assets, Vards, workspaces, members, keys and
  domains, with a README and `--version` / `--help`.

### Fixed

- Videos opened directly now play: the delivery CSP allowed no media source.
- Custom domains verify on the TXT record alone — a domain proxied through
  Cloudflare answers with flattened A records, so its CNAME is never visible.
- Signed transformations of a video answer 415 instead of failing with 502.
- An invitation whose email cannot be sent no longer answers 500 and leaves a
  pending invitation that blocks re-inviting.
- `SMTP_PORT=465` without `SMTP_SECURE=true` is rejected at startup instead of
  hanging on every send.
- `vardum status` reports locally edited files instead of refusing to run, and
  a bad flag prints an error instead of a stack trace.
- The MCP server defaulted to a host that is not Vardum, so a setup with only
  `VARDUM_API_KEY` reached nothing.

### Changed

- Wire types and the accepted-format tables moved to `@vardum/shared`, which is
  published because the CLI and the MCP server import it at runtime.

`vardum login` needs this server release; against an older instance the browser
opens a page that does not exist. Published as `@vardum/cli` 0.5.0 and
`@vardum/mcp` 0.1.0, with `@vardum/shared` 0.1.0 alongside them — release all
three with `pnpm -r publish`.

## [0.1.0] - 2026-08-22

### Added

- Multi-organization accounts with organization-wide roles and multiple workspaces.
- Immutable asset versions, virtual folders and stable delivery URLs.
- Presigned S3 uploads, asynchronous image ingest and derived transformations.
- SVG validation and safe rasterization for transformed delivery.
- Workspace API keys with read and write scopes.
- SMTP invitations, password recovery and session management.
- Verified custom domains and 30-day delivery analytics.
- Production Compose stack with PostgreSQL, MinIO, migrations, API, worker and nginx.
- Backup, restore and upgrade documentation.

[0.1.0]: https://github.com/frgtn-dot-dev/vardum/releases/tag/v0.1.0
