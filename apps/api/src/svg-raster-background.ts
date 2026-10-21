import sharp, { type Sharp } from "sharp";
import { applyImageTransformation } from "./image-transform.js";
import { outputPixels } from "./output-pixels.js";
import { CapacityError } from "./resource-budget.js";
import type { Transformation } from "./transformation.js";

/** Resize the vector with alpha first: flattening in that pipeline disables
 * Sharp's SVG loader scaling and enlarges an already rasterized source. */
export async function renderSvgRasterBackground(
  image: Sharp,
  transformation: Transformation,
  outputFormat: Exclude<Transformation["format"], "svg">,
  budget: { signal: AbortSignal; deadline: number; maxOutputPixels: number },
) {
  const secondsLeft = () => {
    budget.signal.throwIfAborted();
    const remaining = budget.deadline - Date.now();
    if (remaining <= 0) throw new DOMException("SVG raster transformation timed out", "TimeoutError");
    // Sharp accepts whole seconds. Round up so the valid one-second deployment
    // setting can run; the shared abort signal still gates every stage/write.
    return Math.ceil(remaining / 1000);
  };
  const metadata = await image.timeout({ seconds: secondsLeft() }).metadata();
  // Check decoded content too: a mislabeled animated raster must never enter
  // the raw intermediate and silently lose its frames.
  if (metadata.format !== "svg" || (metadata.pages ?? 1) !== 1)
    throw new CapacityError("Render v2 requires a static SVG source", 422);
  if (!metadata.width || !metadata.height || outputPixels(metadata.width, metadata.height, 1, transformation) > budget.maxOutputPixels)
    throw new CapacityError("Transformed image exceeds the output pixel limit. Request smaller dimensions.", 422);

  let geometry = image.timeout({ seconds: secondsLeft() });
  if (transformation.pad) {
    geometry = applyImageTransformation(geometry, { ...transformation, bg: undefined }, undefined);
  } else if (transformation.w || transformation.h) {
    // The legacy unpadded helper leaves Sharp's default opaque black contain
    // bars. V2 must retain alpha in every part of this first-stage canvas.
    geometry = geometry.resize({ width: transformation.w, height: transformation.h,
      fit: transformation.fit ?? "inside", background: { r: 0, g: 0, b: 0, alpha: 0 } });
  }
  const { data, info } = await geometry.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  // A lossless raw intermediate keeps alpha until geometry is complete. The
  // second pipeline only composites and encodes; it never resizes again.
  const canvas = sharp(data, {
    raw: { width: info.width, height: info.height, channels: info.channels },
    limitInputPixels: budget.maxOutputPixels,
  }).timeout({ seconds: secondsLeft() });
  const result = await applyImageTransformation(canvas, {
    format: transformation.format, q: transformation.q, bg: transformation.bg,
  }, outputFormat).toBuffer();
  secondsLeft();
  return result;
}
