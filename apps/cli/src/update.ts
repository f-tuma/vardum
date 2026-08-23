import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

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

// Session cache: avoid fetching the registry on every command.
let latestVersion: string | null = null;
let lastCheck = 0;
const cacheMs = 86_400_000; // 24 h

/**
 * Returns the latest published version of @vardum/cli, or null on failure.
 * Cached for 24 hours so the CLI never blocks on the network for routine work.
 */
export async function fetchLatestVersion(): Promise<string | null> {
  const now = Date.now();
  if (latestVersion && now - lastCheck < cacheMs) return latestVersion;
  try {
    const res = await fetch("https://registry.npmjs.org/@vardum/cli/latest", {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const { version } = (await res.json()) as { version: string };
    latestVersion = version;
    lastCheck = now;
    return version;
  } catch {
    return null;
  }
}

/**
 * Check whether the installed version is outdated and print a warning.
 * Safe to call at the start of every command — it's a no-op when the cache
 * is fresh and the version is current.
 */
export async function maybeWarnOutdated() {
  const latest = await fetchLatestVersion();
  if (!latest || latest === VERSION) return;
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

  // Linked via `npm link` / `pnpm link` — the real path points into the
  // source tree, not a node_modules.
  if (real !== ownPath) return { kind: "link" };

  // Global installs live in a well-known prefix.
  const globalPrefixes = [
    "/usr/local/lib/node_modules",
    "/usr/lib/node_modules",
    "/usr/local/share/.config/yarn/global",
  ];
  const home = process.env.HOME ?? "";
  if (home) {
    globalPrefixes.push(`${home}/.local/share/pnpm/global`);
    globalPrefixes.push(`${home}/.npm-packages/lib/node_modules`);
    globalPrefixes.push(`${home}/.node_modules`);
  }
  const isGlobal = globalPrefixes.some((prefix) => dir.startsWith(prefix));
  if (isGlobal) {
    const manager = detectGlobalManager();
    return { kind: "global", manager };
  }

  // Local install: inside a project's node_modules.
  if (dir.includes(`${sep}node_modules${sep}`)) {
    const manager = await detectLocalManager();
    return { kind: "local", manager };
  }

  return { kind: "unknown" };
}

function detectGlobalManager(): "npm" | "pnpm" | "yarn" {
  try {
    execSync("pnpm --version", { stdio: "ignore" });
    const pnpmDir = `${process.env.HOME ?? ""}/.local/share/pnpm/global`;
    if (fileURLToPath(import.meta.url).startsWith(pnpmDir)) return "pnpm";
  } catch {
    /* not pnpm */
  }
  try {
    execSync("yarn --version", { stdio: "ignore" });
    return "yarn";
  } catch {
    /* not yarn */
  }
  return "npm";
}

async function detectLocalManager(): Promise<"npm" | "pnpm" | "yarn"> {
  // Walk up from cwd to find a lockfile.
  let cwd = process.cwd();
  while (true) {
    try {
      const entries = await import("node:fs/promises").then((m) =>
        m.readdir(cwd),
      );
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
