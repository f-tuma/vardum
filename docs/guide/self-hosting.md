# Self-hosting

One Compose file, your database, your bucket. MIT licensed.

## What runs

```text
 browser · cli · mcp
  │                 │
  │ :8080           │ presigned POST
  ▼                 ▼
 ┌─ your server ┐  ┌─ your bucket ─┐
 │ gateway      │  │ originals/    │
 │ api ─────────┼─>│ derived/      │
 │ worker ──────┼─>│               │
 │ postgres     │  │               │
 └──────────────┘  └───────────────┘
```

| Service | Role |
| --- | --- |
| `gateway` | nginx on 8080: `/app/`, plus `/api`, `/w`, `/v` |
| `api` | Versions, Vards, signed delivery, transforms |
| `worker` | Checks uploads, prunes old delivery events |
| `postgres` | Data with row-level security, and the job queue |
| `migrate` | Prepares schema and roles, then exits |
| `rustfs` | Optional bundled bucket (`--profile rustfs`) |

## You need

- Docker with Compose.
- An S3-compatible bucket with presigned POST and CORS, reachable by browsers.
  Or bundled RustFS.
- A reverse proxy for TLS that passes the original `Host` header.
- SMTP, for verification, invitations and password recovery.

## Start

```sh
cp .env.production.example .env.production   # fill in secrets, bucket, APP_URL
docker compose --env-file .env.production -f compose.production.yml up -d --build --wait
curl --fail http://localhost:8080/ready
```

- Open `http://localhost:8080/app/`; the apex redirects there. App assets live
  under `/app/`, while API/auth and delivery URLs keep their root paths.
- Old root UI links, including `/cli-login?...`, redirect to `/app/` with their
  escaped path and query intact.
- `/health`: the API runs. `/ready`: also PostgreSQL.
- `down` (without `-v`) stops it and keeps data.

## Settings that matter

| Variable | Why |
| --- | --- |
| `APP_URL` | Public origin of the install, without `/app` |
| `BETTER_AUTH_SECRET` | Signs sessions |
| `TRANSFORM_SECRET` | Signs variant URLs; changing it breaks them |
| `POSTGRES_PASSWORD` | Administrator, runs migrations |
| `POSTGRES_APP_PASSWORD` | Runtime role; different, 24+ URL-safe chars |
| `S3_*` | Bucket, region, endpoints, a key scoped to the bucket |
| `S3_PUBLIC_ENDPOINT` | Must be reachable by browsers |
| `SMTP_*` | Mail; without it, mail features are off |
| `ORGANIZATION_CREATION` | `allowlist` (recommended), `open` or `disabled` |
| `CUSTOM_DOMAIN_TARGET` | For [custom domains](delivery.md#custom-domains) |

- Generate secrets with `openssl rand -hex 32`.
- Providers without virtual-hosted buckets: `S3_FORCE_PATH_STYLE=true`.
- Keep the bucket private.

## Bundled RustFS

```sh
compose="docker compose --env-file .env.production -f compose.production.yml"
$compose --profile rustfs up -d --wait rustfs   # 1. storage
$compose --profile rustfs run --rm rustfs-init  # 2. bucket, once
$compose up -d --build --wait                   # 3. the app
```

- Its root credentials are `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`.

## First administrator

With `ORGANIZATION_CREATION=allowlist`:

1. Put your email in `ORGANIZATION_CREATOR_EMAILS` and configure SMTP.
2. Sign up, open the verification link.
3. Create the organization and its first workspace.

## Next

- [Deploy with Dokploy](dokploy.md)
- [Operations](operations.md): backup, restore, upgrades, monitoring
- Disposable test install: `bash scripts/smoke-production.sh`
