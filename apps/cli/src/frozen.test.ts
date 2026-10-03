import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { VardumClient, type ManifestItem } from "./client.js";
import { checksum, safeTarget, validateLock } from "./sync.js";

const cli = fileURLToPath(new URL("./index.ts", import.meta.url));
const tsx = import.meta.resolve("tsx");
const v1 = "11111111-1111-4111-8111-111111111111";
const v2 = "22222222-2222-4222-8222-222222222222";
function item(
  id = "one",
  versionId = v1,
  outputPath = "assets/logo.png",
  query = "?w=64&format=png&sig=original",
): ManifestItem {
  return {
    id,
    assetId: id,
    key: `${id}.png`,
    outputPath,
    writable: !query,
    pinned: false,
    transformation: query ? { w: 64, format: "png" } : null,
    versionId,
    fingerprint: `${versionId}:${query}`,
    downloadUrl: `/w/__id/workspace/__v/${versionId}${query}`,
    sourceChecksum: null,
    mimeType: "image/png",
    size: null,
  };
}

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "vardum-frozen-"));
  const home = join(root, "home");
  const project = join(root, "project");
  await mkdir(join(home, "vardum"), { recursive: true });
  await mkdir(project);
  await writeFile(
    join(home, "vardum/version-check.json"),
    JSON.stringify({ latest: "0.0.0", at: Date.now() }),
  );
  const requests: Array<{ url: string; key: string | undefined }> = [];
  const state = {
    items: [item()],
    files: new Map<string, string>(),
    redirect: "",
    uploaded: "edited",
    identitySupport: true,
  };
  state.files.set(state.items[0]!.downloadUrl!, "original transformed bytes");
  const server = createServer(async (req, res) => {
    const url = req.url!;
    requests.push({ url, key: req.headers["x-api-key"] as string | undefined });
    res.setHeader("content-type", "application/json");
    if (url.split("?")[0]!.endsWith("/manifest") || url.split("?")[0] === "/v/vard") {
      const identity = url.includes("delivery=version-id-v1");
      res.end(
        JSON.stringify({
          schema: 1,
          id: "vard",
          workspaceId: "workspace",
          ...(identity && state.identitySupport ? { delivery: "version-id-v1" } : {}),
          items: identity ? state.items : state.items.map(item => ({ ...item,
            downloadUrl: `/w/demo/__v/${item.versionId}/${item.key}${new URL(item.downloadUrl!, "http://fixture").search}`,
          })),
        }),
      );
    } else if (url === "/api/upload-limits") {
      res.end(JSON.stringify({ image: 10000, video: 10000, file: 10000 }));
    } else if (url.endsWith("/versions")) {
      res.end(
        JSON.stringify({
          id: v2,
          upload: { method: "POST", url: `${origin}/storage`, fields: {} },
        }),
      );
    } else if (url === "/storage") {
      for await (const _ of req) {
        /* consume multipart upload */
      }
      res.end("{}");
    } else if (url.endsWith("/finalize")) {
      state.items = [item("one", v2, "assets/logo.png", "")];
      state.files.set(state.items[0]!.downloadUrl!, state.uploaded);
      res.statusCode = 204;
      res.end();
    } else if (state.redirect) {
      res.writeHead(302, { location: state.redirect });
      res.end();
    } else if (state.files.has(url.replace(/^\/w\/demo\/__v\/([^/]+)\/[^?]+/, "/w/__id/workspace/__v/$1"))) {
      res.end(state.files.get(url.replace(/^\/w\/demo\/__v\/([^/]+)\/[^?]+/, "/w/__id/workspace/__v/$1")));
    } else {
      res.statusCode = 404;
      res.end("missing");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const config = {
    schema: 1 as const,
    server: origin,
    workspace: "workspace",
    vard: "vard",
  };
  await writeFile(
    join(project, "vardum.json"),
    JSON.stringify({
      ...config,
      server: `${origin}/`,
      workspace: " workspace ",
      vard: " vard ",
    }),
  );
  t.after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  });
  async function run(...args: string[]) {
    return new Promise<{
      code: number;
      data: any;
      stdout: string;
      stderr: string;
    }>((resolve) => {
      execFile(
        process.execPath,
        ["--import", tsx, cli, ...args, "--json"],
        {
          cwd: project,
          env: {
            PATH: process.env.PATH,
            HOME: home,
            XDG_CONFIG_HOME: home,
            VARDUM_API_KEY: "test-key",
          },
          timeout: 15000,
        },
        (error, stdout, stderr) => {
          const code = error ? Number(error.code) : 0;
          resolve({
            code,
            data: JSON.parse(code ? stderr : stdout),
            stdout,
            stderr,
          });
        },
      );
    });
  }
  const lockPath = join(project, ".vardum.lock");
  const lockText = () => readFile(lockPath, "utf8");
  const lock = async () => JSON.parse(await lockText());
  return {
    root,
    project,
    state,
    requests,
    origin,
    config,
    run,
    lockPath,
    lockText,
    lock,
  };
}

