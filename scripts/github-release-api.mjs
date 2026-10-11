import assert from "node:assert/strict";

export async function boundedBytes(response, maximumBytes) {
  const declared = response.headers.get("content-length");
  if (declared !== null) assert.ok(/^\d+$/.test(declared) && Number(declared) <= maximumBytes, "Response exceeds byte limit");
  assert.ok(response.body, "Missing response body");
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      assert.ok(length <= maximumBytes, "Response exceeds byte limit");
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, length);
  } finally {
    await reader.cancel();
  }
}

// GitHub authorization belongs only on api.github.com. Signed storage URLs
// never receive it, and are deliberately omitted from diagnostics/evidence.
export async function downloadGitHubBytes(path, maximumBytes, {
  token, fetchImpl = fetch, kind = "artifact",
} = {}) {
  assert.ok(token, "A GitHub token is required");
  assert.match(path, /^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/|$)/);
  let response = await fetchImpl(`https://api.github.com${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: kind === "artifact" ? "application/vnd.github+json" : "application/octet-stream", "X-GitHub-Api-Version": "2022-11-28" },
    redirect: "manual", signal: AbortSignal.timeout(60_000),
  });
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const target = new URL(response.headers.get("location"));
    const hosts = kind === "artifact"
      ? [".blob.core.windows.net"] : [".blob.core.windows.net", "release-assets.githubusercontent.com"];
    assert.ok(target.protocol === "https:" && !target.username && !target.password && !target.port && !target.hash &&
      hosts.some(host => host.startsWith(".") ? target.hostname.endsWith(host) : target.hostname === host), "Unexpected GitHub download redirect");
    await response.body?.cancel();
    response = await fetchImpl(target.href, { redirect: "manual", signal: AbortSignal.timeout(60_000) });
  }
  assert.equal(response.status, 200, `GitHub download failed (${response.status})`);
  return boundedBytes(response, maximumBytes);
}

export function githubClient({ token = process.env.GH_TOKEN, fetchImpl = fetch } = {}) {
  assert.ok(token, "GH_TOKEN is required");
  return {
    async request(path, { method = "GET", body, allow404 = false } = {}) {
      assert.match(path, /^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/|$)/);
      const response = await fetchImpl(`https://api.github.com${path}`, {
        method, headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28", ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), redirect: "error", signal: AbortSignal.timeout(30_000),
      });
      if (allow404 && response.status === 404) { await response.body?.cancel(); return null; }
      assert.ok(response.ok, `GitHub API failed (${response.status})`);
      return JSON.parse((await boundedBytes(response, 2_000_000)).toString("utf8"));
    },
    download: (path, bytes, kind) => downloadGitHubBytes(path, bytes, { token, fetchImpl, kind }),
    async upload(repository, releaseId, name, bytes) {
      assert.match(repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
      assert.ok(Number.isSafeInteger(releaseId));
      const response = await fetchImpl(`https://uploads.github.com/repos/${repository}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`, {
        method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" },
        body: bytes, redirect: "error", signal: AbortSignal.timeout(60_000),
      });
      assert.ok(response.ok, `GitHub asset upload failed (${response.status})`);
      return JSON.parse((await boundedBytes(response, 2_000_000)).toString("utf8"));
    },
  };
}
