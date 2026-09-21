// Production smoke test script
import { checkInstalledPackages } from "./smoke-installed-packages.mjs";
import { checkRustfsRecovery } from "./smoke-ingest-recovery.mjs";
import { checkBackupRestore } from "./smoke-backup-restore.mjs";

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
  if (!response.ok)
    throw new Error(
      `${options.method ?? "GET"} ${path}: ${response.status} ${await response.text()}`,
    );
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
const organization = await request("/api/auth/organization/create", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "Smoke", slug: "smoke-org" }),
}).then((response) => response.json());
const workspace = await request(
  `/api/organizations/${organization.id}/workspaces`,
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Smoke", slug: "smoke" }),
  },
).then((response) => response.json());
const secondary = await request(`/api/organizations/${organization.id}/workspaces`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "Smoke Secondary", slug: "smoke-secondary" }),
}).then((response) => response.json());
const directory = await request("/api/organizations").then((response) =>
  response.json(),
);
if (directory.organizations[0]?.workspaces.length !== 2) {
  throw new Error(
    `Multi-workspace directory failed: ${JSON.stringify(directory)}`,
  );
}
const asset = await request(`/api/workspaces/${workspace.id}/assets`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ key: "logo", displayName: "Logo" }),
}).then((response) => response.json());
const svg = new Blob(
  [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 60"><rect width="120" height="60" fill="purple"/></svg>',
  ],
  { type: "image/svg+xml" },
);
const version = await request(
  `/api/workspaces/${workspace.id}/assets/${asset.id}/versions`,
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      filename: "logo.svg",
      mimeType: svg.type,
      size: svg.size,
    }),
  },
).then((response) => response.json());
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
for (const [key, value] of Object.entries(version.upload.fields))
  form.append(key, value);
form.append("file", svg, "logo.svg");
const upload = await fetch(version.upload.url, { method: "POST", body: form });
if (!upload.ok)
  throw new Error(`Storage upload: ${upload.status} ${await upload.text()}`);
await request(
  `/api/workspaces/${workspace.id}/assets/${asset.id}/versions/${version.id}/finalize`,
  { method: "POST" },
);

let ready;
for (let attempt = 0; attempt < 40; attempt++) {
  ready = await request(
    `/api/workspaces/${workspace.id}/assets/${asset.id}`,
  ).then((response) => response.json());
  if (ready.status === "ready") break;
  if (ready.status === "failed")
    throw new Error(ready.error ?? "Ingest failed");
  await new Promise((resolve) => setTimeout(resolve, 250));
}
if (ready?.status !== "ready") throw new Error("Ingest timed out");
// New assets are private: anonymous denial and authorized delivery are both
// part of the production smoke, including the real limited database role.
const anonymous = await fetch(`${base}/w/smoke/logo`);
if (anonymous.status !== 401) {
  throw new Error(`Private anonymous delivery should fail: ${anonymous.status}`);
}
const delivered = await request("/w/smoke/logo");
if (
  !delivered.ok ||
  !delivered.headers.get("content-type")?.startsWith("image/svg+xml")
) {
  throw new Error(
    `Delivery failed: ${delivered.status} ${delivered.headers.get("content-type")}`,
  );
}
const overview = await request(`/api/workspaces/${workspace.id}/overview`).then(
  (response) => response.json(),
);
if (
  overview.delivery.requests30d !== 1 ||
  overview.delivery.days.length !== 30
) {
  throw new Error(
    `Delivery analytics failed: ${JSON.stringify(overview.delivery)}`,
  );
}

// Exercise the deployed native codecs and derived-object cache against real S3.
for (const format of ["avif", "jpeg", "png", "webp"]) {
  const signed = await request(
    `/api/workspaces/${workspace.id}/assets/${asset.id}/transform-url`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ w: 32, format }),
    },
  ).then((response) => response.json());
  const url = new URL(signed.url, base);
  const first = await request(`${url.pathname}${url.search}`);
  if (!first.headers.get("content-type")?.startsWith(`image/${format}`))
    throw new Error(`Incorrect transformed content type for ${format}`);
  const bytes = Buffer.from(await first.arrayBuffer());
  if (!bytes.length) throw new Error(`Empty transformed ${format}`);
  const cached = await request(`${url.pathname}${url.search}`);
  if (!bytes.equals(Buffer.from(await cached.arrayBuffer())))
    throw new Error(`Cached ${format} differs from generated bytes`);
}
const transformedOverview = await request(
  `/api/workspaces/${workspace.id}/overview`,
).then((response) => response.json());
if (
  transformedOverview.delivery.requests30d !== 9 ||
  transformedOverview.delivery.transformed30d !== 8 ||
  transformedOverview.delivery.cacheHitRatio !== 0.5
) {
  throw new Error(`Transform/cache analytics failed: ${JSON.stringify(transformedOverview.delivery)}`);
}
await checkInstalledPackages({ releaseDir: process.env.SMOKE_RELEASE_DIR, base, cookie, workspaceId: workspace.id, otherWorkspaceId: secondary.id });
await checkRustfsRecovery({ request, workspaceId: workspace.id, assetId: asset.id, currentVersionId: version.id, file: svg });
await checkBackupRestore({ base, cookie, workspaceId: workspace.id, otherWorkspaceId: secondary.id, assetId: asset.id, versionId: version.id });
console.log("Production smoke test passed");
