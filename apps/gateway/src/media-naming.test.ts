import assert from "node:assert/strict";
import test from "node:test";
import { extensionMimeTypes, mediaStem, mediaOutputPath, mimeForFilename, supportedMimeTypes } from "@vardum/shared";

test("library names strip only the final supported suffix, preserving stems and directories", () => {
  for (const extension of Object.keys(extensionMimeTypes)) {
    assert.equal(mediaStem(`folder.png/logo.v2.${extension.toUpperCase()}`), "folder.png/logo.v2");
  }
  for (const name of ["logo.v2", ".png", "folder.png/logo", "readme.txt", "logo.constructor", "logo.__proto__", ""]) {
    assert.equal(mediaStem(name), name);
  }
});

test("project filenames replace their suffix once for Original and converted formats", () => {
  assert.equal(mediaOutputPath("images/favicon", "image/png"), "images/favicon.png");
  assert.equal(mediaOutputPath("images/favicon.PNG", "image/png"), "images/favicon.png");
  assert.equal(mediaOutputPath("images/logo.v2.jpg", "image/webp"), "images/logo.v2.webp");
  assert.equal(mediaOutputPath("images/logo.v2.webp", "image/jpeg"), "images/logo.v2.jpg");
  assert.equal(mediaOutputPath("images/logo.constructor", "image/webp"), "images/logo.constructor.webp");
  assert.equal(mediaOutputPath("images/logo", "constructor"), "images/logo");
  assert.equal(mimeForFilename("logo.constructor"), null);
  assert.equal(mimeForFilename("logo.__proto__"), null);
  for (const mimeType of supportedMimeTypes) {
    const path = mediaOutputPath("brand/file.png", mimeType);
    assert.equal(mediaStem(path), "brand/file");
    assert.equal(mediaOutputPath(path, mimeType), path);
  }
});
