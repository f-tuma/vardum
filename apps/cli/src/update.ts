import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readdir, realpath } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { credentialsPath } from "./credentials.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
let pkgVersion = "0.0.0";
try {
  pkgVersion = JSON.parse(
    readFileSync(resolve(__dirname, "..", "package.json"), "utf8"),
  ).version;
} catch {
  // Minimal fallback — the version is only cosmetic.
}
export const VERSION = pkgVersion;

// The check result is cached on disk for 24 h: an in-process cache would mean
// one registry request per command.
const cacheMs = 86_400_000;
const cachePath = join(dirname(credentialsPath()), "version-check.json");

type VersionCache = { latest: string; at: number };

function readCache(): VersionCache | null {
  try {
    const cache = JSON.parse(readFileSync(cachePath, "utf8")) as VersionCache;
    return typeof cache.latest === "string" && typeof cache.at === "number"
      ? cache
      : null;
  } catch {
    return null;
  }
}

/**
 * Returns the latest published version of @vardum/cli, or null on failure.
 * Reads through the on-disk cache so routine commands never hit the network.
 */
export async function fetchLatestVersion(): Promise<string | null> {
  const cached = readCache();
  if (cached && Date.now() - cached.at < cacheMs) return cached.latest;
  try {
    const res = await fetch("https://registry.npmjs.org/@vardum/cli/latest", {
      signal: AbortSignal.timeout(2_000),
    });
    if (!res.ok) return null;
    const { version } = (await res.json()) as { version: string };
    try {
      mkdirSync(dirname(cachePath), { recursive: true });
      writeFileSync(
        cachePath,
        JSON.stringify({ latest: version, at: Date.now() }),
      );
    } catch {
      // An unwritable config dir just means we check again next time.
    }
    return version;
  } catch {
    return null;
  }
}

/** True when `candidate` is a higher semver than `current`. */
export function isNewer(candidate: string, current: string) {
  const parse = (value: string) =>
    value.split(/[.-]/).map((part) => Number(part) || 0);
  const [left, right] = [parse(candidate), parse(current)];
  for (let index = 0; index < 3; index++)
    if ((left[index] ?? 0) !== (right[index] ?? 0))
      return (left[index] ?? 0) > (right[index] ?? 0);
  return false;
}

/**
 * Check whether the installed version is outdated and print a warning.
 * Safe to call at the start of every command — it's a no-op when the cache
 * is fresh and the version is current.
 */
export async function maybeWarnOutdated() {
  const latest = await fetchLatestVersion();
  if (!latest || !isNewer(latest, VERSION)) return;
  const msg = `vardum: version ${latest} is available (you have ${VERSION}) — run "vardum update" to upgrade`;
  console.error(msg);
}

// ── Install-location detection ─────────────────────────────────────────────

type InstallType =
  | { kind: "global"; manager: "npm" | "pnpm" | "yarn" }
  | { kind: "local"; manager: "npm" | "pnpm" | "yarn" }
  | { kind: "link" }
  | { kind: "unknown" };

/**
 * Figure out how @vardum/cli is installed so the update command knows what to
 * run. Walks up from the script's own location.
 */
export async function detectInstall(): Promise<InstallType> {
  const ownPath = fileURLToPath(import.meta.url);
  const real = await realpath(ownPath).catch(() => ownPath);
  const dir = dirname(real);

  // Global installs live in a well-known prefix. Each prefix names its manager,
  // so there is nothing to guess: asking `pnpm --version` only tells us pnpm is
  // installed, not that it installed this copy.
  const home = process.env.HOME ?? "";
  const globalPrefixes: Array<[string, "npm" | "pnpm" | "yarn"]> = [
    ["/usr/local/lib/node_modules", "npm"],
    ["/usr/lib/node_modules", "npm"],
    ["/usr/local/share/.config/yarn/global", "yarn"],
    ...(home
      ? ([
          [`${home}/.local/share/pnpm/global`, "pnpm"],
          [`${home}/.config/yarn/global`, "yarn"],
          [`${home}/.npm-packages/lib/node_modules`, "npm"],
          [`${home}/.node_modules`, "npm"],
        ] as Array<[string, "npm" | "pnpm" | "yarn"]>)
      : []),
  ];
  const global = globalPrefixes.find(([prefix]) => dir.startsWith(prefix));
  if (global) return { kind: "global", manager: global[1] };

  // Local install: inside a project's node_modules.
  if (dir.includes(`${sep}node_modules${sep}`)) {
    const manager = await detectLocalManager();
    return { kind: "local", manager };
  }

  // Linked via `npm link` / `pnpm link` — the real path points into a source
  // tree rather than any install location.
  if (real !== ownPath) return { kind: "link" };

  return { kind: "unknown" };
}

async function detectLocalManager(): Promise<"npm" | "pnpm" | "yarn"> {
  // Walk up from cwd to find a lockfile.
  let cwd = process.cwd();
  while (true) {
    try {
      const entries = await readdir(cwd);
      if (entries.includes("pnpm-lock.yaml")) return "pnpm";
      if (entries.includes("yarn.lock")) return "yarn";
      if (entries.includes("package-lock.json")) return "npm";
    } catch {
      /* ignore */
    }
    const parent = dirname(cwd);
    if (parent === cwd) break;
    cwd = parent;
  }
  return "npm";
}

// ── Update command ─────────────────────────────────────────────────────────

type UpdateOptions = { json: boolean };

/**
 * Run the update: detect the install type, then exec the appropriate package
 * manager command. Returns a summary string.
 */
export async function updateVardum(options: UpdateOptions): Promise<string> {
  const install = await detectInstall();

  if (install.kind === "link") {
    const msg =
      "Vardum is linked to a local source tree. Update it by pulling the latest\n" +
      "source and rebuilding: git pull && pnpm --filter @vardum/cli build";
    if (options.json) return JSON.stringify({ kind: "link", message: msg });
    return msg;
  }

  if (install.kind === "unknown") {
    const msg =
      "Could not detect how Vardum is installed. Update manually:\n" +
      "  npm install -g @vardum/cli@latest";
    if (options.json) return JSON.stringify({ kind: "unknown", message: msg });
    return msg;
  }

  if (install.kind === "global") {
    const cmd = `${install.manager} install -g @vardum/cli@latest`;
    if (options.json) {
      try {
        execSync(cmd, { stdio: "pipe" });
        return JSON.stringify({
          kind: "global",
          manager: install.manager,
          updated: true,
        });
      } catch (error) {
        return JSON.stringify({
          kind: "global",
          manager: install.manager,
          updated: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    console.log(`Updating via ${cmd} …`);
    try {
      execSync(cmd, { stdio: "inherit" });
      return "Vardum updated to the latest version.";
    } catch (error) {
      throw new Error(
        `Update failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // Local install
  const cmd = `${install.manager} install @vardum/cli@latest`;
  if (options.json) {
    try {
      execSync(cmd, { stdio: "pipe" });
      return JSON.stringify({
        kind: "local",
        manager: install.manager,
        updated: true,
      });
    } catch (error) {
      return JSON.stringify({
        kind: "local",
        manager: install.manager,
        updated: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  console.log(`Updating via ${cmd} …`);
  try {
    execSync(cmd, { stdio: "inherit" });
    return "Vardum updated to the latest version.";
  } catch (error) {
    throw new Error(
      `Update failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
