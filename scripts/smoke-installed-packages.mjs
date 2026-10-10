import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { run, withInstalledRelease } from "./release-packages.mjs";

// All mutations belong to smoke-production's disposable Compose workspace.
// Binaries and the MCP client SDK resolve only from independent npm installs.
export async function checkInstalledPackages({
  releaseDir,
  base,
  cookie,
  workspaceId,
  otherWorkspaceId,
}) {
  await withInstalledRelease(releaseDir, async ({ root, cli, mcp }) => {
    async function api(path, body, method = "POST") {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { cookie, origin: base, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      assert.ok(
        response.ok,
        `${method} ${path}: ${response.status} ${await response.clone().text()}`,
      );
      return response.status === 204 ? null : response.json();
    }
    const key = async (access) =>
      (
        await api(`/api/workspaces/${workspaceId}/api-keys`, {
          name: `package-${access}`,
          access,
        })
      ).key;
    const writeKey = await key("write");
    const readKey = await key("read");
    const require = createRequire(
      join(mcp.cwd, "node_modules/@vardum/mcp/package.json"),
    );
    const { Client } = await import(
      pathToFileURL(
        require.resolve("@modelcontextprotocol/sdk/client/index.js"),
      )
    );
    const { StdioClientTransport } = await import(
      pathToFileURL(
        require.resolve("@modelcontextprotocol/sdk/client/stdio.js"),
      )
    );
    const clients = [];
    async function connect(apiKey) {
      const client = new Client({
        name: "installed-package-smoke",
        version: "1.0.0",
      });
      clients.push(client);
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [mcp.binary],
          cwd: mcp.cwd,
          env: { VARDUM_SERVER: base, VARDUM_API_KEY: apiKey },
          stderr: "pipe",
        }),
      );
      assert.equal(client.getServerVersion().version, mcp.version);
      return client;
    }
    try {
      const writer = await connect(writeKey);
      const reader = await connect(readKey);
      const expectedTools = [
        "list_assets",
        "create_asset",
        "upload_asset_version",
        "set_asset_visibility",
        "delete_asset",
        "list_vards",
        "create_vard",
        "get_vard",
        "update_vard",
        "delete_vard",
        "replace_vard_items",
      ].sort();
      assert.deepEqual(
        (await writer.listTools()).tools.map((tool) => tool.name).sort(),
        expectedTools,
      );
      for (const resource of (await writer.listResources()).resources) {
        assert.ok(
          (await writer.readResource({ uri: resource.uri })).contents.length,
        );
      }
      const exercised = new Set();
      async function tool(name, args = {}, client = writer) {
        const result = await client.callTool({
          name,
          arguments: { workspaceId, ...args },
        });
        assert.notEqual(
          result.isError,
          true,
          `${name}: ${JSON.stringify(result.content)}`,
        );
        exercised.add(name);
        const text = result.content[0].text;
        try {
          return JSON.parse(text);
        } catch {
          return text;
        }
      }
      const asset = await tool("create_asset", {
        key: "pkg/logo.svg",
        displayName: "Package logo",
      });
      assert.equal(asset.isPublic, false);
      const svg = (color) =>
        `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="16"><rect width="32" height="16" fill="${color}"/></svg>`;
      async function ready(versionId) {
        for (let attempt = 0; attempt < 80; attempt++) {
          const current = await api(
            `/api/workspaces/${workspaceId}/assets/${asset.id}`,
            undefined,
            "GET",
          );
          if (current.status === "failed") throw new Error(current.error);
          if (
            current.status === "ready" &&
            current.currentVersionId === versionId
          )
            return;
          await new Promise((yes) => setTimeout(yes, 250));
        }
        throw new Error("Package upload did not become ready");
      }
      async function upload(color) {
        const result = await tool("upload_asset_version", {
          assetId: asset.id,
          filename: "logo.svg",
          mimeType: "image/svg+xml",
          base64: Buffer.from(svg(color)).toString("base64"),
        });
        await ready(result.versionId);
        return result.versionId;
      }
      const firstVersion = await upload("red");
      const page = await tool(
        "list_assets",
        { prefix: "pkg/", limit: 1 },
        reader,
      );
      assert.equal(page.assets[0].id, asset.id);
      assert.equal(page.assets[0].isPublic, false);
      assert.ok(page.nextCursor);
      assert.deepEqual(
        (
          await tool(
            "list_assets",
            { prefix: "pkg/", limit: 1, cursor: page.nextCursor },
            reader,
          )
        ).assets,
        [],
      );
      for (const [name, args] of [
        ["create_asset", { key: "forbidden", displayName: "Forbidden" }],
        ["set_asset_visibility", { assetId: asset.id, isPublic: true }],
        ["delete_asset", { assetId: asset.id }],
        ["list_assets", { workspaceId: otherWorkspaceId }],
      ]) {
        assert.equal(
          (await reader.callTool({ name, arguments: { workspaceId, ...args } }))
            .isError,
          true,
        );
      }
      // Owner-created asset keys still do not receive browser administration.
      assert.equal(
        (
          await fetch(`${base}/api/workspaces/${workspaceId}/members`, {
            headers: { "x-api-key": writeKey },
          })
        ).status,
        401,
      );
      await tool("set_asset_visibility", { assetId: asset.id, isPublic: true });
      assert.equal((await fetch(`${base}/w/smoke/pkg/logo.svg`)).status, 200);
      await tool("set_asset_visibility", {
        assetId: asset.id,
        isPublic: false,
      });
      assert.equal((await fetch(`${base}/w/smoke/pkg/logo.svg`)).status, 401);
      const vard = await tool("create_vard", {
        name: "Package contract",
        folderRules: [{ sourcePrefix: "pkg/", outputPrefix: "assets/folder/" }],
      });
      assert.equal(vard.isPublic, false);
      const items = [
        {
          assetId: asset.id,
          outputPath: "assets/editable.svg",
          writable: true,
          transformation: null,
        },
        {
          assetId: asset.id,
          outputPath: "assets/pinned.svg",
          versionId: firstVersion,
          writable: false,
          transformation: null,
        },
        {
          assetId: asset.id,
          outputPath: "assets/logo.png",
          writable: false,
          transformation: { w: 8, format: "png" },
        },
      ];
      await tool("replace_vard_items", { vardId: vard.id, items });
      // The old boolean could be silently discarded by the API. Reject it now.
      assert.equal(
        (
          await writer.callTool({
            name: "replace_vard_items",
            arguments: {
              workspaceId,
              vardId: vard.id,
              items: [{ ...items[1], pinned: true }],
            },
          })
        ).isError,
        true,
      );
      const definition = await tool("get_vard", { vardId: vard.id }, reader);
      const pinned = definition.items.find(
        (item) => item.outputPath === "assets/pinned.svg",
      );
      assert.equal(pinned.pinned, true);
      assert.equal(pinned.versionId, firstVersion);
      await tool("update_vard", {
        vardId: vard.id,
        name: "Renamed package contract",
      });
      assert.equal(
        (await tool("get_vard", { vardId: vard.id, resolved: true })).items
          .length,
        4,
      );
      assert.ok(
        (await tool("list_vards", {}, reader)).some(
          (item) => item.id === vard.id,
        ),
      );
      const deniedVard = await reader.callTool({
        name: "update_vard",
        arguments: { workspaceId, vardId: vard.id, name: "Forbidden" },
      });
      assert.equal(deniedVard.isError, true);

      const project = join(root, "project");
      const configHome = join(root, "credentials");
      await mkdir(project);
      await mkdir(join(configHome, "vardum"), { recursive: true });
      await writeFile(
        join(configHome, "vardum/version-check.json"),
        JSON.stringify({ latest: cli.version, at: Date.now() }),
      );
      // Absolute Node path runs the real executable; an empty PATH prevents
      // login from opening the user's desktop browser during automation.
      const env = {
        PATH: join(root, "no-browser"),
        HOME: root,
        VARDUM_CONFIG_HOME: configHome,
      };
      const command = (...args) =>
        run(process.execPath, [cli.binary, ...args, "--json"], {
          cwd: project,
          env,
          timeout: 30_000,
        });
      await command(
        "init",
        "--server",
        base,
        "--workspace",
        workspaceId,
        "--vard",
        vard.id,
      );
      await assert.rejects(command("pull", "--frozen"), /snapshot|lock/i);
      const cliKey = await loginCli({ cli, project, env, base, workspaceId, api });
      const credentialPath = join(configHome, "vardum/credentials.json");
      assert.equal((await stat(credentialPath)).mode & 0o777, 0o600);
      assert.equal(
        JSON.parse((await command("whoami")).stdout).authenticated,
        true,
      );
      assert.equal(JSON.parse((await command("pull")).stdout).changed, 4);
      const lockPath = join(project, ".vardum.lock");
      const originalLock = await readFile(lockPath, "utf8");
      assert.equal(JSON.parse(originalLock).schema, 2);
      assert.ok(
        !originalLock.includes(cliKey) && !originalLock.includes(writeKey),
      );
      const originalFiles = new Map();
      for (const item of Object.values(JSON.parse(originalLock).items))
        originalFiles.set(item.path, await readFile(join(project, item.path)));
      assert.equal(
        JSON.parse((await command("status", "--frozen")).stdout).changed,
        0,
      );
      await upload("blue");
      await command("pull");
      assert.equal(
        await readFile(join(project, "assets/editable.svg"), "utf8"),
        svg("blue"),
      );
      assert.equal(
        await readFile(join(project, "assets/pinned.svg"), "utf8"),
        svg("red"),
      );
      await writeFile(join(project, "assets/editable.svg"), svg("green"));
      assert.equal(JSON.parse((await command("push")).stdout).changed, 1);

      // Consume the packed CLI through the real API, RustFS and asynchronous
      // worker. Import must preserve manual flags/IDs and existing folder rules.
      const importSource = join(project, "import-source");
      await mkdir(importSource);
      await writeFile(join(importSource, "logo.svg"), svg("green"));
      await writeFile(join(importSource, "extra.svg"), svg("purple"));
      const beforeImport = await tool("get_vard", { vardId: vard.id }, reader);
      const beforeImportLock = await readFile(lockPath, "utf8");
      async function importAssetSnapshot() {
        const assets = [];
        let cursor = null;
        do {
          const query = new URLSearchParams({ prefix: "pkg/", pagination: "cursor", limit: "100" });
          if (cursor) query.set("cursor", cursor);
          const page = await api(`/api/workspaces/${workspaceId}/assets?${query}`, undefined, "GET");
          assets.push(...page.assets);
          cursor = page.nextCursor;
        } while (cursor);
        return Promise.all(assets.sort((a, b) => a.key.localeCompare(b.key)).map(async (item) => ({
          id: item.id, key: item.key, isPublic: item.isPublic,
          currentVersionId: item.currentVersionId, latestVersionId: item.latestVersionId,
          status: item.status, hasUnfinishedUploads: item.hasUnfinishedUploads,
          history: await api(`/api/workspaces/${workspaceId}/assets/${item.id}/versions?limit=100`, undefined, "GET"),
        })));
      }
      const beforeImportAssets = await importAssetSnapshot();
      const importArgs = ["push-folder", "import-source", "pkg/", "--output", "assets/import/"];
      const plannedImport = JSON.parse((await command(...importArgs, "--dry-run")).stdout);
      assert.equal(plannedImport.changed, 3);
      assert.deepEqual(plannedImport.library.map((item) => item.libraryAction).sort(), ["new", "skip"]);
      assert.ok(plannedImport.mappings.every((item) => item.mappingAction === "add"));
      await assert.rejects(run(process.execPath, [cli.binary, ...importArgs, "--dry-run", "--json"], {
        cwd: project, env: { ...env, VARDUM_API_KEY: readKey }, timeout: 30_000,
      }), /permission|403/i);
      assert.deepEqual(await importAssetSnapshot(), beforeImportAssets);
      assert.deepEqual((await tool("get_vard", { vardId: vard.id }, reader)).items, beforeImport.items);
      assert.equal(JSON.parse((await command(...importArgs)).stdout).changed, 3);
      const imported = await tool("get_vard", { vardId: vard.id }, reader);
      for (const previous of beforeImport.items)
        assert.deepEqual(imported.items.find((item) => item.id === previous.id), previous);
      assert.equal(imported.items.length, beforeImport.items.length + 2);
      assert.equal(await readFile(lockPath, "utf8"), beforeImportLock);
      assert.equal(await readFile(join(importSource, "logo.svg"), "utf8"), svg("green"));
      assert.equal(await readFile(join(importSource, "extra.svg"), "utf8"), svg("purple"));
      const importedAssets = await importAssetSnapshot();
      assert.equal(JSON.parse((await command(...importArgs)).stdout).changed, 0);
      assert.deepEqual((await tool("get_vard", { vardId: vard.id }, reader)).items, imported.items);
      assert.deepEqual(await importAssetSnapshot(), importedAssets);
      await command("pull");
      assert.equal(Object.keys(JSON.parse(await readFile(lockPath, "utf8")).items).length, 7);
      assert.equal(await readFile(join(project, "assets/import/logo.svg"), "utf8"), svg("green"));
      assert.equal(await readFile(join(project, "assets/import/extra.svg"), "utf8"), svg("purple"));
      assert.equal(await readFile(join(project, "assets/folder/extra.svg"), "utf8"), svg("purple"));
      const extraAsset = importedAssets.find((item) => item.key === "pkg/extra");
      assert.ok(extraAsset);
      console.log("Installed CLI additive folder import: real storage/worker, dry-run/scope denial, preserved mappings, repeat0, separate pull passed");
      await tool("delete_vard", { vardId: vard.id });
      await writeFile(lockPath, originalLock);
      await rm(join(project, "assets"), { recursive: true });
      const restored = await run(
        process.execPath,
        [cli.binary, "pull", "--frozen", "--json"],
        {
          cwd: project,
          env: { ...env, VARDUM_API_KEY: readKey },
          timeout: 30_000,
        },
      );
      assert.equal(JSON.parse(restored.stdout).changed, 4);
      assert.equal(await readFile(lockPath, "utf8"), originalLock);
      for (const [path, bytes] of originalFiles)
        assert.deepEqual(await readFile(join(project, path)), bytes);
      await command("logout");
      assert.equal(
        JSON.parse((await command("whoami")).stdout).authenticated,
        false,
      );
      assert.equal(
        (
          await fetch(`${base}/api/workspaces/${workspaceId}/sync/assets`, {
            headers: { "x-api-key": cliKey },
          })
        ).status,
        401,
      );
      await tool("delete_asset", { assetId: asset.id });
      await tool("delete_asset", { assetId: extraAsset.id });
      assert.deepEqual(
        (await tool("list_assets", { prefix: "pkg/" })).assets,
        [],
      );
      assert.deepEqual([...exercised].sort(), expectedTools);
      console.log(
        "Installed CLI: login callback, private pull/push, pin, old snapshot restore without Vard, logout passed; installed MCP: all 11 tools, pagination, resources and scope denials passed",
      );
    } finally {
      await Promise.all(clients.map((client) => client.close()));
    }
  });
}

