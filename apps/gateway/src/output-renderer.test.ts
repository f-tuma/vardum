import assert from "node:assert/strict";
import test from "node:test";
import { withOutputRenderer } from "./output-renderer";

test("new SVG background recipes opt in for both inside and padded contain output", () => {
  for (const recipe of [
    { format: "png", bg: "#050507" },
    { format: "png", bg: "#050507", w: 180, h: 180, fit: "contain", pad: 14 },
    { format: "webp", bg: "#050507", w: 180, fit: "inside" },
  ] as const) assert.deepEqual(withOutputRenderer(recipe, "image/svg+xml"), { ...recipe, render: "v2" });
  const png = { format: "png", bg: "#050507" } as const;
  assert.deepEqual(withOutputRenderer(png, "image/png"), png);
  assert.deepEqual(withOutputRenderer({ format: "svg", bg: "#050507" }, "image/svg+xml"), { format: "svg", bg: "#050507" });
  assert.equal(withOutputRenderer(null, "image/svg+xml"), null);
});

test("stored legacy recipes preserve omission through unrelated and geometry edits", () => {
  const initial = { format: "png", bg: "#050507", w: 1024 } as const;
  for (const recipe of [initial, { ...initial, w: 180 }, { ...initial, bg: "#ffffff" }]) {
    const saved = withOutputRenderer(recipe, "image/svg+xml", initial);
    assert.deepEqual(saved, recipe);
    assert.equal(Object.hasOwn(saved!, "render"), false);
  }
  const v2 = { ...initial, render: "v2" } as const;
  assert.deepEqual(withOutputRenderer(initial, "image/svg+xml", v2), v2);
  assert.deepEqual(withOutputRenderer(v2, "image/svg+xml", initial), v2, "explicit upgrades are preserved");
  assert.deepEqual(withOutputRenderer({ ...v2, format: "svg" }, "image/svg+xml", v2), { ...initial, format: "svg" });
  assert.deepEqual(withOutputRenderer({ ...v2, bg: undefined }, "image/svg+xml", v2), { ...initial, bg: undefined });
});
