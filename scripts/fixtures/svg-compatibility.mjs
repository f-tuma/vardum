import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

export const svgInputPixelLimit = 100_000_000;
export const svgFixtureDimensions = Object.freeze({ width: 16, height: 8 });
export const svgVariantDimensions = Object.freeze({ width: 64, height: 32 });
const red = Object.freeze([255, 0, 0, 255]);
const green = Object.freeze([0, 255, 0, 255]);
const blue = Object.freeze([0, 0, 255, 255]);
// Predetermined ordinary 2x1 RGBA PNG: both pixels are opaque green. Its PNG
// chunks and zlib scanline were generated independently of sharp/librsvg.
const embeddedPng = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADElEQVR4nGNg+A+BAA/5A/3YOXFBAAAAAElFTkSuQmCC";
const accentedBody = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="8"><style>rect { fill: #0000ff; } .caf\\e9 { fill: #ff0000; }</style><rect class="café" width="16" height="8"/></svg>';
const embeddedBody = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="8"><rect width="16" height="8" fill="#0000ff"/><image width="16" height="8" preserveAspectRatio="none" href="data:image/png;base64,${embeddedPng}"/></svg>`;

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Always return new buffers: callers can prove input immutability independently.
export function svgCompatibilityFixtures() {
  return [
    { name: "utf8-accented", filename: "café-utf8.svg", encoding: "UTF-8", bytes: Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>${accentedBody}`, "utf8"), rgba: red },
    { name: "latin1-accented", filename: "café-latin1.svg", encoding: "ISO-8859-1", bytes: Buffer.from(`<?xml version="1.0" encoding="ISO-8859-1"?>${accentedBody}`, "latin1"), rgba: red },
    { name: "embedded-png", filename: "café-embedded.svg", encoding: "UTF-8", bytes: Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>${embeddedBody}`, "utf8"), rgba: green },
  ];
}

export function invalidSvgFixture() {
  return Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="8"><rect width="16" height="8"></svg>');
}

export function assertSolidRgba({ data, info }, dimensions, rgba, label) {
  assert.equal(info.width, dimensions.width, `${label}: width`);
  assert.equal(info.height, dimensions.height, `${label}: height`);
  assert.equal(info.channels, 4, `${label}: RGBA channels`);
  assert.equal(data.length, dimensions.width * dimensions.height * 4, `${label}: byte count`);
  for (let offset = 0; offset < data.length; offset++) {
    assert.equal(data[offset], rgba[offset % 4], `${label}: exact RGBA byte ${offset}`);
  }
}

export async function assertSvgPngVariant(sharp, png, fixture, label = fixture.name) {
  const metadata = await sharp(png, { limitInputPixels: svgInputPixelLimit }).metadata();
  assert.equal(metadata.format, "png", `${label}: PNG format`);
  assert.deepEqual([metadata.width, metadata.height], [svgVariantDimensions.width, svgVariantDimensions.height], `${label}: bounded PNG dimensions`);
  const pixels = await sharp(png, { limitInputPixels: svgInputPixelLimit }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assertSolidRgba(pixels, svgVariantDimensions, fixture.rgba, `${label}: PNG pixels`);
  return { pngSha256: sha256(png), rgbaSha256: sha256(pixels.data), width: metadata.width, height: metadata.height };
}

export async function checkSvgFixture(sharp, fixture) {
  const original = Buffer.from(fixture.bytes);
  const inputSha256 = sha256(original);
  const metadata = await sharp(fixture.bytes, { limitInputPixels: svgInputPixelLimit }).metadata();
  assert.equal(metadata.format, "svg", `${fixture.name}: detected SVG`);
  assert.deepEqual([metadata.width, metadata.height], [svgFixtureDimensions.width, svgFixtureDimensions.height], `${fixture.name}: source dimensions`);
  // Check real source pixels first. Neither equal blank images nor unavailable
  // glyphs can disguise a lost accent: the ASCII CSS escape must match café.
  const raw = await sharp(fixture.bytes, { limitInputPixels: svgInputPixelLimit }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assertSolidRgba(raw, svgFixtureDimensions, fixture.rgba, `${fixture.name}: source pixels`);
  const png = await sharp(fixture.bytes, { limitInputPixels: svgInputPixelLimit }).resize({ width: svgVariantDimensions.width }).png().toBuffer();
  const variant = await assertSvgPngVariant(sharp, png, fixture);
  assert.deepEqual(fixture.bytes, original, `${fixture.name}: input bytes unchanged`);
  assert.equal(sha256(fixture.bytes), inputSha256, `${fixture.name}: input hash unchanged`);
  return { name: fixture.name, encoding: fixture.encoding, inputBytes: original.length, inputSha256, sourceRgbaSha256: sha256(raw.data), inputUnchanged: true, ...variant };
}

export async function checkSvgSemanticControls(sharp) {
  const controls = [
    { name: "unmatched-accented-class", bytes: Buffer.from(accentedBody.replace('class="café"', 'class="cafe"')), rgba: blue },
    { name: "missing-embedded-png", bytes: Buffer.from(embeddedBody.replace(/<image[^>]*\/>/, "")), rgba: blue },
  ];
  for (const control of controls) {
    const raw = await sharp(control.bytes, { limitInputPixels: svgInputPixelLimit }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assertSolidRgba(raw, svgFixtureDimensions, control.rgba, control.name);
  }
  return controls.map(({ name }) => ({ name, status: "expected-blue-fallback" }));
}

export async function checkSvgCompatibility(sharp) {
  const fixtures = svgCompatibilityFixtures();
  assert.ok(fixtures[0].bytes.includes(Buffer.from('class="café"', "utf8")), "UTF-8 fixture must contain the accented UTF-8 bytes");
  assert.ok(fixtures[1].bytes.includes(Buffer.from('class="café"', "latin1")), "Latin-1 fixture must contain the actual 0xe9 byte");
  assert.ok(!fixtures[1].bytes.includes(Buffer.from('class="café"', "utf8")), "Latin-1 fixture must not contain the UTF-8 accent bytes");
  const results = [];
  for (const fixture of fixtures) results.push(await checkSvgFixture(sharp, fixture));
  assert.equal(results[0].sourceRgbaSha256, results[1].sourceRgbaSha256, "Equivalent accented encodings must render identically");
  return { fixtures: results, semanticControls: await checkSvgSemanticControls(sharp) };
}

// A test-runner timeout cannot interrupt a native parser loop. Run this ordinary
// malformed XML in a disposable process, with an actual SIGKILL deadline.
export function classifyInvalidSvg(sharpModuleUrl, { timeoutMs = 15_000 } = {}) {
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 15_000);
  const bytes = invalidSvgFixture();
  const inputSha256 = sha256(bytes);
  const code = `
    const { writeSync } = await import("node:fs");
    const { default: sharp } = await import(process.argv[1]);
    const bytes = Buffer.from(process.argv[2], "base64");
    try {
      await sharp(bytes, { limitInputPixels: ${svgInputPixelLimit} }).metadata();
      await sharp(bytes, { limitInputPixels: ${svgInputPixelLimit} }).ensureAlpha().raw().toBuffer();
      writeSync(1, JSON.stringify({ status: "accepted" }));
    } catch {
      writeSync(1, JSON.stringify({ status: "rejected" }));
    }
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code, sharpModuleUrl, bytes.toString("base64")], { stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    let timedOut = false;
    let overflow = false;
    const deadline = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      if (overflow) return;
      if (output.length + chunk.length > 512) {
        overflow = true;
        child.kill("SIGKILL");
        return;
      }
      output += chunk.toString();
    });
    child.once("error", () => { clearTimeout(deadline); reject(new Error("SVG classification child could not start")); });
    child.once("close", (code, signal) => {
      clearTimeout(deadline);
      if (timedOut) return resolve({ status: "timed-out", inputSha256, deadlineMs: timeoutMs, signal });
      if (overflow || code !== 0) return resolve({ status: "child-failed", inputSha256 });
      try {
        const result = JSON.parse(output);
        assert.ok(["accepted", "rejected"].includes(result.status));
        resolve({ status: result.status, inputSha256, deadlineMs: timeoutMs });
      } catch { reject(new Error("SVG classification child returned invalid evidence")); }
    });
  });
}