export async function loginCli({ cli, project, env, base, workspaceId, api, access = "write" }) {
  const child = spawn(process.execPath, [cli.binary, "login"], {
    cwd: project,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let errors = "";
  const completed = new Promise((yes, no) => {
    child.once("error", no);
    child.once("exit", (code) =>
      code === 0
        ? yes()
        : no(new Error(`CLI login failed (${code}): ${errors}`)),
    );
  });
  // Attach rejection handling immediately, including during callback discovery.
  completed.catch(() => {});
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  const timer = setTimeout(() => child.kill(), 25_000);
  try {
    const url = await new Promise((yes, no) => {
      child.once("exit", () =>
        no(new Error("CLI exited before printing login URL")),
      );
      child.stdout.on("data", (chunk) => {
        output += chunk;
        const match = /Opening (https?:\/\/[^\s]+)/.exec(output);
        if (match) yes(new URL(match[1]));
      });
    });
    assert.equal(url.origin, new URL(base).origin);
    assert.equal(url.pathname, "/cli-login");
    assert.equal(url.searchParams.get("workspace"), workspaceId);
    const callback = new URL(url.searchParams.get("callback"));
    assert.equal(callback.hostname, "127.0.0.1");
    const grant = await api(`/api/workspaces/${workspaceId}/cli-keys`, {
      label: url.searchParams.get("label"),
      access,
    });
    assert.equal(grant.access, access);
    const post = (state) =>
      fetch(callback, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ state, key: grant.key, workspace: workspaceId }),
      });
    assert.equal((await post("wrong-state")).status, 400);
    assert.equal((await post(url.searchParams.get("state"))).status, 204);
    await completed;
    return grant.key;
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill();
  }
}
