#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
project="vardum-smoke-${GITHUB_RUN_ID:-$$}"
export WEB_PORT="${WEB_PORT:-18080}"
export S3_PORT="${S3_PORT:-19000}"
export S3_CONSOLE_PORT="${S3_CONSOLE_PORT:-19001}"
export APP_URL="http://localhost:${WEB_PORT}"
export S3_PUBLIC_ENDPOINT="http://localhost:${S3_PORT}"
export POSTGRES_PASSWORD="smoke-database-password"
export BETTER_AUTH_SECRET="smoke-auth-secret-at-least-32-characters"
export TRANSFORM_SECRET="smoke-transform-secret-at-least-32-characters"
export ORGANIZATION_CREATION="open"
export ORGANIZATION_CREATOR_EMAILS=""
export MINIO_ROOT_USER="vardum"
export MINIO_ROOT_PASSWORD="smoke-storage-password"
export S3_BUCKET="varda"
export SMTP_HOST=""
export SMTP_FROM=""
export VARDUM_VERSION="smoke"
compose=(docker compose -p "$project" -f compose.production.yml)

cleanup() {
  status=$?
  if ((status != 0)); then
    "${compose[@]}" ps -a
    "${compose[@]}" logs --no-color
  fi
  "${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT

# Build CLI before starting Docker compose
pnpm --filter @vardum/cli build

# Start Docker compose
"${compose[@]}" up -d --build --wait --wait-timeout 180

# Wait for services to be ready
curl --fail --silent "${APP_URL}/health" >/dev/null
curl --fail --silent "${APP_URL}/ready" >/dev/null
curl --fail --silent "${APP_URL}/" >/dev/null

# Run smoke test using separate ES module file
SMOKE_URL="${APP_URL}" node "$(dirname "$0")/smoke-test.js"

# Cleanup is handled by trap
