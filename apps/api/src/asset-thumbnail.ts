import type { Transformation } from "./transformation.js";

/** Automatic previews fit their frame without enlarging or cropping the source. */
export function thumbnailTransformation(item: { width: number | null; height: number | null }): Transformation {
  return {
    ...(item.width && item.height
      ? { w: Math.min(item.width, 640), h: Math.min(item.height, 400), fit: "inside" as const }
      : {}),
    format: "webp",
    q: 72,
  };
}
