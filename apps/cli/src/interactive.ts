import type { Interface } from "node:readline/promises";
import { relative, resolve } from "node:path";
import type { SyncAsset, VardumClient } from "./client.js";
import { assetKey, assetPrefix } from "./sync.js";

type ScannedFile = { absolute: string; relative: string; mimeType: string };

const maxPlanRows = 25;

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
  console.log(
    `\nScanning ${display} …  ${files.length} image${files.length === 1 ? "" : "s"} found.`,
  );

  const existing = await client.syncAssets(workspaceId, "");
  const folders = collectFolders(existing.assets);

  // Loop so `[e] change folder` can restart the picker without re-scanning.
  while (true) {
    const prefix = await chooseFolder(prompts, folders);
    if (prefix === null) return null;
    const plan = await buildPlan(client, workspaceId, prefix, files);
    showPlan(prefix, plan, files.length);
    const action = await confirm(prompts);
    if (action === "quit") return null;
    if (action === "edit") continue;
    return prefix;
  }
}

/** Top-level folders present in the workspace, each with its asset count. */
export function collectFolders(assets: SyncAsset[]) {
  const counts = new Map<string, number>();
  for (const asset of assets) {
    const slash = asset.key.indexOf("/");
    if (slash <= 0) continue; // root files have no folder
    const folder = asset.key.slice(0, slash);
    counts.set(folder, (counts.get(folder) ?? 0) + 1);
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

type Plan = { fresh: number; present: number };

async function buildPlan(
  client: VardumClient,
  workspaceId: string,
  prefix: string,
  files: ScannedFile[],
): Promise<Plan> {
  const under = await client.syncAssets(workspaceId, prefix);
  const keys = new Set(under.assets.map((asset) => asset.key));
  let fresh = 0;
  let present = 0;
  for (const file of files)
    if (keys.has(assetKey(prefix, file.relative))) present += 1;
    else fresh += 1;
  return { fresh, present };
}

function showPlan(prefix: string, plan: Plan, total: number) {
  const target = prefix ? `→ ${prefix}` : "→ workspace root";
  console.log(`\nPlan  ${target}  ${total} image${total === 1 ? "" : "s"}`);
  console.log(`  ${plan.fresh} new  ·  ${plan.present} replace existing`);
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
