import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireFolderMutex, readFolderState, writeFolderState } from "./folder-upload.js";

async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(join(tmpdir(), "vardum-folder-state-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test("atomic folder state failures preserve prior contents and clean temporary files", async (t) => {
  const root = await fixture(t);
  const path = join(root, ".vardum.push.pending.json");
  const original = fs.open;
  await writeFolderState(path, { before: true });
  const before = await fs.readFile(path, "utf8");
  for (const failure of ["write", "sync"]) {
    fs.open = async (...args: Parameters<typeof fs.open>) => {
      const handle = await original(...args);
      if (String(args[0]).endsWith(".tmp")) {
        if (failure === "write") {
          const write = handle.writeFile.bind(handle);
          handle.writeFile = async () => {
            await write("partial contents");
            throw Object.assign(new Error("fixture write failure"), { code: "EIO" });
          };
        } else handle.sync = async () => { throw Object.assign(new Error("fixture fsync failure"), { code: "EIO" }); };
      }
      return handle;
    };
    syncBuiltinESMExports();
    try { await assert.rejects(writeFolderState(path, { after: true }), /fixture/); }
    finally { fs.open = original; syncBuiltinESMExports(); }
    assert.equal(await fs.readFile(path, "utf8"), before);
    assert.deepEqual(await fs.readdir(root), [".vardum.push.pending.json"]);
  }
  await writeFolderState(path, { after: true });
  assert.deepEqual(JSON.parse((await readFolderState(path))!), { after: true });
  if (process.platform !== "win32") assert.equal((await fs.stat(path)).mode & 0o777, 0o600);
});

test("the Windows branch durably writes files without attempting unsupported directory opens", async (t) => {
  const root = await fixture(t);
  const path = join(root, ".vardum.push.pending.json");
  const original = fs.open;
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  let fileSyncs = 0;
  fs.open = async (...args: Parameters<typeof fs.open>) => {
    if (args[0] === root) throw Object.assign(new Error("Windows cannot open this directory"), { code: "EPERM" });
    const handle = await original(...args);
    const sync = handle.sync.bind(handle);
    handle.sync = async () => { fileSyncs++; await sync(); };
    return handle;
  };
  syncBuiltinESMExports();
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  try { await writeFolderState(path, { complete: true }); }
  finally {
    Object.defineProperty(process, "platform", platform);
    fs.open = original;
    syncBuiltinESMExports();
  }
  assert.equal(fileSyncs, 1);
  assert.deepEqual(JSON.parse((await readFolderState(path))!), { complete: true });
});

test("exclusive mutex ownership survives contenders and releases only its own inode", async (t) => {
  const root = await fixture(t);
  const path = join(root, ".vardum.push.mutex");
  const release = await acquireFolderMutex(root);
  const owner = await fs.readFile(path, "utf8");
  await assert.rejects(acquireFolderMutex(root), /Another folder push/);
  assert.equal(await fs.readFile(path, "utf8"), owner);
  await fs.rename(path, `${path}.old`);
  await fs.writeFile(path, JSON.stringify({ pid: process.pid }));
  await release();
  assert.equal(await fs.readFile(path, "utf8"), JSON.stringify({ pid: process.pid }));
});
