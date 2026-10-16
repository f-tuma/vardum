export function outputPixels(
  width: number,
  height: number,
  pages: number,
  resize: { w?: number; h?: number; fit?: string },
) {
  if (!resize.w && !resize.h) return width * height * pages;
  if (
    resize.w &&
    resize.h &&
    ["cover", "contain", "fill"].includes(resize.fit ?? "inside")
  )
    return resize.w * resize.h * pages;
  const ratios = [
    resize.w ? resize.w / width : undefined,
    resize.h ? resize.h / height : undefined,
  ].filter((x): x is number => x !== undefined);
  const scale =
    resize.fit === "outside" ? Math.max(...ratios) : Math.min(...ratios);
  return Math.ceil(width * scale) * Math.ceil(height * scale) * pages;
}
