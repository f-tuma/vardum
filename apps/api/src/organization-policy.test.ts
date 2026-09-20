import assert from "node:assert/strict";
import test from "node:test";
import {
  canCreateOrganization,
  organizationCreationAccess,
} from "./organization-policy.js";

test("organization creation supports open, allowlist, and disabled modes", () => {
  assert.equal(
    canCreateOrganization(
      { email: "any@example.com", emailVerified: false },
      "open",
      "",
    ),
    true,
  );
  assert.equal(
    canCreateOrganization(
      { email: "owner@example.com", emailVerified: true },
      "disabled",
      "",
    ),
    false,
  );
  assert.equal(
    canCreateOrganization(
      { email: "OWNER@example.com", emailVerified: true },
      "allowlist",
      "other@example.com, owner@example.com",
    ),
    true,
  );
  assert.equal(
    canCreateOrganization(
      { email: "stranger@example.com", emailVerified: true },
      "allowlist",
      "owner@example.com",
    ),
    false,
  );
});

test("an allowlisted email grants no creation permission until verified", () => {
  const user = { email: "owner@example.com", emailVerified: false };
  assert.equal(canCreateOrganization(user, "allowlist", user.email), false);
  assert.equal(
    organizationCreationAccess(user, "allowlist", user.email),
    "email_verification_required",
  );
  assert.equal(
    organizationCreationAccess(
      { ...user, emailVerified: true },
      "allowlist",
      user.email,
    ),
    "allowed",
  );
});

test("verification cannot bypass a disabled policy or an absent allowlist entry", () => {
  for (const emailVerified of [false, true]) {
    const user = { email: "other@example.com", emailVerified };
    assert.equal(
      organizationCreationAccess(user, "allowlist", "owner@example.com"),
      "not_allowed",
    );
    assert.equal(
      organizationCreationAccess(user, "disabled", user.email),
      "not_allowed",
    );
    assert.equal(
      organizationCreationAccess(user, "allowlist", ""),
      "not_allowed",
    );
  }
});
