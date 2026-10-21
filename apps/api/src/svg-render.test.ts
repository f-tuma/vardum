import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { applyImageTransformation } from "./image-transform.js";
import { CapacityError } from "./resource-budget.js";
import { renderSvg, svgInputByteLimit, svgSourceIssue } from "./svg-render.js";

const source = Buffer.from('<?xml version="1.0" encoding="UTF-8"?><!-- source comment --><svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48" fill-rule="evenodd"><g transform="translate(4 8)"><g id="neutral-arm"><path fill="#050507" d="M0 0H16V24H0Z"/></g><g id="accent-arm"><rect x="16" width="16" height="24" fill="#c8553d"/></g></g></svg>');
const pixelLimit = 16_777_216;
async function decoded(bytes: Buffer) {
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { ...info, at(x: number, y: number) { return [...data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4)]; }, data };
}
function rejects(bytes: Buffer, recipe = {}) {
  assert.throws(() => renderSvg(bytes, { format: "svg", ...recipe }, pixelLimit), (error: unknown) => error instanceof CapacityError && error.statusCode === 422);
}

test("SVG format retains native canvas, geometry, transforms and default colors without rasterization", async () => {
  const output = renderSvg(source, { format: "svg" }, pixelLimit);
  assert.match(output.toString(), /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" width="48" height="48"/);
  assert.match(output.toString(), /<path fill="#050507" d="M0 0H16V24H0Z">/);
  assert.doesNotMatch(output.toString(), /image|data:|source comment|style/);
  assert.deepEqual((await decoded(output)).data, (await decoded(source)).data);
});


test("contain preserves the whole native source viewport when its viewBox has a different aspect ratio", async () => {
  const original = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50" viewBox="0 0 100 100"><rect width="100" height="100" fill="#c8553d"/></svg>');
  const native = renderSvg(original, { format: "svg" }, pixelLimit);
  assert.deepEqual((await decoded(native)).data, (await decoded(original)).data);
  const actual = await decoded(renderSvg(original, { format: "svg", w: 100, h: 100, fit: "contain" }, pixelLimit));
  const expected = await decoded(await sharp(original).resize({ width: 100, height: 100, fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer());
  assert.ok(actual.data.equals(expected.data), "contain must fit the original 100×50 canvas, including its existing letterboxing");
  assert.deepEqual(actual.at(24, 50), [0, 0, 0, 0]);
  assert.deepEqual(actual.at(25, 50), [200, 85, 61, 255]);
  assert.deepEqual(actual.at(74, 50), [200, 85, 61, 255]);
  assert.deepEqual(actual.at(75, 50), [0, 0, 0, 0]);
});

test("native viewport letterboxing stays registered with layer selection, adaptive colors, padding and background", async () => {
  const neutral = '<g id="neutral-arm"><rect width="40" height="100" fill="#050507"/></g>';
  const accent = '<g id="accent-arm"><rect x="40" width="40" height="100" fill="#c8553d"/></g>';
  const wrap = (content: string) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50" viewBox="0 0 100 100"><g transform="translate(10 0)">${content}</g></svg>`);
  const original = wrap(neutral + accent);
  for (const layer of [undefined, "neutral-arm", "accent-arm"]) for (const bg of [undefined, "#204060"]) {
    // A 120px canvas with floor(120 × 8.34 / 100)=10px padding leaves
    // a 100px inner box, avoiding raster resampling at artwork boundaries.
    const canvas = { w: 120, h: 120, fit: "contain", pad: 8.34, bg } as const;
    const output = renderSvg(original, { ...canvas, format: "svg", layer, darkLayer: layer ?? "neutral-arm", darkColor: "#e8e4d9" }, pixelLimit);
    const selectedOriginal = wrap(layer === "neutral-arm" ? neutral : layer === "accent-arm" ? accent : neutral + accent);
    const raster = await applyImageTransformation(sharp(selectedOriginal), { ...canvas, format: "png", q: 100 }, "png").toBuffer();
    const actual = await decoded(output), expected = await decoded(raster);
    // Palette PNG encoding can retain arbitrary RGB under zero alpha.
    // Normalize only those invisible channels before comparing every pixel.
    for (const pixels of [actual.data, expected.data]) for (let offset = 0; offset < pixels.length; offset += 4)
      if (pixels[offset + 3] === 0) pixels.fill(0, offset, offset + 3);
    assert.ok(actual.data.equals(expected.data), `whole source canvas parity: ${layer ?? "all"}, ${bg ?? "transparent"}`);
    assert.match(output.toString(), /prefers-color-scheme: dark/);
    assert.match(output.toString(), /translate\(10 0\)/);
  }
});

test("group selection keeps the full source canvas and ancestor transforms, retaining only the chosen arm", async () => {
  for (const [layer, ink, accent] of [["neutral-arm", [5, 5, 7, 255], [0, 0, 0, 0]], ["accent-arm", [0, 0, 0, 0], [200, 85, 61, 255]]] as const) {
    const output = renderSvg(source, { format: "svg", layer }, pixelLimit);
    const image = await decoded(output);
    assert.equal(image.width, 48); assert.equal(image.height, 48);
    assert.deepEqual(image.at(8, 16), ink); assert.deepEqual(image.at(24, 16), accent);
    assert.match(output.toString(), /translate\(4 8\)/);
  }
  rejects(source, { layer: "missing" });
  rejects(source, { layer: "neutral-arm", darkLayer: "accent-arm", darkColor: "#ffffff" });
});

test("SVG canvases contain the source with transparent or opaque decimal padding", async () => {
  const square = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" fill="#c8553d"/></svg>');
  for (const [pad, inset] of [[12.8, 131], [26.57, 272], [16.7, 171]]) {
    const output = renderSvg(square, { w: 1024, h: 1024, format: "svg", fit: "contain", pad }, pixelLimit);
    const image = await decoded(output);
    assert.equal(image.width, 1024); assert.equal(image.height, 1024);
    assert.deepEqual(image.at(inset! - 1, 512), [0, 0, 0, 0]);
    assert.deepEqual(image.at(inset!, 512), [200, 85, 61, 255]);
    assert.deepEqual(image.at(1024 - inset!, 512), [0, 0, 0, 0]);
  }
  const output = renderSvg(square, { w: 96, h: 48, format: "svg", bg: "#204060" }, pixelLimit);
  const image = await decoded(output);
  assert.deepEqual(image.at(4, 24), [32, 64, 96, 255]);
  assert.deepEqual(image.at(48, 24), [200, 85, 61, 255]);
  assert.equal((await decoded(renderSvg(square, { w: 96, format: "svg" }, pixelLimit))).height, 96);
});

test("adaptive output emits only fixed dark media CSS on filled shapes in the selected group", async () => {
  const output = renderSvg(source, { format: "svg", darkLayer: "neutral-arm", darkColor: "#e8e4d9" }, pixelLimit);
  assert.match(output.toString(), /<style>@media \(prefers-color-scheme: dark\)\{\.vard-adaptive-fill\{fill:#e8e4d9!important\}\}<\/style>/);
  assert.match(output.toString(), /<path fill="#050507" d="M0 0H16V24H0Z" class="vard-adaptive-fill">/);
  assert.doesNotMatch(output.toString(), /fill="#c8553d" class=/);
  assert.deepEqual((await decoded(output)).data, (await decoded(source)).data, "light output retains exact default colors");
  rejects(source, { darkLayer: "missing", darkColor: "#ffffff" });
});

test("active, referenced, foreign, malformed and unsupported XML fail closed", () => {
  const wrap = (content: string) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48">${content}</svg>`);
  for (const bytes of [
    wrap('<script>alert(1)</script>'), wrap('<foreignObject><p>html</p></foreignObject>'),
    wrap('<style>@import url(https://evil.invalid)</style>'), wrap('<image href="https://evil.invalid/a.png"/>'),
    wrap('<use href="#neutral-arm"/>'), wrap('<animate attributeName="fill" values="red;blue"/>'),
    wrap('<rect width="1" height="1" onclick="alert(1)"/>'), wrap('<rect fill="url(https://evil.invalid/a)"/>'),
    wrap('<rect style="fill:red"/>'), wrap('<rect xmlns="http://evil.invalid"/>'),
    wrap('<rect xmlns:x="http://evil.invalid" x:href="a"/>'), wrap('<rect/><rect>'),
    wrap('<g id="duplicate"/><g id="duplicate"/>'), wrap('<path d="M0 0 L"/>'),
    wrap('<path d="M0 0 A1 1 0 3 0 0 0"/>'), wrap('<g transform="constructor(1)"/>'),
    wrap('<g transform="matrix(1 2 3)"/>'), wrap('<text>not geometric</text>'),
    wrap('<![CDATA[anything]]>'), wrap('<rect width="1e999"/>'), wrap('<rect opacity="2"/>'),
    wrap('<path d="M0 0Q1 1 1"/>'), wrap('<rect fill="red" fill="blue"/>'),
    Buffer.from('<!DOCTYPE svg [<!ENTITY external SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg" width="48" height="48">&external;</svg>'),
    Buffer.from('<?xml-stylesheet href="https://evil.invalid"?><svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"/>'),
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><g></svg>'),
    Buffer.from('<?xml version="1.0" encoding="ISO-8859-1"?><svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"/>'),
    Buffer.from([0xff, 0xfe, 0, 0]),
  ]) rejects(bytes);
});

test("source, tree, numeric and output resources have hard bounds", () => {
  rejects(Buffer.alloc(svgInputByteLimit + 1, 32));
  const wrap = (content: string) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48">${content}</svg>`);
  rejects(wrap('<g>'.repeat(33) + '</g>'.repeat(33)));
  rejects(wrap('<rect/>'.repeat(2048)));
  rejects(wrap('<path d="M0 0' + 'L1 1'.repeat(32769) + '"/>'));
  rejects(wrap('<g transform="translate(1e8 0)"/>'));
  rejects(wrap('<g transform="' + 'a'.repeat(100_000) + '"/>'));
  rejects(wrap('<rect width="' + '1'.repeat(100_000) + 'x"/>'));
  rejects(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20000" height="1"/>'));
  assert.throws(() => renderSvg(source, { format: "svg", w: 4096, h: 4096 }, 100), (error: unknown) => error instanceof CapacityError && error.statusCode === 422);
});

test("SVG output and layer selection reject raster sources before any cache access", () => {
  for (const recipe of [{ format: "svg" }, { w: 48, layer: "neutral-arm" }, { format: "svg", darkLayer: "neutral-arm", darkColor: "#ffffff" }] as const)
    assert.match(svgSourceIssue("image/png", recipe)!, /SVG source/);
  assert.equal(svgSourceIssue("image/png", { format: "png" }), null);
  assert.equal(svgSourceIssue("image/svg+xml", { format: "svg" }), null);
});
