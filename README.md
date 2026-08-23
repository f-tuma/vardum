# Vardum

Developer-first digital asset manager for S3-compatible storage.

## Development

Requires Node.js 22+, pnpm, and Docker.

```sh
cp .env.example .env
pnpm install
pnpm dev
```

## Outbound email

Docker Compose starts Mailpit for local email capture. The default `.env.example`
sends SMTP to `localhost:1025`; inspect messages at <http://localhost:8025>.

For production, replace those values with your SMTP provider:

```env
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=vardum
SMTP_PASSWORD=replace-me
SMTP_FROM="Vardum <noreply@example.com>"
```

`SMTP_USER` and `SMTP_PASSWORD` are optional, but must be provided together.
Use `SMTP_SECURE=true` for implicit TLS (normally port 465); port 587
upgrades with STARTTLS when offered. Without `SMTP_HOST`, mail-dependent
features remain disabled.

## Production / self-hosting

The production stack includes PostgreSQL, MinIO, migrations, API, worker and a
static nginx web container:

```sh
cp .env.production.example .env.production
# Replace every secret and set the public APP_URL/S3_PUBLIC_ENDPOINT.
docker compose --env-file .env.production -f compose.production.yml up -d --build --wait
curl --fail http://localhost:8080/ready
```

`S3_PUBLIC_ENDPOINT` must be reachable by users' browsers. Keep
`POSTGRES_PASSWORD` URL-safe because it is embedded in `DATABASE_URL`. Database
migrations run once before the API and worker start. `/health` is the liveness
endpoint; `/ready` also verifies PostgreSQL.

Stop the stack without deleting data:

```sh
docker compose --env-file .env.production -f compose.production.yml down
```

Run the disposable fresh-install check with:

```sh
bash scripts/smoke-production.sh
```

Backup, restore and upgrade procedures are documented in
[`docs/operations.md`](docs/operations.md).

## Dokploy

Two further Compose files deploy the same stack on Dokploy, where Traefik
already terminates TLS:

| File                      | Use                                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------------------- |
| `compose.dokploy.yml`     | Production. Apex serves a separate marketing deployment; the app lives on `/app` of the same origin. |
| `compose.dokploy.dev.yml` | Branch deployment. No marketing site, so the dev domain opens the app directly.                      |

Copy `.env.dokploy.example` into the Dokploy environment editor and expose two
Domains: the app hostname on service `web` port 80, and the storage hostname on
service `minio` port 9000. The storage Domain must match `S3_PUBLIC_ENDPOINT`,
because browsers upload to it directly with a presigned POST.

In production the marketing site is its own Dokploy application, joined to
`dokploy-network` and given no Domain of its own. Point `MARKETING_UPSTREAM` at
its service alias; `docker/nginx.marketing.conf.template` proxies `/` there and
keeps `/api/*`, `/w/*` and the client's own routes on this stack. That template
lists the client routes explicitly — a route added to `apps/web/src/main.tsx`
and not to the template quietly serves the marketing 404.

## Organizations and workspaces

Organizations own members and roles and may contain multiple workspaces. Only
organization owners can create workspaces; editors and viewers inherit their
asset permissions across every workspace in the organization.

Organization creation is enforced by the API through `ORGANIZATION_CREATION`:
`allowlist` (recommended), `open`, or `disabled`. For `allowlist`, set a
comma-separated `ORGANIZATION_CREATOR_EMAILS`. Self-hosters can use `open` on a
trusted instance or allowlist the bootstrap administrator.

## Vards and CLI sync

A Vard is a project manifest assembled in the workspace UI. Each item maps an
asset to a repository-relative output path and may follow latest, pin a version,
or request a delivery transformation. Commit the generated `vardum.json`, then
use the Node.js CLI to pull the exact asset package in local development or CI.
Private Vards and push operations use `VARDUM_API_KEY`.

See [`apps/cli/README.md`](apps/cli/README.md) for setup, conflict handling,
lockfiles, safe deletion and bulk folder push.

## Custom domains

Set `CUSTOM_DOMAIN_TARGET` to the public hostname that routes delivery traffic
to Vardum. Workspace owners then configure a domain in Settings and add the
TXT challenge plus CNAME shown there. Only verified domains are used for host
routing; canonical `/w/{workspaceSlug}/{key}` URLs remain available.

TLS and DNS are intentionally handled by Cloudflare or your reverse proxy. The
proxy must preserve the original `Host` header.

## Delivery analytics

The Overview records successful `GET` content responses and shows a 30-day UTC
series for originals and transformations. These are response requests, not
proof that the client completed a download. Raw events are retained for 90 days
and removed daily by the worker.

## Security

Report vulnerabilities privately as described in [`SECURITY.md`](SECURITY.md).
Release history is available in [`CHANGELOG.md`](CHANGELOG.md).

## License

Vardum is released under the [MIT License](LICENSE).
