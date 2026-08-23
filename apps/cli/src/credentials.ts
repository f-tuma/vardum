import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";

type Store = { schema: 1; keys: Record<string, string> };

/**
 * Keys are stored per server *and* workspace: the same workspace id can exist
 * on vardum.com and on a self-hosted instance, and they are not the same place.
 */
function entryKey(server: string, workspace: string) {
  return `${server.replace(/\/$/, "")}|${workspace}`;
}

export function credentialsPath() {
  const base =
    process.env.VARDUM_CONFIG_HOME ??
    process.env.XDG_CONFIG_HOME ??
    join(homedir(), ".config");
  return join(base, "vardum", "credentials.json");
}

/** A short, filename-safe machine name, so a stale key is recognisable. */
export function machineLabel() {
  const name = hostname()
    .split(".")[0]!
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return name.slice(0, 24) || "cli";
}

export async function readCredential(server: string, workspace: string) {
  const store = await readStore();
  return store.keys[entryKey(server, workspace)] ?? null;
}

export async function writeCredential(
  server: string,
  workspace: string,
  key: string,
) {
  const store = await readStore();
  store.keys[entryKey(server, workspace)] = key;
  await writeStore(store);
}

/** Returns false when there was nothing stored for that server and workspace. */
export async function removeCredential(server: string, workspace: string) {
  const store = await readStore();
  const path = entryKey(server, workspace);
  if (!(path in store.keys)) return false;
  delete store.keys[path];
  await writeStore(store);
  return true;
}

async function readStore(): Promise<Store> {
  try {
    const parsed = JSON.parse(await readFile(credentialsPath(), "utf8")) as
      Partial<Store> | undefined;
    return { schema: 1, keys: parsed?.keys ?? {} };
  } catch (error) {
    if (isMissing(error)) return { schema: 1, keys: {} };
    throw error;
  }
}

async function writeStore(store: Store) {
  const path = credentialsPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  // 0600 before the rename, so the key is never briefly world-readable.
  await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, {
    mode: 0o600,
  });
  try {
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function isMissing(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
