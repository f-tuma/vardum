import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "./app.js";
import { parseConfig } from "./config.js";

test("production requires a custom auth secret", () => {
  assert.throws(
    () => parseConfig({ NODE_ENV: "production" }),
    /BETTER_AUTH_SECRET/,
  );
});

test("production requires a separate transformation secret", () => {
  assert.throws(
    () =>
      parseConfig({
        NODE_ENV: "production",
        BETTER_AUTH_SECRET: "a-secure-production-auth-secret-value",
      }),
    /TRANSFORM_SECRET/,
  );
});

test("SMTP credentials and sender must be complete", () => {
  assert.throws(
    () => parseConfig({ NODE_ENV: "test", SMTP_USER: "user" }),
    /provided together/,
  );
  assert.throws(
    () => parseConfig({ NODE_ENV: "test", SMTP_HOST: "localhost" }),
    /SMTP_FROM/,
  );
  assert.equal(
    parseConfig({
      NODE_ENV: "test",
      SMTP_HOST: "localhost",
      SMTP_FROM: "Vardum <noreply@example.com>",
    }).SMTP_PORT,
    587,
  );
});

test("S3 credentials must be provided together", () => {
  assert.throws(
    () => parseConfig({ NODE_ENV: "test", S3_ACCESS_KEY_ID: "key" }),
    /provided together/,
  );
});

test("legacy asset URLs redirect to the short delivery path", async (context) => {
  const app = buildApp();
  context.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/assets/workspace/brand/logo?w=300",
  });
  assert.equal(response.statusCode, 308);
  assert.equal(response.headers.location, "/w/workspace/brand/logo?w=300");
});

test("GET /health reports liveness", async (context) => {
  const app = buildApp();
  context.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/health" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: "ok" });
});

test("asset list enforces its bounded limit", async (context) => {
  const app = buildApp();
  context.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/api/workspaces/workspace/assets?limit=101",
  });
  assert.equal(response.statusCode, 400);
});

test("folder creation normalizes human names before authorization", async (context) => {
  const app = buildApp();
  context.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/api/workspaces/workspace/folders",
    payload: { prefix: "", name: "Brand Assets" },
  });
  assert.equal(response.statusCode, 401);
});

test("asset folders reject unsafe prefixes", async (context) => {
  const app = buildApp();
  context.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/api/workspaces/workspace/assets?prefix=../",
  });
  assert.equal(response.statusCode, 400);
});

test("ingest accepts only supported image types", async (context) => {
  const app = buildApp();
  context.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/api/workspaces/workspace/assets/00000000-0000-4000-8000-000000000000/versions",
    payload: {
      filename: "document.pdf",
      mimeType: "application/pdf",
      size: 100,
    },
  });
  assert.equal(response.statusCode, 400);
});

test("workspace settings reject invalid roles and blank credentials", async (context) => {
  const app = buildApp();
  context.after(() => app.close());

  const role = await app.inject({
    method: "PATCH",
    url: "/api/workspaces/workspace/members/member",
    payload: { role: "admin" },
  });
  const key = await app.inject({
    method: "POST",
    url: "/api/workspaces/workspace/api-keys",
    payload: { name: "   ", access: "read" },
  });
  const invitation = await app.inject({
    method: "POST",
    url: "/api/workspaces/workspace/invitations",
    payload: { email: "not-an-email", role: "admin" },
  });
  assert.equal(role.statusCode, 400);
  assert.equal(key.statusCode, 400);
  assert.equal(invitation.statusCode, 400);
});

test("organization deletion is not exposed", async (context) => {
  const app = buildApp();
  context.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/api/auth/organization/delete",
    payload: { organizationId: "organization" },
  });
  assert.equal(response.statusCode, 404);
});

test("organization workspace creation is authenticated and validates slugs", async (context) => {
  const app = buildApp();
  context.after(() => app.close());

  const directory = await app.inject({
    method: "GET",
    url: "/api/organizations",
  });
  const invalid = await app.inject({
    method: "POST",
    url: "/api/organizations/organization/workspaces",
    payload: { name: "Workspace", slug: "Not Safe" },
  });
  assert.equal(directory.statusCode, 401);
  assert.equal(invalid.statusCode, 400);
});

test("workspace identity confirmations cannot be blank", async (context) => {
  const app = buildApp();
  context.after(() => app.close());

  const response = await app.inject({
    method: "PATCH",
    url: "/api/workspaces/workspace",
    payload: { name: "   " },
  });
  const deletion = await app.inject({
    method: "DELETE",
    url: "/api/workspaces/workspace",
    payload: { confirmation: "" },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(deletion.statusCode, 400);
});

test("asset keys cannot escape their virtual path", async (context) => {
  const app = buildApp();
  context.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/api/workspaces/workspace/assets",
    payload: { key: "../logo", displayName: "Logo" },
  });
  assert.equal(response.statusCode, 400);
});

test("Vard routes validate manifests before authorization", async (context) => {
  const app = buildApp();
  context.after(() => app.close());

  const invalid = await app.inject({
    method: "PUT",
    url: "/api/workspaces/workspace/vards/00000000-0000-4000-8000-000000000000/items",
    payload: {
      items: [
        {
          assetId: "00000000-0000-4000-8000-000000000000",
          outputPath: "../secret.png",
        },
      ],
    },
  });
  const manifest = await app.inject({
    method: "GET",
    url: "/api/workspaces/workspace/vards/00000000-0000-4000-8000-000000000000/manifest",
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(manifest.statusCode, 401);
});
