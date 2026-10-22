import { CapacityError } from "./resource-budget.js";
import type { Transformation } from "./transformation.js";

type Recipe = Pick<Transformation, "w" | "h" | "fit" | "pad">;
type Interval = readonly [number, number];
type Canvas = { w: number; h: number };
export type SvgRasterBranch = "legacy-background" | "svg-loader-scale";
export type SvgRasterBounds = {
  source: Canvas;
  loader: { w: Interval; h: Interval };
  preCropUpper: Canvas;
  finalUpper: Canvas;
};

const intermediatePixels = 100_000_000;
const loaderSide = 32_767;
const fits = new Set(["inside", "outside", "cover", "contain", "fill"]);
const limitMessage = "SVG image exceeds the output pixel limit or cannot be safely bounded. Request smaller dimensions or re-export the SVG canvas.";
const nativeLimits = new Set([
  "Input image exceeds pixel limit",
  "Input SVG image exceeds 32767x32767 pixel limit",
  "Input SVG image will exceed 32767x32767 pixel limit when scaled",
]);

function rejected(): never {
  throw new CapacityError(limitMessage, 422);
}

function positiveInteger(value: number | undefined): value is number {
  return Number.isSafeInteger(value) && value! > 0;
}

function withinArea({ w, h }: Canvas, limit: number) {
  return positiveInteger(w) && positiveInteger(h) && w <= Math.floor(limit / h);
}

/** Pinned Sharp 0.35.5 ResolveShrink, with both enlargement flags false.
 * Its final per-axis clamp keeps a shrinking axis from becoming zero. */
function loaderScale(w: number, h: number, target: Recipe) {
  let x = 1, y = 1;
  if (target.w && target.h) {
    x = w / target.w; y = h / target.h;
    if (target.fit === "cover" || target.fit === "outside") x = y = Math.min(x, y);
    else if (target.fit !== "fill") x = y = Math.max(x, y);
  } else if (target.w) {
    x = w / target.w;
    if (target.fit !== "fill") y = x;
  } else if (target.h) {
    y = h / target.h;
    if (target.fit !== "fill") x = y;
  }
  return 1 / Math.min(Math.min(x, w), Math.min(y, h));
}

function scaledSide(side: number, scale: number): Interval {
  // At unchanged density, metadata n encloses a natural side in
  // [n - .5, n + .5]. libvips rounds the natural side *after* loader scaling.
  // Widen only this uncertain calculation. The positive arithmetic paths are
  // short and bounded; 64 binary64 epsilons also cover native evaluation order.
  const lower = (side - 0.5) * scale, upper = (side + 0.5) * scale;
  const margin = (value: number) => 64 * Number.EPSILON * Math.max(1, value);
  if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower <= 0) rejected();
  return [Math.max(1, Math.floor(lower - margin(lower))), Math.ceil(upper + margin(upper))];
}

function crossUpper(target: number, numerator: number, denominator: number) {
  // All operands are positive integers, and the loader has already passed its
  // side/area limits. Exact rational ceil preserves integer target boundaries.
  // Native nearest rounding cannot exceed this ceil: its bounded floating-point
  // error is far below the half-pixel gap to the next integer output size.
  const product = BigInt(target) * BigInt(numerator);
  return Number((product + BigInt(denominator) - 1n) / BigInt(denominator));
}

/** Admission bounds only: never use these values as replacement resize
 * parameters or as a new render/cache namespace. Metadata intervals can reject
 * an actually smaller image; accepted requests keep their existing renderer.
 *
 * Assumptions: static SVG, unchanged density, default resize kernel, no rotate,
 * trim or extract, and withoutEnlargement/withoutReduction both false. The
 * branch must describe the actual pipeline: legacy bg's working colour space
 * disables reload; v2 retains loader scaling before its separate bg stage.
 *
 * Sources: Sharp v0.35.5 src/common.cc ResolveShrink and src/pipeline.cc;
 * libvips v8.18.7 foreign/svgload.c and resample/{reduceh.cpp,transform.c}.
 */
