import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./smoke-production.sh", import.meta.url));

// Invalid release selections must fail before Compose can touch any stack. The
// Node wrapper executes the real archive checker, so a missing batch cannot be
// silently replaced by a freshly packed one.
test("recipe-only smoke rejects ambiguous or missing batches before Docker or packing", async () => {
  const root = await mkdtemp(join(tmpdir(), "vardum-recipe-gates-"));
  const bin = join(root, "bin");
  const nodeLog = join(root, "node.log"), dockerLog = join(root, "docker.log");
  try {
    await mkdir(bin);
    await mkdir(join(root, "empty"));
    await writeFile(join(bin, "node"), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$RECIPE_GATE_NODE_LOG"
exec "$RECIPE_GATE_REAL_NODE" "$@"
`, { mode: 0o755 });
    await writeFile(join(bin, "docker"), `#!/usr/bin/env bash
printf 'unexpected Docker call\\n' >> "$RECIPE_GATE_DOCKER_LOG"
exit 91
`, { mode: 0o755 });
    const base = {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: root,
      SMOKE_INSTALLED_RECIPES_ONLY: "1",
      SMOKE_RECIPE_REGISTRY: "candidate",
      SMOKE_RELEASE_DIR: join(root, "empty"),
      RECIPE_GATE_NODE_LOG: nodeLog,
      RECIPE_GATE_DOCKER_LOG: dockerLog,
      RECIPE_GATE_REAL_NODE: process.execPath,
    };
    const cases = [
      ["missing release directory", { SMOKE_RELEASE_DIR: "" }],
      ["missing registry selection", { SMOKE_RECIPE_REGISTRY: "" }],
      ["unknown registry selection", { SMOKE_RECIPE_REGISTRY: "latest" }],
      ["historical public-client fallback", { SMOKE_PUBLIC_CLIENTS: "1" }],
      ["server-candidate fallback", { SMOKE_SERVER_CANDIDATE: join(root, "candidate") }],
      ["nonexistent candidate batch", { SMOKE_RELEASE_DIR: join(root, "missing") }],
      ["empty candidate batch", { SMOKE_RELEASE_DIR: join(root, "empty") }],
      ["nonexistent public batch", { SMOKE_RECIPE_REGISTRY: "public", SMOKE_RELEASE_DIR: join(root, "missing") }],
    ];
    for (const [label, overrides] of cases) {
      await rm(nodeLog, { force: true });
      await rm(dockerLog, { force: true });
      const result = spawnSync("bash", [script], {
        env: { ...base, ...overrides }, encoding: "utf8", timeout: 10_000,
      });
      assert.equal(result.error, undefined, `${label}: ${result.error?.message}`);
      assert.notEqual(result.status, 0, `${label}: must reject`);
      await assert.rejects(readFile(dockerLog), { code: "ENOENT" }, `${label}: must not invoke Docker, including cleanup`);
      const commands = await readFile(nodeLog, "utf8").catch(error => {
        if (error.code === "ENOENT") return "";
        throw error;
      });
      assert.doesNotMatch(commands, /release-packages\.mjs pack|server-candidate\.mjs load|smoke-test\.js/, `${label}: no fallback`);
      if (label === "empty candidate batch") {
        assert.match(commands, /^scripts\/release-packages\.mjs check /, "Existing empty batch must reach the real checker");
      } else {
        assert.equal(commands, "", `${label}: selection guard must reject before archive commands`);
      }
      assert.equal(result.signal, null, `${label}: should fail with a bounded error`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
