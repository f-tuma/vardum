import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { supportedImageMimeTypes } from "@vardum/shared";
import { detectMimeType } from "./asset-processor.js";

// URL loading keeps these test-only fixtures outside the API production build
// inputs. Both the API test runner and deployed-image probe use the same bytes.
const fixtures = await import(new URL("../../../scripts/fixtures/svg-compatibility.mjs", import.meta.url).href);

test("accented UTF-8 and actual Latin-1 SVGs preserve semantics and bounded PNG pixels", async () => {
  const results = await fixtures.checkSvgCompatibility(sharp);
  assert.deepEqual(results.fixtures.map((result: { name: string }) => result.name), [
    "utf8-accented", "latin1-accented", "embedded-png",
  ]);
  for (const fixture of fixtures.svgCompatibilityFixtures()) {
    const metadata = await sharp(fixture.bytes, { limitInputPixels: fixtures.svgInputPixelLimit }).metadata();
    assert.equal(detectMimeType(metadata.format, "image/svg+xml"), "image/svg+xml");
  }
  assert.ok(supportedImageMimeTypes.includes("image/svg+xml"));
});

test("ordinary malformed SVG is classified as rejected in a child with a hard deadline", { timeout: 20_000 }, async () => {
  const result = await fixtures.classifyInvalidSvg(import.meta.resolve("sharp"));
  assert.equal(result.status, "rejected");
  assert.equal(result.deadlineMs, 15_000);
  assert.match(result.inputSha256, /^[a-f0-9]{64}$/);
});

test("invalid SVG classifier kills an unresponsive child at its hard deadline", { timeout: 5_000 }, async () => {
  const stalledImport = `data:text/javascript;base64,${Buffer.from("for (;;) {}", "utf8").toString("base64")}`;
  const result = await fixtures.classifyInvalidSvg(stalledImport, { timeoutMs: 250 });
  assert.equal(result.status, "timed-out");
  assert.equal(result.signal, "SIGKILL");
});
