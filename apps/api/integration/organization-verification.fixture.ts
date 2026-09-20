import assert from "node:assert/strict";
import { buildApp } from "../src/app.js";
import { auth } from "../src/auth.js";
import { closeDatabase, pool } from "../src/db/index.js";

// Invoked only by organization-verification.test.ts against its disposable DB.
const smtp = process.env.VARDUM_TEST_SMTP;
assert.ok(smtp === "enabled" || smtp === "disabled");
const email = `owner-${smtp}@example.com`;
const origin = "http://localhost:3000";
const sent: Array<{ email: string; url: string }> = [];
const context = await auth.$context;
if (smtp === "enabled") {
  assert.ok(context.options.emailVerification?.sendVerificationEmail);
  // Stub only outbound delivery; real Better Auth tokens and endpoints are used.
  context.options.emailVerification.sendVerificationEmail = async ({
    user,
    url,
  }) => {
    sent.push({ email: user.email, url });
  };
}
const app = await buildApp();
let cookie = "";
async function request(path: string, body?: Record<string, unknown>) {
  const response = await app.inject({
    method: body ? "POST" : "GET",
    url: path,
    headers: { host: "localhost:3000", origin, ...(cookie ? { cookie } : {}) },
    ...(body ? { payload: body } : {}),
  });
  const setCookie = response.headers["set-cookie"];
  const sessionCookie = (
    Array.isArray(setCookie) ? setCookie : [setCookie]
  ).find((value) => value?.startsWith("better-auth.session_token="));
  if (sessionCookie) cookie = sessionCookie.split(";", 1)[0]!;
  return response;
}
const create = () =>
  request("/api/auth/organization/create", {
    name: "Verified owner",
    slug: `verified-${smtp}`,
  });
async function directory(status: string) {
  const response = await request("/api/organizations");
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().organizationCreation.status, status);
  assert.equal(response.json().canCreateOrganization, status === "allowed");
  assert.equal(
    response.json().organizationCreation.verificationEmailEnabled,
    smtp === "enabled",
  );
}

try {
  const signup = await request("/api/auth/sign-up/email", {
    name: "Unverified owner",
    email,
    password: "disposable-fixture-password",
    emailVerified: true,
  });
  assert.equal(signup.statusCode, 200);
  assert.equal(
    signup.json().user.emailVerified,
    false,
    "client-provided verification must be ignored",
  );
  assert.ok(cookie);
  await directory("email_verification_required");
  assert.equal(
    (await create()).statusCode,
    403,
    "direct API call must be denied, not just the UI",
  );

  await request("/api/auth/update-user", { emailVerified: true });
  await directory("email_verification_required");
  assert.equal((await create()).statusCode, 403);
  const resend = await request("/api/auth/send-verification-email", {
    email,
    callbackURL: `${origin}/app`,
  });
  if (smtp === "enabled") {
    assert.equal(resend.statusCode, 200);
    assert.ok(
      sent.length >= 2,
      "signup and resend must both send verification",
    );
    assert.equal(sent.at(-1)?.email, email);
    const invalid = await request(
      `/api/auth/verify-email?token=invalid&callbackURL=${encodeURIComponent(`${origin}/app`)}`,
    );
    assert.equal(invalid.statusCode, 302);
    assert.match(String(invalid.headers.location), /error=INVALID_TOKEN/);
    await directory("email_verification_required");
    const url = new URL(sent.at(-1)!.url);
    const verified = await request(url.pathname + url.search);
    assert.equal(verified.statusCode, 302);
    assert.equal(verified.headers.location, `${origin}/app`);
  } else {
    assert.equal(resend.statusCode, 400);
    assert.equal(sent.length, 0);
    await directory("email_verification_required");
    assert.equal(
      (await create()).statusCode,
      403,
      "missing SMTP must never waive verification",
    );
    // Represents an account already verified before SMTP was disabled.
    await pool.query(
      'UPDATE "user" SET email_verified = true WHERE email = $1',
      [email],
    );
  }
  await directory("allowed");
  assert.equal((await create()).statusCode, 200);

  cookie = "";
  const outsider = `outsider-${smtp}@example.com`;
  assert.equal(
    (
      await request("/api/auth/sign-up/email", {
        name: "Outsider",
        email: outsider,
        password: "disposable-fixture-password",
      })
    ).statusCode,
    200,
  );
  await pool.query('UPDATE "user" SET email_verified = true WHERE email = $1', [
    outsider,
  ]);
  await directory("not_allowed");
  assert.equal(
    (await create()).statusCode,
    403,
    "verified users still need an allowlist entry",
  );
  console.log("Organization verification checks passed");
} finally {
  await app.close();
  await closeDatabase();
}
