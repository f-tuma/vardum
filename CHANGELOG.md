# Changelog

All notable changes to Vardum are documented here.

## Unreleased

### Fixed

- Release verification waits for npm registry propagation before installing
  published packages; registry errors and integrity conflicts still fail immediately.

## [0.6.0] - 2026-09-20

### Added

- CLI 0.6.0: schema 2 snapshots and `pull --frozen` for reviewed CI
  builds, private asset delivery, and recursive Vard folder membership.
- Private-by-default assets and explicit publication; public manifests do not
  publish their member files. Folder-generated outputs remain read-only.
- Published CLI 0.6.0, MCP 0.2.0 and shared 0.2.0, with independently
  tested npm installs and production tests of the exact published archives.
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
- `@vardum/mcp`: 11 workspace-scoped asset and Vard tools, resources and
  `--version` / `--help`; administration stays in the web app.

### Fixed

- Prevent raw npm packing of source workspace dependencies. Releases publish
  checked pnpm archives in dependency order and verify registry integrity.
- MCP pins now send an exact `versionId`; the ineffective `pinned` boolean is
  rejected. Asset listing exposes pagination instead of silently stopping at 500.
- MCP no longer advertises session-only administration tools that always failed
  with workspace keys. The protocol handshake reports the package version.
- Updated sharp to 0.35.4 (including the libheif AVIF security fix), nodemailer
  to 9.1.1 and vulnerable transitive dependencies. CI and releases now check
  dependency advisories. Image regression checks cover every accepted input
  format, all four transform formats, caching and invalid uploads; the
  production smoke also verifies native AVIF support and RustFS transform caching.
- Production API and worker now use a dedicated `varda_app` PostgreSQL role;
  privileged connections are rejected at startup. The migration service owns
  schema changes and provisions runtime grants, including pg-boss permissions.
  Existing deployments must add a distinct `POSTGRES_APP_PASSWORD` and follow
  the database-role upgrade instructions in `docs/operations.md`.
- Delivery retention now deletes expired events within each workspace's RLS
  context, so cleanup continues under the limited runtime role.
- The production smoke checks authenticated private delivery and anonymous
  denial, matching the default visibility of newly uploaded assets.
- Organization creation in `allowlist` mode now requires a verified email as
  well as an allowlist entry. The app offers verification resend and status
  checks; missing SMTP never bypasses the restriction. Existing memberships
  remain available, and `open` retains its explicit all-accounts policy.
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
- The bundled object store is now RustFS instead of MinIO, whose community
  edition went into maintenance mode and was archived. The profile is renamed
  from `minio` to `rustfs`, the service and its volume along with it, and the
  bucket is created with the AWS CLI rather than `mc`. An external S3 provider
  stays the default and is unaffected. RustFS cannot read MinIO's on-disk
  format, so an existing bundled store must be mirrored out before the upgrade
  and back in afterwards — see `docs/operations.md`. Browsers upload straight
  to the store, so the stack now sets CORS at the server through
  `S3_CORS_ALLOWED_ORIGINS`: RustFS sends no CORS headers unless asked, and its
  `PutBucketCors` is not dependable yet.

`vardum login`, private delivery and folder rules require the matching server
release. CLI 0.6.0 / MCP 0.2.0 / shared 0.2.0 are published on npm.
The existing CLI 0.5.0 / MCP 0.1.0 artifacts cannot be overwritten;
see `docs/npm-release.md` for the release procedure and compatibility.

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

[0.6.0]: https://github.com/frgtn-dot-dev/vardum/releases/tag/v0.6.0
[0.1.0]: https://github.com/frgtn-dot-dev/vardum/releases/tag/v0.1.0