test("pull snapshots exact outputs; frozen/sync restore old membership, paths and signed transforms without manifest; pull refreshes", async (t) => {
  const f = await fixture(t);
  f.state.items.push(item("two", v1, "assets/second.png", ""));
  f.state.files.set(f.state.items[1]!.downloadUrl!, "second original");
  assert.equal((await f.run("pull")).code, 0);
  const text = await f.lockText();
  const locked = await f.lock();
  assert.equal(locked.schema, 3);
  assert.equal(locked.server, f.origin);
  assert.equal(locked.workspace, "workspace");
  assert.equal(
    locked.items.one.checksum,
    checksum(Buffer.from("original transformed bytes")),
  );
  assert.equal(
    locked.items.one.downloadUrl,
    `${f.origin}${f.state.items[0]!.downloadUrl}`,
  );
  f.state.items = [
    item("one", v2, "new/location.png", "?w=128&sig=new"),
    item("three", v2, "new/third.png", ""),
  ];
  for (const output of f.state.items)
    f.state.files.set(output.downloadUrl!, `new ${output.id}`);
  await rm(join(f.project, "assets"), { recursive: true });
  f.requests.length = 0;
  assert.equal((await f.run("sync", "--frozen")).code, 0);
  assert.equal(
    await readFile(join(f.project, "assets/logo.png"), "utf8"),
    "original transformed bytes",
  );
  assert.equal(
    await readFile(join(f.project, "assets/second.png"), "utf8"),
    "second original",
  );
  assert.deepEqual(
    f.requests.map((r) => r.url),
    [
      new URL(locked.items.one.downloadUrl).pathname +
        new URL(locked.items.one.downloadUrl).search,
      new URL(locked.items.two.downloadUrl).pathname,
    ],
  );
  assert.equal(await f.lockText(), text);
  f.requests.length = 0;
  assert.equal((await f.run("pull", "--frozen")).data.changed, 0);
  assert.equal(f.requests.length, 0);
  assert.equal((await f.run("pull", "--delete")).code, 0);
  assert.deepEqual(Object.keys((await f.lock()).items), ["one", "three"]);
  assert.equal(
    await readFile(join(f.project, "new/location.png"), "utf8"),
    "new one",
  );
  await assert.rejects(readFile(join(f.project, "assets/logo.png")), /ENOENT/);
  // Replacing a mapping at the same path must not delete its newly pulled file.
  f.state.items[0] = item("replacement", v2, "new/location.png", "");
  f.state.files.set(f.state.items[0]!.downloadUrl!, "replacement bytes");
  assert.equal((await f.run("pull", "--force", "--delete")).code, 0);
  assert.equal(
    await readFile(join(f.project, "new/location.png"), "utf8"),
    "replacement bytes",
  );
});

