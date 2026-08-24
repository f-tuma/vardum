import type { Interface } from "node:readline/promises";
import { relative, resolve } from "node:path";
import type { SyncAsset, VardumClient } from "./client.js";
import { assetKey, assetPrefix } from "./sync.js";

type ScannedFile = {
  absolute: string;
  relative: string;
  mimeType: string;
  size: number;
};

const maxPlanRows = 15;

/**
 * The interactive half of `vardum push-folder`: pick the workspace folder these
 * images deploy into, show the plan, and confirm before changing anything.
 * Returns the chosen prefix ("" for the workspace root) or null when the user
 * quits. Non-interactive callers never reach here — `pushFolder` only calls it
 * when stdin is a TTY, no prefix was given, and --json is off.
 */
export async function planPushFolder(
  prompts: Interface,
  client: VardumClient,
  workspaceId: string,
  directory: string,
  files: ScannedFile[],
): Promise<string | null> {
  const display = relative(process.cwd(), resolve(directory)) || ".";
  const bytes = files.reduce((total, file) => total + file.size, 0);
  console.log(
    `\nScanning ${display} …  ${files.length} file${files.length === 1 ? "" : "s"}, ${formatBytes(bytes)}.`,
  );

  const existing = await client.syncAssets(workspaceId, "");
  const folders = collectFolders(existing.assets);

  // Loop so `[e] change folder` can restart the picker without re-scanning.
  while (true) {
    const prefix = await chooseFolder(prompts, folders);
    if (prefix === null) return null;
    const plan = await buildPlan(client, workspaceId, prefix, files);
    showPlan(prefix, plan);
    const action = await confirm(prompts);
    if (action === "quit") return null;
    if (action === "edit") continue;
    return prefix;
  }
}

/**
 * Every folder in the workspace with the number of assets below it. Nested
 * folders are listed too: offering only the top level hid half a workspace
 * from the picker, even though typing the nested name always worked.
 */
export function collectFolders(assets: SyncAsset[]) {
  const counts = new Map<string, number>();
  for (const asset of assets) {
    const segments = asset.key.split("/");
    segments.pop(); // the filename
    let folder = "";
    for (const segment of segments) {
      folder = folder ? `${folder}/${segment}` : segment;
      counts.set(folder, (counts.get(folder) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b));
}

async function chooseFolder(
  prompts: Interface,
  folders: Array<[string, number]>,
): Promise<string | null> {
  console.log("\nExisting workspace folders:");
  if (folders.length) {
    for (const [index, [folder, count]] of folders.entries())
      console.log(
        `  [${index + 1}] ${folder}  ${count} asset${count === 1 ? "" : "s"}`,
      );
  } else {
    console.log("  (none yet)");
  }
  while (true) {
    const answer = (
      await prompts.question(
        "Folder [number for existing, type a new name, Enter for root]: ",
      )
    ).trim();
    if (!answer) return ""; // root
    if (/^\d+$/.test(answer)) {
      const index = Number(answer) - 1;
      if (index >= 0 && index < folders.length)
        return assetPrefix(folders[index]![0]);
      console.log(
        `No folder ${answer}; pick 1–${folders.length} or type a new name.`,
      );
      continue;
    }
    try {
      return assetPrefix(answer);
    } catch {
      console.log(
        "Invalid folder name: use lowercase letters, digits, - and /. Try again.",
      );
    }
  }
}

type Plan = { rows: Array<{ key: string; replaces: boolean }>; bytes: number };

async function buildPlan(
  client: VardumClient,
  workspaceId: string,
  prefix: string,
  files: ScannedFile[],
): Promise<Plan> {
  const under = await client.syncAssets(workspaceId, prefix);
  const keys = new Set(under.assets.map((asset) => asset.key));
  return {
    rows: files.map((file) => {
      const key = assetKey(prefix, file.relative);
      return { key, replaces: keys.has(key) };
    }),
    bytes: files.reduce((total, file) => total + file.size, 0),
  };
}

function showPlan(prefix: string, plan: Plan) {
  const fresh = plan.rows.filter((row) => !row.replaces).length;
  console.log(
    `\nPlan  → ${prefix || "workspace root"}  ${plan.rows.length} file(s), ${formatBytes(plan.bytes)}`,
  );
  console.log(`  ${fresh} new  ·  ${plan.rows.length - fresh} replace existing`);
  for (const row of plan.rows.slice(0, maxPlanRows))
    console.log(`  ${row.replaces ? "replace" : "new    "}  ${row.key}`);
  if (plan.rows.length > maxPlanRows)
    console.log(`  … and ${plan.rows.length - maxPlanRows} more`);
}

function formatBytes(bytes: number) {
  const units = ["B", "kB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

async function confirm(prompts: Interface): Promise<"push" | "edit" | "quit"> {
  while (true) {
    const answer = (
      await prompts.question("[Enter] push   [e] change folder   [q] quit: ")
    )
      .trim()
      .toLowerCase();
    if (answer === "q") return "quit";
    if (answer === "e") return "edit";
    if (!answer || answer === "y" || answer === "yes") return "push";
  }
}
