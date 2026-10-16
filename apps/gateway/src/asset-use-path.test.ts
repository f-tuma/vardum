import assert from "node:assert/strict";
import test from "node:test";
import { defaultUsePath } from "./asset-use-path.js";

test("dotted source names generate usable extensionless paths without changing destination folders", () => {
  assert.equal(defaultUsePath("mobile/", "hero.v2.png"), "mobile/hero-v2");
  assert.equal(defaultUsePath("brand.v2/", "brand.logo.svg"), "brand.v2/brand-logo");
  assert.equal(defaultUsePath("", "Shared logo.PNG"), "shared-logo");
});