export function svgRasterBounds(
  metadata: { width?: number; height?: number },
  recipe: Recipe,
  branch: SvgRasterBranch,
): SvgRasterBounds {
  const { width: w, height: h } = metadata;
  if (!positiveInteger(w) || !positiveInteger(h) || !withinArea({ w, h }, intermediatePixels)) rejected();
  if (branch !== "legacy-background" && branch !== "svg-loader-scale") rejected();
  for (const side of [recipe.w, recipe.h])
    if (side !== undefined && (!positiveInteger(side) || side > 4096)) rejected();
  if ((recipe.fit !== undefined && !fits.has(recipe.fit)) ||
      (recipe.pad !== undefined && (!Number.isFinite(recipe.pad) || recipe.pad < 0 || recipe.pad > 45))) rejected();
  if (recipe.pad && (!recipe.w || !recipe.h || recipe.fit !== "contain")) rejected();

  const inset = recipe.pad ? Math.floor(Math.min(recipe.w!, recipe.h!) * recipe.pad / 100) : 0;
  const target = recipe.pad
    ? { w: recipe.w! - 2 * inset, h: recipe.h! - 2 * inset, fit: "contain" as const }
    : { w: recipe.w, h: recipe.h, fit: recipe.fit ?? "inside" };
  const scale = branch === "svg-loader-scale" && (target.w || target.h) ? loaderScale(w, h, target) : 1;
  const x: Interval = scale === 1 ? [w, w] : scaledSide(w, scale);
  const y: Interval = scale === 1 ? [h, h] : scaledSide(h, scale);
  if (x[1] > loaderSide || y[1] > loaderSide || !withinArea({ w: x[1], h: y[1] }, intermediatePixels)) rejected();

  let upperW: number, upperH: number;
  if (target.fit === "fill" || (!target.w && !target.h)) {
    upperW = target.w ?? x[1]; upperH = target.h ?? y[1];
  } else if (target.w && target.h) {
    const crossW = crossUpper(target.h, x[1], y[0]);
    const crossH = crossUpper(target.w, y[1], x[0]);
    const expand = target.fit === "cover" || target.fit === "outside";
    upperW = expand ? Math.max(target.w, crossW) : Math.min(target.w, crossW);
    upperH = expand ? Math.max(target.h, crossH) : Math.min(target.h, crossH);
  } else if (target.w) {
    upperW = target.w; upperH = crossUpper(target.w, y[1], x[0]);
  } else {
    upperW = crossUpper(target.h!, x[1], y[0]); upperH = target.h!;
  }
  const preCropUpper = { w: Math.max(1, upperW), h: Math.max(1, upperH) };
  if (!withinArea(preCropUpper, intermediatePixels)) rejected();
  const canvasSide = (side: number, requested: number | undefined) => requested === undefined ? side
    : target.fit === "cover" ? Math.min(side, requested)
    : target.fit === "contain" ? Math.max(side, requested) : side;
  const finalUpper = {
    w: canvasSide(preCropUpper.w, target.w) + 2 * inset,
    h: canvasSide(preCropUpper.h, target.h) + 2 * inset,
  };
  return { source: { w, h }, loader: { w: x, h: y }, preCropUpper, finalUpper };
}

export function assertSvgRasterBudget(
  metadata: { width?: number; height?: number },
  recipe: Recipe,
  branch: SvgRasterBranch,
  maxOutputPixels: number,
) {
  if (!positiveInteger(maxOutputPixels) || maxOutputPixels > intermediatePixels) rejected();
  const bounds = svgRasterBounds(metadata, recipe, branch);
  if (!withinArea(bounds.finalUpper, maxOutputPixels)) rejected();
  return bounds;
}

/** Convert only known native geometry-limit errors at SVG processing sites. */
export function svgRasterLimitError(error: unknown): unknown {
  return error instanceof Error && !(error instanceof CapacityError) && error.name === "Error" && nativeLimits.has(error.message)
    ? new CapacityError(limitMessage, 422) : error;
}
