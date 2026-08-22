# Vardum

Developer-first digital asset manager for S3-compatible storage.

## Development

Requires Node.js 22+, pnpm, and Docker.

```sh
cp .env.example .env
pnpm install
docker compose --profile storage up -d
pnpm --filter @vardum/api db:migrate
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
