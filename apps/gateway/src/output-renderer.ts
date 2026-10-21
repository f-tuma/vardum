import type { Transformation } from "@vardum/shared";

/** Author new SVG background recipes with v2, preserving saved renderer identity.
 * Opening or editing a stored legacy recipe is not an implicit upgrade. */
export function withOutputRenderer(
  transformation: Transformation | null,
  sourceMimeType: string | null | undefined,
  initial?: Transformation | null,
): Transformation | null {
  if (!transformation) return transformation;
  const { render, ...recipe } = transformation;
  if (!recipe.bg || !recipe.format || recipe.format === "svg")
    return render ? recipe : transformation;
  const selected = render ?? initial?.render ?? (!initial && sourceMimeType === "image/svg+xml" ? "v2" : undefined);
  return selected ? { ...recipe, render: selected } : transformation;
}
