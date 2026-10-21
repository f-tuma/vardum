import type { Sharp } from "sharp";
import type { Transformation } from "./transformation.js";

/** Optional padding leaves the legacy pipeline unchanged when absent or zero. */
export function applyImageTransformation(
  image: Sharp,
  transformation: Transformation,
  outputFormat: Exclude<Transformation["format"], "svg">,
) {
  if (transformation.bg) {
    // Flatten uses the working color space. Convert before compositing so
    // grayscale sources do not turn the selected RGB background into gray.
    image = image.pipelineColourspace("srgb").flatten({ background: transformation.bg });
  }
  if (transformation.pad) {
    // The schema requires an exact final canvas and contain fit for padding.
    // Use source bounds as supplied, including any existing transparent margin.
    const width = transformation.w!;
    const height = transformation.h!;
    const inset = Math.floor(Math.min(width, height) * transformation.pad / 100);
    const background = transformation.bg ?? { r: 0, g: 0, b: 0, alpha: 0 };
    image = image.resize({ width: width - 2 * inset, height: height - 2 * inset,
      fit: "contain", background });
    if (inset) image = image.extend({ top: inset, bottom: inset, left: inset, right: inset, background });
  } else if (transformation.w || transformation.h) {
    image = image.resize({
      width: transformation.w,
      height: transformation.h,
      fit: transformation.fit ?? "inside",
      ...(transformation.bg ? { background: transformation.bg } : {}),
    });
  }
  // Sharp flattens before resize. Contain padding can introduce an alpha band
  // afterwards, so also remove it after the opaque canvas has been composed.
  if (transformation.bg) image = image.removeAlpha();
  const quality = transformation.q ?? 80;
  switch (outputFormat) {
    case "avif": return image.avif({ quality });
    case "jpeg": return image.jpeg({ quality });
    case "png": return image.png({ quality });
    case "webp": return image.webp({ quality });
    default: return image;
  }
}