test("frozen requires a validated bound snapshot; ordinary pull upgrades schema 1", async (t) => {
  const f = await fixture(t);
  assert.match((await f.run("pull", "--frozen")).data.error, /run vardum pull/);
  assert.equal(f.requests.length, 0);
  await f.run("pull");
  const snapshot = await f.lock();
  const legacy = {
    schema: 1,
    vard: "vard",
    items: { one: { ...snapshot.items.one } },
  };
  delete legacy.items.one.downloadUrl;
  await writeFile(f.lockPath, JSON.stringify(legacy));
  f.requests.length = 0;
  assert.match((await f.run("pull", "--frozen")).data.error, /schema 2/);
  assert.equal(f.requests.length, 0);
  assert.equal((await f.run("pull")).code, 0);
  assert.equal((await f.lock()).schema, 3);
  const cases: Array<[string, any]> = [
    ["unsupported", { ...snapshot, schema: 4 }],
    ["null", null],
    ["array", []],
    ["wrong server", { ...snapshot, server: "https://other.invalid" }],
    ["wrong workspace", { ...snapshot, workspace: "other" }],
    ["wrong vard", { ...snapshot, vard: "other" }],
    ["missing delivery marker", { ...snapshot, delivery: undefined }],
    ["wrong identity workspace", { ...snapshot, items: { one: { ...snapshot.items.one, downloadUrl: snapshot.items.one.downloadUrl.replace("/__id/workspace/", "/__id/foreign/") } } }],
    ["duplicate transformation query", { ...snapshot, items: { one: { ...snapshot.items.one, downloadUrl: `${f.origin}/w/__id/workspace/__v/${v1}?w=1&w=2&sig=invalid` } } }],
    ["missing items", { ...snapshot, items: null }],
    ...["checksum", "downloadUrl", "fingerprint", "versionId"].map(
      (field): [string, any] => [
        field,
        { ...snapshot, items: { one: { ...snapshot.items.one, [field]: "" } } },
      ],
    ),
    ...[
      "../escape.png",
      "a/../b.png",
      "/tmp/escape.png",
      "a\\b.png",
      ".",
      "",
      ".git/config",
      "vardum.json",
      ".vardum.lock",
      "a\u0000b",
      "a//b",
      "C:/b",
      "a/CON.png",
    ].map((path): [string, any] => [
      path,
      { ...snapshot, items: { one: { ...snapshot.items.one, path } } },
    ]),
    ...[
      "https://other.invalid/w/demo/__v/" + v1 + "/one.png",
      "/w/demo/one.png",
      `/w/demo/__v/${v2}/one.png`,
      "file:///tmp/a",
      `//other.invalid/w/demo/__v/${v1}/one.png`,
    ].map((downloadUrl): [string, any] => [
      downloadUrl,
      { ...snapshot, items: { one: { ...snapshot.items.one, downloadUrl } } },
    ]),
    [
      "duplicate paths",
      {
        ...snapshot,
        items: { one: snapshot.items.one, two: snapshot.items.one },
      },
    ],
    [
      "overlap",
      {
        ...snapshot,
        items: {
          one: snapshot.items.one,
          two: { ...snapshot.items.one, path: "assets/logo.png/sub.png" },
        },
      },
    ],
    ...["assets/e\u0301.png", "assets/e\u0301.png/sub.png"].map(
      (path): [string, any] => [
        `Unicode-equivalent path: ${path}`,
        {
          ...snapshot,
          items: {
            one: { ...snapshot.items.one, path: "assets/\u00e9.png" },
            two: { ...snapshot.items.one, path },
          },
        },
      ],
    ),
  ];
  f.requests.length = 0;
  for (const [name, value] of cases) {
    assert.throws(() => validateLock(value, f.config), name);
    await writeFile(f.lockPath, JSON.stringify(value));
    assert.notEqual((await f.run("pull", "--frozen")).code, 0, name);
  }
  await writeFile(f.lockPath, "{broken");
  assert.match((await f.run("pull", "--frozen")).data.error, /Cannot read/);
  assert.notEqual((await f.run("pull")).code, 0);
  assert.equal(f.requests.length, 0);
});

test("malformed context options cannot swallow frozen and refresh assets", async (t) => {
  for (const existingLock of [false, true]) {
    const f = await fixture(t);
    if (existingLock) assert.equal((await f.run("pull")).code, 0);
    const before = existingLock ? await f.lockText() : null;
    f.state.items = [item("one", v2)];
    f.state.files.set(f.state.items[0]!.downloadUrl!, "new remote bytes");
    f.requests.length = 0;
    for (const option of ["--server", "--workspace", "--vard"]) {
      const result = await f.run("pull", option, "--frozen");
      assert.notEqual(result.code, 0, option);
      assert.match(result.data.error, /requires a value/);
      assert.equal(f.requests.length, 0);
      if (existingLock) {
        assert.equal(await f.lockText(), before);
        assert.equal(
          await readFile(join(f.project, "assets/logo.png"), "utf8"),
          "original transformed bytes",
        );
      } else {
        await assert.rejects(f.lockText(), /ENOENT/);
        await assert.rejects(
          readFile(join(f.project, "assets/logo.png")),
          /ENOENT/,
        );
      }
    }
  }
});

