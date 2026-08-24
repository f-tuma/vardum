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
# The disposable check has no external bucket, so it runs the bundled MinIO.
export S3_ACCESS_KEY_ID="vardum"
export S3_SECRET_ACCESS_KEY="smoke-storage-password"
export S3_BUCKET="varda"
export S3_ENDPOINT="http://minio:9000"
export S3_FORCE_PATH_STYLE="true"
export SMTP_HOST=""
export SMTP_FROM=""
export VARDUM_VERSION="smoke"
compose=(docker compose -p "$project" -f compose.production.yml)
# The bundled object store is a profile, so it gets its own command line. The
# app services must be waited on without it: `up --wait` aborts when any
# container in the wait set has exited, and minio-init always has.
storage=(docker compose -p "$project" --profile minio -f compose.production.yml)

cleanup() {
  status=$?
  if ((status != 0)); then
    "${compose[@]}" ps -a
    "${compose[@]}" logs --no-color
  fi
  "${storage[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT

# Build CLI before starting Docker compose
pnpm --filter "@vardum/cli..." build

# The bundled object store comes up first: `up --wait` treats a one-shot
# container finishing mid-start as an early exit, so the bucket is created
# before the app services are waited on.
"${storage[@]}" up -d --wait --wait-timeout 120 minio
"${storage[@]}" run --rm minio-init

# Start Docker compose
"${compose[@]}" up -d --build --wait --wait-timeout 180

# Wait for services to be ready
curl --fail --silent "${APP_URL}/health" >/dev/null
curl --fail --silent "${APP_URL}/ready" >/dev/null
curl --fail --silent "${APP_URL}/" >/dev/null

# Run smoke test using separate ES module file
SMOKE_URL="${APP_URL}" node "$(dirname "$0")/smoke-test.js"

# Cleanup is handled by trap
