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