test("frozen conflict/dry-run/force, missing sources, integrity and partial failures preserve existing files and lock", async (t) => {
  const f = await fixture(t);
  await f.run("pull");
  const locked = await f.lockText();
  const path = join(f.project, "assets/logo.png");
  await writeFile(path, "local edit");
  f.requests.length = 0;
  assert.match((await f.run("pull", "--frozen")).data.error, /Local changes/);
  for (const command of ["status", "pull"]) {
    const result = await f.run(command, "--frozen", "--dry-run");
    assert.equal(result.code, 0);
    assert.equal(result.data.actions[0].conflict, true);
    assert.equal(result.data.actions[0].applied, false);
  }
  assert.equal(f.requests.length, 0);
  assert.equal(await readFile(path, "utf8"), "local edit");
  const url = f.state.items[0]!.downloadUrl!;
  f.state.files.delete(url);
  assert.match((await f.run("pull", "--frozen", "--force")).data.error, /404/);
  f.state.files.set(url, "tampered");
  const bad = await f.run("pull", "--frozen", "--force");
  assert.match(bad.data.error, /checksum mismatch/);
  assert.equal(bad.data.actions[0].applied, false);
  assert.equal(await readFile(path, "utf8"), "local edit");
  assert.equal(await f.lockText(), locked);
  f.state.files.set(url, "original transformed bytes");
  assert.equal((await f.run("pull", "--frozen", "--force")).code, 0);
  assert.equal(await f.lockText(), locked);
  f.state.items.push(item("two", v1, "assets/second.png", ""));
  f.state.files.set(f.state.items[1]!.downloadUrl!, "second");
  await f.run("pull");
  const twoLocked = await f.lockText();
  await rm(join(f.project, "assets"), { recursive: true });
  f.state.files.delete(f.state.items[1]!.downloadUrl!);
  const partial = await f.run("pull", "--frozen");
  assert.notEqual(partial.code, 0);
  assert.deepEqual(
    partial.data.actions.map((a: any) => a.applied),
    [true, false],
  );
  assert.equal(await readFile(path, "utf8"), "original transformed bytes");
  assert.equal(await f.lockText(), twoLocked);
  for (const args of [
    ["pull", "--frozen", "--delete"],
    ["push", "--frozen"],
    ["pull", "--frozen", "--server", f.origin],
  ])
    assert.notEqual((await f.run(...args)).code, 0);
});

test("shared download boundary refuses cross-origin URLs and every redirect without forwarding API keys", async (t) => {
  const f = await fixture(t);
  const other = await fixture(t);
  const client = new VardumClient(f.origin, "secret-test-key");
  for (const url of [
    other.origin + "/steal",
    "//" + new URL(other.origin).host + "/steal",
    "file:///tmp/a",
    f.origin.replace("http://", "http://user:pass@") + "/a",
  ])
    await assert.rejects(client.download(url));
  assert.equal(other.requests.length, 0);
  for (const location of [other.origin + "/steal", f.origin + "/second"]) {
    f.state.redirect = location;
    await assert.rejects(client.download("/redirect"));
    assert.equal(f.requests.at(-1)!.key, "secret-test-key");
    assert.equal(f.requests.at(-1)!.url, "/redirect");
  }
  assert.equal(other.requests.length, 0);
  assert.equal(f.requests.length, 2);
  f.state.redirect = "";
  await f.run("pull");
  await rm(join(f.project, "assets"), { recursive: true });
  f.state.redirect = other.origin + "/steal";
  assert.notEqual((await f.run("pull", "--frozen")).code, 0);
  assert.equal(other.requests.length, 0);
});

test("snapshot and filesystem reject symlinks and duplicate manifest paths before writes", async (t) => {
  const f = await fixture(t);
  await f.run("pull");
  const text = await f.lockText();
  await rm(join(f.project, "assets"), { recursive: true });
  await symlink(f.root, join(f.project, "assets"));
  await assert.rejects(safeTarget(f.project, "assets/logo.png"), /symlink/);
  assert.match(
    (await f.run("pull", "--frozen", "--force")).data.error,
    /symlink/,
  );
  await rm(join(f.project, "assets"));
  f.state.items.push(item("two"));
  assert.match((await f.run("pull")).data.error, /Duplicate/);
  assert.equal(await f.lockText(), text);
  const external = join(f.root, "lock-copy");
  await writeFile(external, text);
  await rm(f.lockPath);
  await symlink(external, f.lockPath);
  assert.match((await f.run("pull", "--frozen")).data.error, /symlink/);
});

