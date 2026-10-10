import { candidateComposeArgs } from "./server-candidate.mjs";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { run } from "./release-packages.mjs";

export async function checkResourceBudgets({
  base,
  cookie,
  workspaceId,
  assetId,
}) {
  const project = process.env.SMOKE_COMPOSE_PROJECT;
  assert.match(project ?? "", /^vardum-smoke-\d+$/);
  const compose = (...args) =>
    run(
      "docker",
      [
        "compose",
        "--env-file",
        "/dev/null",
        "-p",
        project,
        "-f",
        process.env.SMOKE_COMPOSE_FILE ?? "compose.production.yml",
        ...candidateComposeArgs(args),
      ],
      { timeout: 60_000 },
    );
  const sql = (query, ...variables) =>
    compose(
      "exec",
      "-T",
      "postgres",
      "psql",
      "-X",
      "-U",
      "varda",
      "-d",
      "varda",
      "-v",
      "ON_ERROR_STOP=1",
      ...variables.flatMap(([key, value]) => ["-v", `${key}=${value}`]),
      "-c",
      query,
    );
  const api = async (path, body) => {
    const response = await fetch(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { cookie, origin: base, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.ok(
      response.ok,
      `${path}: ${response.status} ${await response.clone().text()}`,
    );
    return response.json();
  };
  const target = await api(`/api/workspaces/${workspaceId}/assets`, {
    key: "budget-expired",
    displayName: "Expired upload fixture",
  });
  const bytes = new Blob(["not finalized"], { type: "image/png" });
  const version = await api(
    `/api/workspaces/${workspaceId}/assets/${target.id}/versions`,
    { filename: "pending.png", mimeType: bytes.type, size: bytes.size },
  );
  const form = new FormData();
  for (const [name, value] of Object.entries(version.upload.fields))
    form.append(name, value);
  form.append("file", bytes, "pending.png");
  assert.ok(
    (await fetch(version.upload.url, { method: "POST", body: form })).ok,
  );
  assert.ok(new Date(version.expiresAt).getTime() > Date.now());
  // IDs are generated UUIDs from this isolated fixture, never user-provided SQL.
  assert.match(version.id, /^[a-f0-9-]{36}$/);
  await sql(
    `UPDATE asset_version SET created_at=now()-interval '2 days' WHERE id='${version.id}'`,
  );
  await compose(
    "exec",
    "-T",
    "api",
    "node",
    "--input-type=module",
    "-e",
    `
    const {cleanupPendingUploads}=await import('./dist/upload-lifecycle.js');
    const {storage,headObject}=await import('./dist/storage.js');
    const {closeDatabase}=await import('./dist/db/index.js');
    try {
      await cleanupPendingUploads();
      let absent=false;
      try { await headObject(${JSON.stringify(`originals/${workspaceId}/${target.id}/${version.id}/source`)}); }
      catch(error) { if(error.$metadata?.httpStatusCode===404) absent=true; else throw error; }
      if(!absent) throw new Error('Expired upload object was retained');
    } finally { storage.destroy(); await closeDatabase(); }
  `,
  );
  const late = await fetch(
    `${base}/api/workspaces/${workspaceId}/assets/${target.id}/versions/${version.id}/finalize`,
    { method: "POST", headers: { cookie, origin: base } },
  );
  assert.equal(late.status, 409);
  assert.equal(
    (await api(`/api/workspaces/${workspaceId}/assets/${assetId}`)).status,
    "ready",
  );

  const signed = await api(
    `/api/workspaces/${workspaceId}/assets/${assetId}/transform-url`,
    { w: 31, format: "png" },
  );
  // A second DB session represents other API replicas occupying both slots.
  await compose(
    "exec",
    "-T",
    "api",
    "node",
    "--input-type=module",
    "-e",
    `
    const {pool,closeDatabase}=await import('./dist/db/index.js');
    const {config}=await import('./dist/config.js');
    const client=await pool.connect();
    try {
      for(let i=0;i<config.TRANSFORM_CONCURRENCY;i++) await client.query('SELECT pg_advisory_lock(74121,$1)',[i]);
      const response=await fetch(${JSON.stringify(new URL(signed.url, "http://127.0.0.1:3000").href)}, {headers:{cookie:${JSON.stringify(cookie)}}});
      if(response.status!==503 || response.headers.get('retry-after')!=='1') throw new Error('Transform admission did not reject saturation: '+response.status);
      await response.arrayBuffer();
    } finally { await client.query('SELECT pg_advisory_unlock_all()'); client.release(); await closeDatabase(); }
  `,
  );
  const after = await fetch(new URL(signed.url, base), { headers: { cookie } });
  assert.equal(after.status, 200);
  await after.arrayBuffer();

  // Small admission burst, not a throughput/capacity certification.
  const requests = await Promise.all(
    Array.from({ length: 200 }, async () => {
      const began = performance.now();
      const response = await fetch(`${base}/w/smoke/logo`, {
        redirect: "manual",
        headers: { cookie },
      });
      await response.arrayBuffer();
      return { status: response.status, ms: performance.now() - began };
    }),
  );
  assert.ok(
    requests.every((x) => [302, 429, 503].includes(x.status)),
    JSON.stringify(requests),
  );
  assert.ok(
    requests.some((x) => x.status === 429 || x.status === 503),
    "burst must encounter configured admission limits",
  );
  assert.equal((await fetch(`${base}/health`)).status, 200);
  const sorted = requests.map((x) => x.ms).sort((a, b) => a - b);
  console.log(
    `Resource budget smoke passed: expired RustFS object removed; ready version retained; cross-session transform saturation recovered; 200-request burst rejected ${requests.filter((x) => x.status !== 302).length}, p95 ${Math.round(sorted[189])}ms (tiny fixture, not production capacity).`,
  );
  // Exercise real encoders with a synthetic 4 MP photograph-like input, rather
  // than reporting the tiny SVG request burst as a transform capacity result.
  const sharp = createRequire(
    new URL("../apps/api/package.json", import.meta.url),
  )("sharp");
  const raster = await sharp(randomBytes(2048 * 2048 * 3), {
    raw: { width: 2048, height: 2048, channels: 3 },
  })
    .jpeg({ quality: 85 })
    .toBuffer();
  const rasterAsset = await api(`/api/workspaces/${workspaceId}/assets`, {
    key: "budget-raster",
    displayName: "Resource fixture",
  });
  const rasterVersion = await api(
    `/api/workspaces/${workspaceId}/assets/${rasterAsset.id}/versions`,
    { filename: "noise.jpg", mimeType: "image/jpeg", size: raster.length },
  );
  const rasterForm = new FormData();
  for (const [name, value] of Object.entries(rasterVersion.upload.fields))
    rasterForm.append(name, value);
  rasterForm.append(
    "file",
    new Blob([raster], { type: "image/jpeg" }),
    "noise.jpg",
  );
  const rasterUpload = await fetch(rasterVersion.upload.url, {
    method: "POST",
    body: rasterForm,
  });
  assert.ok(
    rasterUpload.ok,
    `Raster upload (${raster.length} bytes): ${rasterUpload.status} ${await rasterUpload.text()}`,
  );
  await api(
    `/api/workspaces/${workspaceId}/assets/${rasterAsset.id}/versions/${rasterVersion.id}/finalize`,
    {},
  );
  const deadline = Date.now() + 60_000;
  let state;
  do {
    state = await api(
      `/api/workspaces/${workspaceId}/assets/${rasterAsset.id}`,
    );
    if (state.status === "ready") break;
    await new Promise((yes) => setTimeout(yes, 250));
  } while (Date.now() < deadline);
  assert.equal(state.status, "ready");
  const urls = await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      api(
        `/api/workspaces/${workspaceId}/assets/${rasterAsset.id}/transform-url`,
        { w: 1024 + index, format: "webp" },
      ),
    ),
  );
  const latency = await Promise.all(
    urls.map(async ({ url }) => {
      const began = performance.now();
      const response = await fetch(new URL(url, base), { headers: { cookie } });
      const bytes = await response.arrayBuffer();
      assert.ok(
        [200, 503].includes(response.status),
        `${response.status}: ${Buffer.from(bytes).toString()}`,
      );
      if (response.ok) assert.ok(bytes.byteLength > 1000);
      return { status: response.status, ms: performance.now() - began };
    }),
  );
  const accepted = latency
    .filter((x) => x.status === 200)
    .map((x) => x.ms)
    .sort((a, b) => a - b);
  assert.ok(accepted.length >= 2);
  const peak = await compose(
    "exec",
    "-T",
    "api",
    "node",
    "--input-type=module",
    "-e",
    `
    import {readFileSync} from 'node:fs';
    const paths=['/sys/fs/cgroup/memory.peak','/sys/fs/cgroup/memory/memory.max_usage_in_bytes'];
    for(const path of paths) { try { console.log(readFileSync(path,'utf8').trim()); break; } catch {} }
  `,
  );
  console.log(
    `Synthetic 4 MP transform burst: ${accepted.length}/12 completed, ${12 - accepted.length} bounded rejections; successful p95 ${Math.round(accepted[Math.ceil(accepted.length * 0.95) - 1])}ms; API container peak ${peak.stdout.trim() ? Math.round(Number(peak.stdout.trim()) / 1024 ** 2) + " MiB" : "unavailable"}. Peak includes earlier smoke steps; size/codec-specific, not a production SLO.`,
  );
  // Allow the fixed-size token bucket to refill before independent smoke checks.
  await new Promise((yes) => setTimeout(yes, 1100));
}
