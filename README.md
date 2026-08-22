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
