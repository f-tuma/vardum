import type { Sharp } from "sharp";
import type { Transformation } from "./transformation.js";

/** Apply output operations without changing the legacy pipeline when bg is absent. */
export function applyImageTransformation(
  image: Sharp,
  transformation: Transformation,
  outputFormat: Transformation["format"],
) {
  if (transformation.bg) image = image.flatten({ background: transformation.bg });
  if (transformation.w || transformation.h) {
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
