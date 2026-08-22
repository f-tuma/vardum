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
export MINIO_ROOT_USER="vardum"
export MINIO_ROOT_PASSWORD="smoke-storage-password"
export S3_BUCKET="varda"
export SMTP_HOST=""
export SMTP_FROM=""
export VARDUM_VERSION="smoke"
compose=(docker compose -p "$project" -f compose.production.yml)

cleanup() {
  status=$?
  if (( status != 0 )); then
    "${compose[@]}" ps -a
    "${compose[@]}" logs --no-color
  fi
  "${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT

"${compose[@]}" up -d --build --wait --wait-timeout 180
curl --fail --silent "${APP_URL}/health" >/dev/null
curl --fail --silent "${APP_URL}/ready" >/dev/null
curl --fail --silent "${APP_URL}/" >/dev/null

SMOKE_URL="$APP_URL" node <<'NODE'
const base = process.env.SMOKE_URL;
let cookie = "";

async function request(path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      origin: base,
      ...(cookie ? { cookie } : {}),
      ...(options.headers ?? {}),
    },
  });
  if (!response.ok) throw new Error(`${options.method ?? "GET"} ${path}: ${response.status} ${await response.text()}`);
  return response;
}

const signup = await request("/api/auth/sign-up/email", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    name: "Smoke Test",
    email: "smoke@example.com",
    password: "password123",
  }),
});
cookie = signup.headers.getSetCookie()[0].split(";", 1)[0];
const workspace = await request("/api/auth/organization/create", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "Smoke", slug: "smoke" }),
}).then((response) => response.json());
const asset = await request(`/api/workspaces/${workspace.id}/assets`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ key: "logo", displayName: "Logo" }),
}).then((response) => response.json());
const svg = new Blob([
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 60"><rect width="120" height="60" fill="purple"/></svg>',
], { type: "image/svg+xml" });
const version = await request(`/api/workspaces/${workspace.id}/assets/${asset.id}/versions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ filename: "logo.svg", mimeType: svg.type, size: svg.size }),
}).then((response) => response.json());
const preflight = await fetch(version.upload.url, {
  method: "OPTIONS",
  headers: {
    origin: base,
    "access-control-request-method": "POST",
    "access-control-request-headers": "content-type",
  },
});
if (!preflight.ok || !preflight.headers.get("access-control-allow-origin")) {
  throw new Error(`Storage CORS preflight: ${preflight.status}`);
}
const form = new FormData();
for (const [key, value] of Object.entries(version.upload.fields)) form.append(key, value);
form.append("file", svg, "logo.svg");
const upload = await fetch(version.upload.url, { method: "POST", body: form });
if (!upload.ok) throw new Error(`Storage upload: ${upload.status} ${await upload.text()}`);
await request(`/api/workspaces/${workspace.id}/assets/${asset.id}/versions/${version.id}/finalize`, { method: "POST" });

let ready;
for (let attempt = 0; attempt < 40; attempt++) {
  ready = await request(`/api/workspaces/${workspace.id}/assets/${asset.id}`).then((response) => response.json());
  if (ready.status === "ready") break;
  if (ready.status === "failed") throw new Error(ready.error ?? "Ingest failed");
  await new Promise((resolve) => setTimeout(resolve, 250));
}
if (ready?.status !== "ready") throw new Error("Ingest timed out");
const delivered = await fetch(`${base}/w/smoke/logo`);
if (!delivered.ok || !delivered.headers.get("content-type")?.startsWith("image/svg+xml")) {
  throw new Error(`Delivery failed: ${delivered.status} ${delivered.headers.get("content-type")}`);
}
console.log("Production smoke test passed");
NODE
