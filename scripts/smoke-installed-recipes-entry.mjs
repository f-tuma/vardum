// Narrow proof for the exact downloaded release; never packs or chooses latest.
import assert from "node:assert/strict";
import { lstat, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { checkInstalledRecipes } from "./smoke-installed-recipes.mjs";
import { validateRelease, verifyPublishedRelease, withInstalledRelease } from "./release-packages.mjs";

let phase = "prerequisites";
try {
  const registryMode = process.env.SMOKE_RECIPE_REGISTRY;
  assert.ok(registryMode === "candidate" || registryMode === "public");
  assert.ok(process.env.SMOKE_RELEASE_DIR);
  assert.notEqual(process.env.SMOKE_PUBLIC_CLIENTS, "1");
  assert.ok(!process.env.SMOKE_SERVER_CANDIDATE);
  const releaseDir = resolve(process.env.SMOKE_RELEASE_DIR);
  const release = await validateRelease(releaseDir);
  const files = ["release.json", ...release.packages.map(pkg => pkg.file)].sort();
  assert.deepEqual((await readdir(releaseDir)).sort(), files);
  for (const file of files) assert.ok((await lstat(join(releaseDir, file))).isFile());
  const url = new URL(process.env.SMOKE_URL);
  assert.equal(url.protocol, "http:");
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  assert.equal(url.pathname, "/");
  assert.ok(!url.username && !url.password && !url.search && !url.hash);
  assert.match(process.env.SMOKE_COMPOSE_PROJECT ?? "", /^vardum-smoke-\d+$/);
  const base = url.origin;
  let cookie = "";
  async function request(path, body) {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { origin: base, "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });
    assert.ok(response.ok, "Recipe fixture bootstrap request failed");
    return response;
  }
  phase = "disposable fixture bootstrap";
  const signup = await request("/api/auth/sign-up/email", {
    name: "Recipe Smoke", email: "recipe-smoke@example.com", password: "password123",
  });
  cookie = signup.headers.getSetCookie()[0].split(";", 1)[0];
  const organization = await (await request("/api/auth/organization/create", {
    name: "Recipe Smoke", slug: "recipe-smoke-org",
  })).json();
  const workspace = await (await request(`/api/organizations/${organization.id}/workspaces`, {
    name: "Recipe Smoke", slug: "recipe-smoke",
  })).json();
  const secondary = await (await request(`/api/organizations/${organization.id}/workspaces`, {
    name: "Recipe Smoke Secondary", slug: "recipe-smoke-secondary",
  })).json();
  phase = `${registryMode} installed recipe proof`;
  const proof = installed => checkInstalledRecipes(installed, {
    base, cookie, workspaceId: workspace.id, otherWorkspaceId: secondary.id,
  });
  if (registryMode === "candidate") await withInstalledRelease(releaseDir, proof);
  else await verifyPublishedRelease(releaseDir, proof);
  console.log(`Exact downloaded ${registryMode} release: installed recipe proof passed`);
} catch (error) {
  // The callback exposes only a fixed phase label, never its original cause.
  if (/^Installed recipe verification failed during [a-zA-Z0-9 /-]+$/.test(error?.message ?? ""))
    console.error(error.message);
  // Never dump bootstrap cookies, client credentials, or signed output URLs.
  console.error(`Installed recipe entry failed during ${phase}`);
  process.exitCode = 1;
}
