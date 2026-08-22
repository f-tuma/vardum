import assert from "node:assert/strict";
import test from "node:test";
import { canCreateOrganization } from "./organization-policy.js";

test("organization creation supports open, allowlist, and disabled modes", () => {
  assert.equal(canCreateOrganization("any@example.com", "open", ""), true);
  assert.equal(
    canCreateOrganization("owner@example.com", "disabled", ""),
    false,
  );
  assert.equal(
    canCreateOrganization(
      "OWNER@example.com",
      "allowlist",
      "other@example.com, owner@example.com",
    ),
    true,
  );
  assert.equal(
    canCreateOrganization(
      "stranger@example.com",
      "allowlist",
      "owner@example.com",
    ),
    false,
  );
});