test("mapped push advances snapshot URL/version/checksum together; legacy push remains supported", async (t) => {
  const f = await fixture(t);
  f.state.items = [item("one", v1, "assets/logo.png", "")];
  f.state.files.set(f.state.items[0]!.downloadUrl!, "original");
  await f.run("pull");
  await writeFile(join(f.project, "assets/logo.png"), "edited");
  assert.equal(
    (await f.run("push", "--dry-run")).data.actions[0].applied,
    false,
  );
  assert.equal((await f.run("push")).code, 0);
  const locked = await f.lock();
  assert.equal(locked.items.one.versionId, v2);
  assert.equal(
    locked.items.one.downloadUrl,
    `${f.origin}/w/__id/workspace/__v/${v2}`,
  );
  assert.equal(locked.items.one.checksum, checksum(Buffer.from("edited")));
  await rm(join(f.project, "assets"), { recursive: true });
  f.requests.length = 0;
  assert.equal((await f.run("pull", "--frozen")).code, 0);
  assert.equal(
    await readFile(join(f.project, "assets/logo.png"), "utf8"),
    "edited",
  );
  assert.equal(f.requests.length, 1);
  const legacy = {
    schema: 1,
    vard: "vard",
    items: structuredClone(locked.items),
  };
  delete legacy.items.one.downloadUrl;
  await writeFile(f.lockPath, JSON.stringify(legacy));
  // Reset the fake remote to v1 to exercise the legacy upload path with force.
  f.state.items = [item("one", v1, "assets/logo.png", "")];
  await writeFile(join(f.project, "assets/logo.png"), "legacy edit");
  assert.equal((await f.run("push", "--force")).code, 0);
  assert.equal((await f.lock()).schema, 1);
  assert.equal((await f.lock()).items.one.versionId, v2);
  // A remote upload can succeed while delivery verification fails: report the
  // upload but do not persist a snapshot with an unverified checksum.
  await writeFile(f.lockPath, JSON.stringify(locked));
  const beforeFailure = await f.lockText();
  f.state.items = [item("one", v1, "assets/logo.png", "")];
  f.state.uploaded = "wrong delivery bytes";
  const failed = await f.run("push", "--force");
  assert.match(failed.data.error, /checksum mismatch/);
  assert.equal(failed.data.actions[0].applied, true);
  assert.equal(await f.lockText(), beforeFailure);
});

test("normal pull fails before writes when identity delivery is unsupported; schema 2 frozen and push keep legacy URLs", async t => {
  const f = await fixture(t);
  f.state.items = [item("one", v1, "assets/logo.png", "")];
  f.state.files.set(f.state.items[0]!.downloadUrl!, "original");
  await f.run("pull");
  const original = await f.lockText();
  f.state.identitySupport = false;
  f.requests.length = 0;
  const unsupported = await f.run("pull", "--force");
  assert.match(unsupported.data.error, /does not support version-id-v1/);
  assert.equal(await f.lockText(), original);
  assert.equal(await readFile(join(f.project, "assets/logo.png"), "utf8"), "original");
  assert.equal(f.requests.length, 1);
  const old = await f.lock();
  old.schema = 2;
  delete old.delivery;
  old.items.one.downloadUrl = `${f.origin}/w/demo/__v/${v1}/one.png`;
  await writeFile(f.lockPath, JSON.stringify(old));
  const legacyText = await f.lockText();
  await rm(join(f.project, "assets"), { recursive: true });
  assert.equal((await f.run("pull", "--frozen")).code, 0);
  assert.equal(await f.lockText(), legacyText);
  await writeFile(join(f.project, "assets/logo.png"), "edited");
  f.requests.length = 0;
  assert.equal((await f.run("push")).code, 0);
  const pushed = await f.lock();
  assert.equal(pushed.schema, 2);
  assert.equal(pushed.items.one.downloadUrl, `${f.origin}/w/demo/__v/${v2}/one.png`);
  assert.ok(f.requests.some(request => request.url.endsWith("/manifest")));
  assert.ok(f.requests.every(request => !request.url.includes("delivery=version-id-v1")));
});
