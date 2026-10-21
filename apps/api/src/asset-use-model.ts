import { mimeForFilename, supportedImageMimeTypes } from "@vardum/shared";
import { z } from "zod";
import { config } from "./config.js";
import { outputPixels } from "./output-pixels.js";
import { assetKey } from "./asset-key.js";
import { transformationSchema, type Transformation } from "./transformation.js";
import { svgSourceIssue } from "./svg-render.js";

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
  return transformation?.format === "svg" ? "image/svg+xml" : transformation?.format ? `image/${transformation.format}` : sourceMime;
}

export function useCompatibilityIssue(
  key: string,
  outputMimeType: string,
  sourceMime: string | null,
  transformation: Transformation | null,
  dimensions?: { width: number | null; height: number | null },
): string | null {
  if (!sourceMime) return "The source has no ready current version";
  if (transformation) {
    if (!(supportedImageMimeTypes as readonly string[]).includes(sourceMime))
      return "The current source is not a transformable image";
    if (!transformation.format || outputMimeType !== useOutputMime(sourceMime, transformation))
      return "The saved output format is unavailable";
    const svgIssue = svgSourceIssue(sourceMime, transformation);
    if (svgIssue) return svgIssue;
    // Metadata can reject an impossible output without reading source bytes.
    // Stored dimensions may be auto-oriented; reject only if both orientations
    // exceed budget. The renderer validates actual geometry and all frames.
    if (dimensions?.width && dimensions.height &&
        Math.min(outputPixels(dimensions.width, dimensions.height, 1, transformation),
          outputPixels(dimensions.height, dimensions.width, 1, transformation)) > config.TRANSFORM_MAX_OUTPUT_PIXELS)
      return "The output exceeds the pixel limit; choose smaller dimensions";
  } else if (sourceMime !== outputMimeType) {
    return "The source file type changed; choose a matching output format";
  }
  const extension = key.split("/").at(-1)!.match(/\.([^.]+)$/)?.[1];
  if (extension && mimeForFilename(key) !== outputMimeType)
    return "The path extension must match the output file type";
  return null;
}
