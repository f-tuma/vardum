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
export POSTGRES_APP_PASSWORD="smoke-runtime-password-at-least-24-characters"
export BETTER_AUTH_SECRET="smoke-auth-secret-at-least-32-characters"
export TRANSFORM_SECRET="smoke-transform-secret-at-least-32-characters"
export MONITORING_TOKEN="smoke-monitoring-token-at-least-32-characters"
export ORGANIZATION_CREATION="open"
export ORGANIZATION_CREATOR_EMAILS=""
# The disposable check has no external bucket, so it runs the bundled RustFS.
export S3_ACCESS_KEY_ID="vardum"
export S3_SECRET_ACCESS_KEY="smoke-storage-password"
export S3_BUCKET="varda"
export S3_ENDPOINT="http://rustfs:9000"
export S3_FORCE_PATH_STYLE="true"
export SMTP_HOST=""
export SMTP_FROM=""
export VARDUM_VERSION="smoke"
compose=(docker compose -p "$project" -f compose.production.yml)
# The bundled object store is a profile, so it gets its own command line. The
# app services must be waited on without it: `up --wait` aborts when any
# container in the wait set has exited, and rustfs-init always has.
storage=(docker compose -p "$project" --profile rustfs -f compose.production.yml)
temporary_release=""

cleanup() {
  status=$?
  if ((status != 0)); then
    "${compose[@]}" ps -a
    "${compose[@]}" logs --no-color
  fi
  # Also own the recovery drill's independent target if its Node process exits early.
  docker compose -p "${project}-restore" --profile rustfs -f compose.production.yml \
    down -v --remove-orphans >/dev/null 2>&1 || true
  "${storage[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  if [[ -n "$temporary_release" ]]; then rm -rf "$temporary_release"; fi
  exit "$status"
}
trap cleanup EXIT

# Test the same archives that the release workflow will publish. Standalone
# smoke runs prepare their own disposable candidate archives.
if [[ -z "${SMOKE_RELEASE_DIR:-}" ]]; then
  temporary_release="$(mktemp -d)"
  export SMOKE_RELEASE_DIR="$temporary_release"
  node scripts/release-packages.mjs pack "$SMOKE_RELEASE_DIR"
else
  node scripts/release-packages.mjs check "$SMOKE_RELEASE_DIR"
fi

# The bundled object store comes up first: `up --wait` treats a one-shot
# container finishing mid-start as an early exit, so the bucket is created
# before the app services are waited on.
"${storage[@]}" up -d --wait --wait-timeout 120 rustfs
"${storage[@]}" run --rm rustfs-init

# Start Docker compose
"${compose[@]}" up -d --build --wait --wait-timeout 180

# Wait for services to be ready
curl --fail --silent "${APP_URL}/health" >/dev/null
curl --fail --silent "${APP_URL}/ready" >/dev/null
curl --fail --silent "${APP_URL}/" >/dev/null

# Run deployed checks, including the public npm first-project onboarding consumer.
SMOKE_URL="${APP_URL}" SMOKE_COMPOSE_PROJECT="$project" node "$(dirname "$0")/smoke-test.js"

# Probe the actual API connection from the deployed image, after creating data.
"${compose[@]}" exec -T api node --input-type=module -e '
  const { pool, closeDatabase } = await import("./dist/db/index.js");
  const { assertRuntimeDatabaseRole } = await import("./dist/db/runtime-role.js");
  try {
    const { default: sharp } = await import("sharp");
    const avif = await sharp({ create: { width: 16, height: 8, channels: 3, background: "red" } }).avif().toBuffer();
    const decoded = await sharp(avif).resize({ width: 8 }).raw().toBuffer({ resolveWithObject: true });
    if (decoded.info.width !== 8 || decoded.info.height !== 4 || decoded.data[0] < 180) throw new Error("Deployed AVIF codec check failed");
    console.log(`Deployed AVIF encode/decode passed: sharp ${sharp.versions.sharp}, libheif ${sharp.versions.heif}`);
    await assertRuntimeDatabaseRole(pool);
    const result = await pool.query("SELECT current_user AS role, (SELECT count(*)::int FROM public.asset) AS unscoped_assets");
    if (result.rows[0].role !== "varda_app" || result.rows[0].unscoped_assets !== 0) throw new Error("Deployed RLS role check failed");
    console.log("Deployed database role and unscoped RLS check passed");
  } finally { await closeDatabase(); }
'

# Cleanup is handled by trap
