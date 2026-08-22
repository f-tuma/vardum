import assert from "node:assert/strict";
import test from "node:test";
import { vardOutputPath } from "./vard-routes.js";

test("Vard output paths stay inside the project", () => {
  for (const path of [
    "assets/icon.png",
    "ios/AppIcon.appiconset/icon@2x.png",
    "android/res/drawable/logo.webp",
  ])
    assert.equal(vardOutputPath.safeParse(path).success, true, path);

  for (const path of [
    "/etc/passwd",
    "../secret",
    "assets/../../secret",
    "assets\\icon.png",
    "assets//icon.png",
    "C:/secret.png",
    "assets/icon?.png",
  ])
    assert.equal(vardOutputPath.safeParse(path).success, false, path);
});
