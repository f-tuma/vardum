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
