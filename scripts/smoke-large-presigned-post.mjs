import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { createLargePostJpeg } from "./large-post-jpeg.mjs";
import { run } from "./release-packages.mjs";

export async function checkLargePresignedPost({ request, workspaceId, workspaceSlug }) {
  const project = process.env.SMOKE_COMPOSE_PROJECT;
  assert.match(project ?? "", /^vardum-smoke-\d+$/);
  const sharp = createRequire(
    new URL("../apps/api/package.json", import.meta.url),
  )("sharp");
  const bytes = await createLargePostJpeg(sharp);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const api = (path, body) => request(path, {
    method: body === undefined ? "GET" : "POST",
    ...(body === undefined ? {} : {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  }).then((response) => response.json());
  const asset = await api(`/api/workspaces/${workspaceId}/assets`, {
    key: "large-post-boundary.jpg",
    displayName: "Large presigned POST regression",
  });
  const version = await api(`/api/workspaces/${workspaceId}/assets/${asset.id}/versions`, {
    filename: "large-post-boundary.jpg",
    mimeType: "image/jpeg",
    size: bytes.length,
  });
  // Use the normal app grant and native FormData/fetch. No hand-built multipart,
  // different transport, or retry can mask the provider's multipart parser bug.
  const form = new FormData();
  for (const [name, value] of Object.entries(version.upload.fields))
    form.append(name, value);
  form.append("file", new Blob([bytes], { type: "image/jpeg" }), "large-post-boundary.jpg");
  const upload = await fetch(version.upload.url, { method: "POST", body: form });
  assert.ok(upload.ok, `Large POST (${bytes.length} bytes): ${upload.status} ${await upload.text()}`);

  // Read the original through the deployed API's actual storage connection
  // before finalization, so a truncated/changed object cannot pass on metadata.
  const storageKey = `originals/${workspaceId}/${asset.id}/${version.id}/source`;
  await run("docker", [
    "compose", "--env-file", "/dev/null", "-p", project, "-f", "compose.production.yml",
    "exec", "-T", "api", "node", "--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      import {createHash} from 'node:crypto';
      const {getObject,storage}=await import('./dist/storage.js');
      try {
        const object=await getObject(${JSON.stringify(storageKey)});
        assert.equal(object.ContentType,'image/jpeg');
        assert.equal(object.ContentLength,${bytes.length});
        const stored=await object.Body.transformToByteArray();
        assert.equal(createHash('sha256').update(stored).digest('hex'),${JSON.stringify(digest)});
      } finally { storage.destroy(); }
    `,
  ], { timeout: 60_000 });
  await api(`/api/workspaces/${workspaceId}/assets/${asset.id}/versions/${version.id}/finalize`, {});
  const deadline = Date.now() + 60_000;
  let state;
  do {
    state = await api(`/api/workspaces/${workspaceId}/assets/${asset.id}`);
    assert.notEqual(state.status, "failed", state.error ?? "Large JPEG ingest failed");
    if (state.status === "ready") break;
    await new Promise((yes) => setTimeout(yes, 250));
  } while (Date.now() < deadline);
  assert.equal(state.status, "ready", "Large JPEG ingest timed out");
  assert.equal(state.currentVersionId, version.id);
  assert.equal(state.mimeType, "image/jpeg");
  assert.equal(state.size, bytes.length);
  assert.equal(state.width, 2048);
  assert.equal(state.height, 2048);
  const delivery = await request(`/w/${workspaceSlug}/${asset.key}`);
  assert.ok(delivery.headers.get("content-type")?.startsWith("image/jpeg"));
  const delivered = Buffer.from(await delivery.arrayBuffer());
  assert.equal(createHash("sha256").update(delivered).digest("hex"), digest);
  const decoded = await sharp(delivered).raw().toBuffer({ resolveWithObject: true });
  assert.equal(decoded.info.width, 2048);
  assert.equal(decoded.info.height, 2048);
  assert.equal(decoded.info.channels, 3);
  assert.equal(decoded.data.length, 2048 * 2048 * 3);
  console.log(`Large presigned POST smoke passed: ${bytes.length}-byte 4 MP JPEG; native FormData, stored SHA-256, ingest and complete delivered-image decode.`);
}
