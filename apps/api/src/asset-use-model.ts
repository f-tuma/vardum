import { mimeForFilename, supportedImageMimeTypes } from "@vardum/shared";
import { z } from "zod";
import { assetKey } from "./asset-key.js";
import { transformationSchema, type Transformation } from "./transformation.js";

// Persist an explicit format so later source MIME changes cannot silently change
// a linked URL's output type. Original uses instead keep their initial MIME.
export const useTransformationSchema = transformationSchema.refine(
  (value) => Boolean(value.format),
  { message: "Choose an output format for a transformed use", path: ["format"] },
);
export const useSettingsSchema = z.object({
  displayName: z.string().trim().min(1).max(255),
  transformation: useTransformationSchema.nullable(),
}).strict();
export const createUseSchema = useSettingsSchema.extend({
  sourceAssetId: z.uuid(),
  key: assetKey,
}).strict();

export function useOutputMime(sourceMime: string, transformation: Transformation | null) {
  return transformation?.format ? `image/${transformation.format}` : sourceMime;
}

export function useCompatibilityIssue(
  key: string,
  outputMimeType: string,
  sourceMime: string | null,
  transformation: Transformation | null,
): string | null {
  if (!sourceMime) return "The source has no ready current version";
  if (transformation) {
    if (!(supportedImageMimeTypes as readonly string[]).includes(sourceMime))
      return "The current source is not a transformable image";
    if (!transformation.format || outputMimeType !== `image/${transformation.format}`)
      return "The saved output format is unavailable";
  } else if (sourceMime !== outputMimeType) {
    return "The source file type changed; choose a matching output format";
  }
  const extension = key.split("/").at(-1)!.match(/\.([^.]+)$/)?.[1];
  if (extension && mimeForFilename(key) !== outputMimeType)
    return "The path extension must match the output file type";
  return null;
}
