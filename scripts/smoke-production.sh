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
export SMOKE_COMPOSE_FILE="${SMOKE_COMPOSE_FILE:-$PWD/compose.production.yml}"
startup=(--build)
if [[ -n "${SMOKE_SERVER_CANDIDATE:-}" ]]; then
  export SMOKE_SERVER_CANDIDATE="$(realpath -s "$SMOKE_SERVER_CANDIDATE")"
  export SMOKE_COMPOSE_FILE="$SMOKE_SERVER_CANDIDATE/compose.production.yml"
  export SMOKE_PUBLIC_CLIENTS=1
  candidate_options=(--expected-commit "$(git rev-parse HEAD)")
  if [[ "${SMOKE_ALLOW_DIRTY_CANDIDATE:-}" == 1 ]]; then candidate_options+=(--allow-dirty); fi
  # Validation and collision checks finish before load or any Compose mutation.
  # Unique saved tags are used verbatim; never rebuild vardum-api:smoke.
  node scripts/server-candidate.mjs load "$SMOKE_SERVER_CANDIDATE" "${candidate_options[@]}"
  startup=(--no-build --pull never)
else
  # Isolate normal smoke tags across concurrent disposable builds.
  export VARDUM_VERSION="$project"
fi
compose=(docker compose --env-file /dev/null -p "$project" -f "$SMOKE_COMPOSE_FILE")
# The bundled object store is a profile, so it gets its own command line. The
# app services must be waited on without it: `up --wait` aborts when any
# container in the wait set has exited, and rustfs-init always has.
storage=(docker compose --env-file /dev/null -p "$project" --profile rustfs -f "$SMOKE_COMPOSE_FILE")
temporary_release=""

cleanup() {
  status=$?
  if ((status != 0)); then
    "${compose[@]}" ps -a
    "${compose[@]}" logs --no-color
  fi
  # Also own the recovery drill's independent target if its Node process exits early.
  docker compose --env-file /dev/null -p "${project}-restore" --profile rustfs -f "$SMOKE_COMPOSE_FILE" \
    down -v --remove-orphans >/dev/null 2>&1 || true
  "${storage[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  if [[ -n "$temporary_release" ]]; then rm -rf "$temporary_release"; fi
  exit "$status"
}
trap cleanup EXIT

# Test the same archives that the release workflow will publish. Standalone
# smoke runs prepare their own disposable candidate archives.
if [[ "${SMOKE_PUBLIC_CLIENTS:-}" == 1 ]]; then
  unset SMOKE_RELEASE_DIR
elif [[ -z "${SMOKE_RELEASE_DIR:-}" ]]; then
  temporary_release="$(mktemp -d)"
  export SMOKE_RELEASE_DIR="$temporary_release"
  node scripts/release-packages.mjs pack "$SMOKE_RELEASE_DIR"
else
  node scripts/release-packages.mjs check "$SMOKE_RELEASE_DIR"
fi

# The bundled object store comes up first: `up --wait` treats a one-shot
# container finishing mid-start as an early exit, so the bucket is created
# before the app services are waited on.
"${storage[@]}" up -d "${startup[@]}" --wait --wait-timeout 120 rustfs
if [[ -n "${SMOKE_SERVER_CANDIDATE:-}" ]]; then
  "${storage[@]}" run --pull never --rm rustfs-init
else
  "${storage[@]}" run --rm rustfs-init
fi

# Start Docker compose
"${compose[@]}" up -d "${startup[@]}" --wait --wait-timeout 180
if [[ -n "${SMOKE_SERVER_CANDIDATE:-}" ]]; then
  node scripts/server-candidate.mjs running "$SMOKE_SERVER_CANDIDATE" --project "$project" --expected-commit "$(git rev-parse HEAD)"
fi

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
    console.log(`Deployed native codec versions: ${JSON.stringify(sharp.versions)}`);
    function requirePatchedVersion(name, minimum) {
      const version = sharp.versions[name];
      if (typeof version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
        throw new Error(`Missing or invalid stable semantic version for ${name}: ${version}`);
      }
      const actual = version.split(".").map(BigInt);
      const required = minimum.split(".").map(BigInt);
      for (let index = 0; index < required.length; index++) {
        if (actual[index] > required[index]) return;
        if (actual[index] < required[index]) throw new Error(`Deployed ${name} ${version} is below security floor ${minimum}`);
      }
    }
    requirePatchedVersion("sharp", "0.35.5");
    requirePatchedVersion("rsvg", "2.63.2");
    requirePatchedVersion("heif", "1.23.5");
    const svg = Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"16\" height=\"8\"><rect width=\"16\" height=\"8\" fill=\"red\"/></svg>");
    const png = await sharp(svg, { limitInputPixels: 100_000_000 }).resize({ width: 8 }).png().toBuffer();
    const svgPixels = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    if (svgPixels.info.width !== 8 || svgPixels.info.height !== 4 || svgPixels.data.length !== 8 * 4 * svgPixels.info.channels || svgPixels.data[0] < 180 || svgPixels.data[1] > 60 || svgPixels.data[2] > 60) throw new Error("Deployed SVG rasterize/decode check failed");
    console.log("Deployed SVG rasterize/decode passed");
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

# Bind runtime evidence to the actual images under acceptance. Reports and the
# database snapshot deliberately survive disposable stack cleanup for review.
runtime_report="${SMOKE_IMAGE_REPORT_DIR:-$(mktemp -d)/runtime}"
node scripts/check-runtime-images.mjs "$project" "$runtime_report"

# Exercise Dokploy's baked routing template, independently of a Git checkout
# mount, against the same API and built web bundle used above.
if [[ -n "${SMOKE_SERVER_CANDIDATE:-}" ]]; then
  dokploy_image="$(node scripts/server-candidate.mjs image "$SMOKE_SERVER_CANDIDATE" --role gateway-dokploy "${candidate_options[@]}")"
else
  docker build --target dokploy -f docker/gateway.Dockerfile \
    --build-arg "VITE_UPLOAD_ORIGINS=$S3_PUBLIC_ENDPOINT" \
    --tag "vardum-dokploy-gateway:$project" .
  dokploy_image="$(docker image inspect --format '{{.Id}}' "vardum-dokploy-gateway:$project")"
fi
gateway_image="$("${compose[@]}" images -q gateway | head -n 1)"
gateway_image="$(docker image inspect --format '{{.Id}}' "$gateway_image")"
api_image="$("${compose[@]}" images -q api | head -n 1)"
api_image="$(docker image inspect --format '{{.Id}}' "$api_image")"
node scripts/smoke-gateway-config.mjs "$gateway_image" "$api_image" \
  "$runtime_report/dokploy-gateway-config" "$dokploy_image"

# Cleanup is handled by trap
