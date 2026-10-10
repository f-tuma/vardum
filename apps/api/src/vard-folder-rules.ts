import { createHash } from "node:crypto";
import { mediaOutputPath, mimeForFilename } from "@vardum/shared";
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
