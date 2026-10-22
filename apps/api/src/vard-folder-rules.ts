import { createHash } from "node:crypto";
import { mediaOutputPath, mimeForFilename, type VardFolderRuleV2 } from "@vardum/shared";
import { z } from "zod";

export const MAX_VARD_OUTPUTS = 1000;

function safeRelativePath(value: string) {
  return (
    value.length > 0 &&
    value === value.trim() &&
    !/[<>:"|?*\\\u0000-\u001f\u007f]/u.test(value) &&
    value.split("/").every((part) => part && part !== "." && part !== "..")
  );
}

function safeOutputPath(value: string) {
  return (
    safeRelativePath(value) &&
    value
      .split("/")
      .every(
        (part) =>
          !/[. ]$/.test(part) &&
          !/^(?:\.git|vardum\.json|\.vardum(?:\..*)?|con|prn|aux|nul|com[1-9]|lpt[1-9])(?:$|\.)/i.test(
            part,
          ),
      )
  );
}

export const vardOutputPath = z
  .string()
  .min(1)
  .max(500)
  .refine(
    safeOutputPath,
    "Output path must be a safe relative path (not a control file or reserved name)",
  );

const directoryPrefix = z
  .string()
  .max(255)
  .refine(
    (value) =>
      value === "" ||
      (value.endsWith("/") && safeRelativePath(value.slice(0, -1))),
    "Folder prefix must be empty (root) or a safe slash-terminated relative directory",
  );
export const folderRulesSchema = z
  .array(
    z
      .object({
        sourcePrefix: directoryPrefix,
        outputPrefix: directoryPrefix.refine(
          (value) => value === "" || safeOutputPath(value.slice(0, -1)),
          "Output prefix must not contain control files or reserved names",
        ),
      })
      .strict(),
  )
  .max(64);

// Wire2 alone admits explicit linked-use intent. Legacy schema above stays strict.
export const folderRulesV2Schema = z.array(z.object({
  sourcePrefix: directoryPrefix,
  outputPrefix: directoryPrefix.refine(
    (value) => value === "" || safeOutputPath(value.slice(0, -1)),
    "Output prefix must not contain control files or reserved names",
  ),
  includeUses: z.boolean().optional(),
}).strict().transform(({ sourcePrefix, outputPrefix, includeUses }) => ({
  sourcePrefix, outputPrefix, ...(includeUses === true ? { includeUses: true as const } : {}),
}))).max(64);

export class VardResolutionError extends Error {
  readonly statusCode = 409;
}

// Asset identity + destination, not rule position or version, defines generated membership.
export function folderItemId(assetId: string, outputPath: string) {
  const hash = createHash("sha256")
    .update(JSON.stringify([assetId, outputPath]))
    .digest("hex");
  return `folder:${hash}`;
}

export function folderOutputPath(
  key: string,
  mimeType: string,
  rule: { sourcePrefix: string; outputPrefix: string },
) {
  const relative = rule.outputPrefix + key.slice(rule.sourcePrefix.length);
  return mimeForFilename(relative) ? relative : mediaOutputPath(relative, mimeType);
}

export function validateResolvedOutputs(paths: string[]) {
  if (paths.length > MAX_VARD_OUTPUTS)
    throw new VardResolutionError(
      "Vard resolves to more than 1000 outputs; reduce manual items or folder rules",
    );
  const seen = new Set<string>();
  for (const path of paths) {
    if (!vardOutputPath.safeParse(path).success)
      throw new VardResolutionError(
        "Vard contains an unsafe output path; repair manual items or folder rules",
      );
    const key = path.normalize("NFC").toLowerCase();
    if (seen.has(key))
      throw new VardResolutionError(
        "Vard output paths collide (including case/Unicode equivalents); repair manual items or folder rules",
      );
    seen.add(key);
  }
  for (const path of seen) {
    const parts = path.split("/");
    for (let length = 1; length < parts.length; length++)
      if (seen.has(parts.slice(0, length).join("/")))
        throw new VardResolutionError(
          "Vard output paths overlap as file and directory; repair manual items or folder rules",
        );
  }
}

export type FolderMembershipItem = {
  id: string;
  assetId: string;
  outputPath: string;
  bindingKind: "source" | "use";
  assetUseId: string | null;
};
export type FolderSourceCandidate = { assetId: string; key: string; mimeType: string };
/** key is the use's matching key, never the canonical source key. */
export type FolderUseCandidate = {
  assetUseId: string; assetId: string; key: string; outputMimeType: string;
};

export function folderUseItemId(assetUseId: string, outputPath: string) {
  const hash = createHash("sha256")
    .update(JSON.stringify([assetUseId, outputPath]))
    .digest("hex");
  return `folder:use:${hash}`;
}

/** One namespace calculation for manifests and both import phases. */
export function resolveFolderMembership(
  manual: readonly FolderMembershipItem[],
  sources: readonly FolderSourceCandidate[],
  uses: readonly FolderUseCandidate[],
  rules: readonly VardFolderRuleV2[],
): FolderMembershipItem[] {
  const items = [...manual];
  const append = (item: FolderMembershipItem) => {
    items.push(item);
    if (items.length > MAX_VARD_OUTPUTS)
      validateResolvedOutputs(items.map((row) => row.outputPath));
  };
  for (const source of sources) for (const rule of rules) {
    if (!source.key.startsWith(rule.sourcePrefix)) continue;
    const outputPath = folderOutputPath(source.key, source.mimeType, rule);
    append({ id: folderItemId(source.assetId, outputPath), assetId: source.assetId,
      outputPath, bindingKind: "source", assetUseId: null });
  }
  for (const use of uses) for (const rule of rules) {
    if (rule.includeUses !== true || !use.key.startsWith(rule.sourcePrefix)) continue;
    const outputPath = folderOutputPath(use.key, use.outputMimeType, rule);
    append({ id: folderUseItemId(use.assetUseId, outputPath), assetId: use.assetId,
      outputPath, bindingKind: "use", assetUseId: use.assetUseId });
  }
  validateResolvedOutputs(items.map((item) => item.outputPath));
  return items;
}
