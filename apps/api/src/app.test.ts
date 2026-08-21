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

test("S3 credentials must be provided together", () => {
  assert.throws(
    () => parseConfig({ NODE_ENV: "test", S3_ACCESS_KEY_ID: "key" }),
    /provided together/,
  );
});

test("GET /health reports readiness", async (context) => {
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

test("workspace settings reject invalid roles and blank key names", async (context) => {
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
  assert.equal(role.statusCode, 400);
  assert.equal(key.statusCode, 400);
});

test("workspace names cannot be blank", async (context) => {
  const app = buildApp();
  context.after(() => app.close());

  const response = await app.inject({
    method: "PATCH",
    url: "/api/workspaces/workspace",
    payload: { name: "   " },
  });
  assert.equal(response.statusCode, 400);
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
