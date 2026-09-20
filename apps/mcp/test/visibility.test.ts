import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const assetId = "11111111-1111-4111-8111-111111111111";

function text(result: Awaited<ReturnType<Client["callTool"]>>) {
  assert.ok(Array.isArray(result.content));
  assert.equal(result.content[0]?.type, "text");
  return result.content[0].text as string;
}

test("MCP lists visibility and delegates publishing and denial to the API", {
  timeout: 15_000,
}, async (t) => {
  let isPublic = false;
  const calls: Array<{ key: string | undefined; isPublic: boolean }> = [];
  const api = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    const path = new URL(request.url!, "http://fixture.invalid").pathname;
    if (path === "/api/workspaces/workspace/sync/assets") {
      response.end(
        JSON.stringify({
          workspaceSlug: "workspace",
          assets: [{ id: assetId, key: "logo.svg", isPublic }],
          nextCursor: null,
        }),
      );
      return;
    }
    if (
      request.method === "PATCH" &&
      path === `/api/workspaces/workspace/assets/${assetId}/visibility`
    ) {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      assert.deepEqual(Object.keys(body), ["isPublic"]);
      assert.equal(typeof body.isPublic, "boolean");
      const key = request.headers["x-api-key"] as string | undefined;
      calls.push({ key, isPublic: body.isPublic });
      if (key !== "fixture-publish-key") {
        response.statusCode = 403;
        response.end(JSON.stringify({ error: "Forbidden" }));
        return;
      }
      isPublic = body.isPublic;
      response.end(JSON.stringify({ isPublic }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "Unexpected test request" }));
  });
  const clients: Client[] = [];
  t.after(async () => {
    await Promise.all(clients.map((client) => client.close()));
    await new Promise<void>((resolve) => api.close(() => resolve()));
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  const address = api.address();
  assert.ok(address && typeof address !== "string");
  for (const key of ["fixture-publish-key", "fixture-read-key"]) {
    const client = new Client({ name: "visibility-test", version: "1.0.0" });
    clients.push(client);
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ["--import", import.meta.resolve("tsx"), entry],
        env: {
          VARDUM_SERVER: `http://127.0.0.1:${address.port}`,
          VARDUM_API_KEY: key,
        },
        stderr: "pipe",
      }),
    );
  }
  const [publisher, reader] = clients as [Client, Client];
  assert.ok(
    (await publisher.listTools()).tools.some(
      (tool) => tool.name === "set_asset_visibility",
    ),
  );
  const listed = await reader.callTool({
    name: "list_assets",
    arguments: { workspaceId: "workspace" },
  });
  assert.equal(JSON.parse(text(listed)).assets[0].isPublic, false);
  const args = { workspaceId: "workspace", assetId, isPublic: true };
  const published = await publisher.callTool({
    name: "set_asset_visibility",
    arguments: args,
  });
  assert.notEqual(published.isError, true);
  assert.deepEqual(JSON.parse(text(published)), { isPublic: true });
  const denied = await reader.callTool({
    name: "set_asset_visibility",
    arguments: { ...args, isPublic: false },
  });
  assert.equal(denied.isError, true);
  assert.match(text(denied), /Forbidden.*403/);
  assert.equal(isPublic, true);
  const hidden = await publisher.callTool({
    name: "set_asset_visibility",
    arguments: { ...args, isPublic: false },
  });
  assert.deepEqual(JSON.parse(text(hidden)), { isPublic: false });
  assert.deepEqual(calls, [
    { key: "fixture-publish-key", isPublic: true },
    { key: "fixture-read-key", isPublic: false },
    { key: "fixture-publish-key", isPublic: false },
  ]);
  const invalid = await publisher.callTool({
    name: "set_asset_visibility",
    arguments: { ...args, isPublic: "true" },
  });
  assert.equal(invalid.isError, true);
  assert.equal(calls.length, 3, "invalid input must not reach the API");
});
