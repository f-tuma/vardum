import assert from "node:assert/strict";
import { mock } from "node:test";
import nodemailer from "nodemailer";
import { createEmailVerificationToken } from "better-auth/api";

// Only outbound SMTP is replaced; real app mail templates, tokens, auth endpoints
// and cookies run against organization-verification.test.ts's disposable DB.
const smtp = process.env.VARDUM_TEST_SMTP;
assert.ok(smtp === "enabled" || smtp === "disabled");
const email = `owner-${smtp}@example.com`;
const origin = "http://localhost:3000";
const sent: Array<{ email: string; subject: string; url: string }> = [];
const transport = nodemailer.createTransport({ jsonTransport: true });
transport.use("compile", (message, done) => {
  const url = String(message.data.text).match(/https?:\/\/[^\s]+/)?.[0];
  assert.ok(url, "action email must contain a usable URL");
  sent.push({ email: String(message.data.to), subject: String(message.data.subject), url });
  done();
});
mock.method(nodemailer, "createTransport", () => transport);
const { buildApp } = await import("../src/app.js");
const { auth } = await import("../src/auth.js");
const { closeDatabase, pool } = await import("../src/db/index.js");
const context = await auth.$context;
// Better Auth skips origin validation by default under NODE_ENV=test. Exercise
// the production callback rejection policy as well as the routing adapter.
context.skipOriginCheck = false;
context.skipCSRFCheck = false;
const handleAuth = auth.handler;
let originalCookies: string[] = [];
auth.handler = async (request) => {
  const response = await handleAuth(request);
  originalCookies = response.headers.getSetCookie();
  return response;
};
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
  if (path.startsWith("/api/auth/"))
    assert.deepEqual(
      setCookie ? Array.isArray(setCookie) ? setCookie : [setCookie] : [],
      originalCookies,
      "the adapter must preserve every Better Auth Set-Cookie byte for byte",
    );
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
  const initialVerification = sent.at(-1)?.url;
  const resend = await request("/api/auth/send-verification-email", {
    email,
    callbackURL: `${origin}/app/`,
  });
  if (smtp === "enabled") {
    assert.equal(resend.statusCode, 200);
    assert.ok(
      sent.length >= 2,
      "signup and resend must both send verification",
    );
    assert.equal(sent.at(-1)?.email, email);
    assert.ok(initialVerification);
    assert.equal(new URL(initialVerification).searchParams.get("callbackURL"), "/");
    const canonicalVerification = sent.at(-1)!.url;
    for (const [token, callback, error] of [
      ["invalid", "/", "INVALID_TOKEN"],
      ["invalid", `${origin}/?flow=a%2Fb`, "INVALID_TOKEN"],
      [await createEmailVerificationToken(context.secret, email, undefined, -60), `${origin}/`, "TOKEN_EXPIRED"],
    ]) {
      const invalid = await request(`/api/auth/verify-email?token=${encodeURIComponent(token!)}&callbackURL=${encodeURIComponent(callback!)}`);
      assert.equal(invalid.statusCode, 302);
      assert.equal(invalid.headers.location, callback === "/" ? `/app/?error=${error}` : `${origin}/app/${callback!.includes("?") ? "?flow=a%2Fb&" : "?"}error=${error}`);
    }
    const foreign = await request(`/api/auth/verify-email?token=invalid&callbackURL=${encodeURIComponent("https://foreign.invalid/app/")}`);
    assert.equal(foreign.statusCode, 403);
    assert.equal(foreign.headers.location, undefined);
    await directory("email_verification_required");
    const signupUrl = new URL(initialVerification);
    const verified = await request(signupUrl.pathname + signupUrl.search);
    assert.equal(verified.statusCode, 302);
    assert.equal(verified.headers.location, "/app/", "old signup default callback must return to the app");
    assert.ok(originalCookies.some((value) => value.startsWith("better-auth.session_token=")));
    const canonicalUrl = new URL(canonicalVerification);
    assert.equal((await request(canonicalUrl.pathname + canonicalUrl.search)).headers.location, `${origin}/app/`);
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
  const created = await create();
  assert.equal(created.statusCode, 200);

  if (smtp === "enabled") {
    const ownerCookie = cookie;
    let number = 0;
    for (const callbackURL of [
      `${origin}/`, `${origin}/app/`,
      `${origin}/app/cli-login?callback=http%3A%2F%2F127.0.0.1%3A54321%2F&state=a%2Bb&label=My%20laptop&workspace=ws`,
      `${origin}/app/accept-invitation?id=i%2F1`,
    ]) {
      cookie = "";
      const signup = await request("/api/auth/sign-up/email", { name: "Callback fixture", email: `callback-${++number}@example.com`, password: "disposable-fixture-password", callbackURL });
      assert.equal(signup.statusCode, 200);
      const link = new URL(sent.at(-1)!.url);
      const verified = await request(link.pathname + link.search);
      assert.equal(verified.statusCode, 302);
      assert.equal(verified.headers.location, callbackURL === `${origin}/` ? `${origin}/app/` : callbackURL);
    }
    cookie = ownerCookie;
    for (const redirectTo of [`${origin}/reset-password`, `${origin}/app/reset-password`]) {
      assert.equal((await request("/api/auth/request-password-reset", { email, redirectTo })).statusCode, 200);
      const link = new URL(sent.at(-1)!.url);
      const reset = await request(link.pathname + link.search);
      assert.equal(reset.statusCode, 302);
      const destination = new URL(String(reset.headers.location));
      assert.equal(destination.origin, origin);
      assert.equal(destination.pathname, "/app/reset-password");
      assert.ok(destination.searchParams.get("token"));
      const expired = await request(`/api/auth/reset-password/invalid?callbackURL=${encodeURIComponent(redirectTo)}`);
      assert.equal(expired.statusCode, 302);
      assert.equal(new URL(String(expired.headers.location)).pathname, "/app/reset-password");
      assert.equal(new URL(String(expired.headers.location)).searchParams.get("error"), "INVALID_TOKEN");
    }
    const workspace = await request(`/api/organizations/${created.json().id}/workspaces`, { name: "Routing fixture", slug: "routing-fixture" });
    assert.equal(workspace.statusCode, 201);
    const workspaceId = workspace.json().id;
    const invitation = await request(`/api/workspaces/${workspaceId}/invitations`, { email: "invitee@example.com", role: "viewer" });
    assert.equal(invitation.statusCode, 201);
    assert.equal(invitation.json().emailSent, true);
    let link = new URL(sent.at(-1)!.url);
    assert.equal(link.pathname, "/app/accept-invitation");
    assert.equal(link.searchParams.get("id"), invitation.json().id);
    const organizationInvitation = await request("/api/auth/organization/invite-member", { organizationId: created.json().id, email: "org-invitee@example.com", role: "viewer" });
    assert.equal(organizationInvitation.statusCode, 200);
    link = new URL(sent.at(-1)!.url);
    assert.equal(link.pathname, "/app/accept-invitation");
    assert.equal(link.searchParams.get("id"), organizationInvitation.json().id);
    cookie = "";
    assert.equal((await request("/api/auth/sign-up/email", { name: "Invitee", email: "invitee@example.com", password: "disposable-fixture-password", callbackURL: `${origin}/app/accept-invitation?id=${invitation.json().id}` })).statusCode, 200);
    link = new URL(sent.at(-1)!.url);
    const verifiedInvitation = await request(link.pathname + link.search);
    assert.equal(verifiedInvitation.headers.location, `${origin}/app/accept-invitation?id=${invitation.json().id}`);
    const accepted = await request(`/api/invitations/${invitation.json().id}/accept`, {});
    assert.equal(accepted.statusCode, 200);
    assert.equal(accepted.json().workspaceId, workspaceId);
    cookie = ownerCookie;
    const callbackURL = `${origin}/app/account?emailChanged=true`;
    assert.equal((await request("/api/auth/change-email", { newEmail: "changed-owner@example.com", callbackURL })).statusCode, 200);
    link = new URL(sent.at(-1)!.url);
    assert.equal((await request(link.pathname + link.search)).headers.location, callbackURL);
    link = new URL(sent.at(-1)!.url);
    assert.equal(sent.at(-1)!.email, "changed-owner@example.com");
    assert.equal((await request(link.pathname + link.search)).headers.location, callbackURL);
    assert.equal((await request("/api/auth/get-session")).json().user.email, "changed-owner@example.com");
  }

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
  transport.close();
  mock.restoreAll();
}
