import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { VardEditorDefinition } from "@vardum/shared";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const revision = `v1:${"a".repeat(64)}`;
const currentRevision = `v1:${"b".repeat(64)}`;
const firstId = "11111111-1111-4111-8111-111111111111";
const secondId = "22222222-2222-4222-8222-222222222222";
const pinId = "33333333-3333-4333-8333-333333333333";
const readyId = "44444444-4444-4444-8444-444444444444";
const assetId = "55555555-5555-4555-8555-555555555555";
const definition: VardEditorDefinition = {
  schema: 1, id: "vard", workspaceId: "workspace", name: "Website", isPublic: false,
  updatedAt: "2026-01-01T00:00:00Z", revision,
  folderRules: [{ sourcePrefix: "brand/", outputPrefix: "assets/brand/" }],
  items: [{
    id: firstId, assetId, key: "logo.svg", outputPath: "logo.svg", writable: false,
    pinned: true, pinnedVersionId: pinId, versionId: null, transformation: null,
    sourceChecksum: null, mimeType: null, size: null, fingerprint: null, downloadUrl: null,
  }, {
    id: secondId, assetId, key: "logo.svg", outputPath: "latest.svg", writable: true,
    pinned: false, pinnedVersionId: null, versionId: readyId, transformation: null,
    sourceChecksum: "checksum", mimeType: "image/svg+xml", size: 12,
    fingerprint: "fingerprint", downloadUrl: "https://example.test/logo.svg",
  }],
};
const args = { workspaceId: "workspace", vardId: "vard" };
const items = definition.items.map((item) => ({
  id: item.id, assetId: item.assetId, versionId: item.pinnedVersionId,
  outputPath: item.outputPath, writable: item.writable, transformation: item.transformation,
}));
function text(result: Awaited<ReturnType<Client["callTool"]>>) {
  assert.ok(Array.isArray(result.content));
  assert.equal(result.content[0]?.type, "text");
  return result.content[0].text as string;
}
type Call = { method: string; path: string; query: URLSearchParams; body?: Record<string, unknown>; key?: string };
async function fixture(t: TestContext, handle: (call: Call) => { status?: number; body?: unknown }) {
  const calls: Call[] = [];
  const api = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://fixture.invalid");
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const call = { method: request.method!, path: url.pathname, query: url.searchParams,
      body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined,
      key: request.headers["x-api-key"] as string | undefined };
    calls.push(call);
    const result = handle(call);
    response.statusCode = result.status ?? 200;
    response.setHeader("content-type", "application/json");
    response.end(result.body === undefined ? undefined : JSON.stringify(result.body));
  });
  const clients: Client[] = [];
  t.after(async () => {
    await Promise.all(clients.map((client) => client.close()));
    await new Promise<void>((resolve) => api.close(() => resolve()));
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  const address = api.address();
  assert.ok(address && typeof address !== "string");
  const connect = async (key = "fixture-editor") => {
    const client = new Client({ name: "editor-revision-test", version: "1.0.0" });
    clients.push(client);
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: ["--import", import.meta.resolve("tsx"), entry],
      env: { VARDUM_SERVER: `http://127.0.0.1:${address.port}`, VARDUM_API_KEY: key },
      stderr: "pipe",
    }));
    return client;
  };
  return { calls, connect };
}

test("MCP editor schemas require original revisions, stable IDs and explicit literal pins; accepted writes return the full definition", { timeout: 15_000 }, async (t) => {
  const { calls, connect } = await fixture(t, (call) => {
    if (call.path === "/api/capabilities") return { body: { vardEditRevision: 1 } };
    if (call.path.endsWith("/manifest")) {
      const { revision: _revision, folderRules: _rules, ...manifest } = definition;
      return { body: manifest };
    }
    if (call.method === "DELETE") return { status: 204 };
    return { body: definition };
  });
  const client = await connect();
  const tools = (await client.listTools()).tools;
  assert.equal(tools.length, 11);
  for (const name of ["update_vard", "replace_vard_items", "delete_vard"]) {
    const tool = tools.find((tool) => tool.name === name)!;
    assert.ok(tool.inputSchema.required?.includes("expectedRevision"));
    assert.match(tool.description!, /original expectedRevision/);
  }
  assert.match(tools.find((tool) => tool.name === "update_vard")!.description!, /read\+update/);
  assert.match(tools.find((tool) => tool.name === "replace_vard_items")!.description!, /read\+update/);
  assert.match(tools.find((tool) => tool.name === "delete_vard")!.description!, /delete permission/);
  const get = await client.callTool({ name: "get_vard", arguments: args });
  assert.deepEqual(JSON.parse(text(get)), definition);
  const preview = await client.callTool({ name: "get_vard", arguments: { ...args, resolved: true } });
  assert.equal(JSON.parse(text(preview)).revision, undefined);
  const patch = { ...args, expectedRevision: revision, name: "Renamed" };
  assert.deepEqual(JSON.parse(text(await client.callTool({ name: "update_vard", arguments: patch }))), definition);
  assert.deepEqual(calls.at(-1)?.body, { expectedRevision: revision, name: "Renamed" });
  const replacement = [{ ...items[1], outputPath: "moved/latest.svg" }, items[0], {
    id: null, assetId, versionId: null, outputPath: "new.svg", writable: false, transformation: null,
  }];
  assert.deepEqual(JSON.parse(text(await client.callTool({ name: "replace_vard_items", arguments: {
    ...args, expectedRevision: revision, items: replacement,
  } }))), definition);
  assert.deepEqual(calls.at(-1)?.body, { expectedRevision: revision, items: replacement });
  assert.equal((calls.at(-1)?.body?.items as typeof replacement)[0]?.versionId, null, "latest must not accidentally pin the resolved ready version");
  assert.equal((calls.at(-1)?.body?.items as typeof replacement)[1]?.versionId, pinId, "unavailable saved pin must survive literally");
  const deleted = await client.callTool({ name: "delete_vard", arguments: { ...args, expectedRevision: revision } });
  assert.notEqual(deleted.isError, true);
  assert.equal(calls.at(-1)?.query.get("expectedRevision"), revision);
  assert.equal(calls.at(-1)?.body, undefined);
  const mutations = calls.filter(({ method }) => ["PATCH", "PUT", "DELETE"].includes(method));
  assert.deepEqual(mutations.map(({ method, path }) => [method, path]), [
    ["PATCH", "/api/workspaces/workspace/vards/vard/editor"],
    ["PUT", "/api/workspaces/workspace/vards/vard/editor/items"],
    ["DELETE", "/api/workspaces/workspace/vards/vard/editor"],
  ]);
  const beforeInvalid = calls.length;
  for (const name of ["update_vard", "replace_vard_items", "delete_vard"]) {
    for (const expectedRevision of [undefined, "v1:short", revision.toUpperCase(), 1]) {
      const invalid = await client.callTool({ name, arguments: { ...args, expectedRevision, name: "Unsafe", items } });
      assert.equal(invalid.isError, true);
    }
  }
  for (const item of [
    { ...items[0], id: undefined }, { ...items[0], id: "folder:generated" },
    { ...items[0], versionId: undefined }, { ...items[0], pinned: true },
  ]) {
    const invalid = await client.callTool({ name: "replace_vard_items", arguments: { ...args, expectedRevision: revision, items: [item] } });
    assert.equal(invalid.isError, true);
  }
  assert.equal(calls.length, beforeInvalid, "invalid writes must be refused before HTTP");
});

test("MCP stale update, replacement and deletion return structured conflicts without refresh or retry", { timeout: 15_000 }, async (t) => {
  const { calls, connect } = await fixture(t, (call) => call.path === "/api/capabilities"
    ? { body: { vardEditRevision: 1 } }
    : { status: 409, body: { code: "vard_revision_conflict", error: "Vard changed; reload before saving.", currentRevision } });
  const client = await connect();
  for (const name of ["update_vard", "replace_vard_items", "delete_vard"]) {
    const result = await client.callTool({ name, arguments: { ...args, expectedRevision: revision, name: "Stale", items } });
    assert.equal(result.isError, true);
    const error = JSON.parse(text(result));
    assert.deepEqual(result.structuredContent, error);
    assert.equal(error.status, 409);
    assert.equal(error.code, "vard_revision_conflict");
    assert.equal(error.error, "Vard changed; reload before saving.");
    assert.equal(error.currentRevision, currentRevision);
    assert.match(error.instruction, /Reload with get_vard.*review.*Do not retry the stale save/);
  }
  assert.deepEqual(calls.map(({ method }) => method), ["GET", "PATCH", "GET", "PUT", "GET", "DELETE"]);
  assert.equal(calls.filter(({ method, path }) => method === "GET" && path.includes("/editor")).length, 0);
});

test("MCP refuses unsupported servers, missing editor tokens and missing endpoints without legacy fallback", { timeout: 15_000 }, async (t) => {
  let capability: unknown;
  let editorResponse: unknown = definition;
  let status = 200;
  const { calls, connect } = await fixture(t, (call) => {
    if (call.path === "/api/capabilities") return { body: { vardEditRevision: capability } };
    if (call.path.endsWith("/manifest")) return { body: { schema: 1, items: [] } };
    return { status, body: editorResponse };
  });
  const client = await connect();
  for (capability of [undefined, 0, 2, "1", true]) {
    for (const name of ["get_vard", "update_vard", "replace_vard_items", "delete_vard"]) {
      const refused = await client.callTool({ name, arguments: { ...args, expectedRevision: revision, name: "Unsafe", items } });
      assert.equal(refused.isError, true);
      assert.match(text(refused), /vardEditRevision: 1/);
    }
  }
  assert.ok(calls.every(({ path }) => path === "/api/capabilities"));
  const preview = await client.callTool({ name: "get_vard", arguments: { ...args, resolved: true } });
  assert.notEqual(preview.isError, true, "separate preview works independently of editor support");
  capability = 1;
  const { revision: _revision, ...withoutRevision } = definition;
  const { pinnedVersionId: _pin, ...withoutPin } = definition.items[0]!;
  for (editorResponse of [withoutRevision, { ...definition, revision: "v1:short" }, { ...definition, items: [withoutPin] }]) {
    const invalid = await client.callTool({ name: "get_vard", arguments: args });
    assert.equal(invalid.isError, true);
    assert.match(text(invalid), /Invalid Vard editor definition/);
  }
  status = 404;
  editorResponse = { error: "Not Found" };
  for (const name of ["get_vard", "update_vard", "replace_vard_items", "delete_vard"]) {
    const refused = await client.callTool({ name, arguments: { ...args, expectedRevision: revision, name: "Unsafe", items } });
    assert.equal(refused.isError, true);
    assert.match(text(refused), /Not Found.*404/);
  }
  assert.ok(calls.every(({ path }) => path === "/api/capabilities" || path.endsWith("/manifest") || path.includes("/editor")));
});

test("MCP forwards read+update and delete authorization denials with ordinary error messages", { timeout: 15_000 }, async (t) => {
  const { calls, connect } = await fixture(t, (call) => call.path === "/api/capabilities"
    ? { body: { vardEditRevision: 1 } }
    : { status: 403, body: { error: "Forbidden" } });
  for (const key of ["fixture-read-only", "fixture-update-without-read"]) {
    const client = await connect(key);
    for (const name of ["update_vard", "replace_vard_items", "delete_vard"]) {
      const denied = await client.callTool({ name, arguments: { ...args, expectedRevision: revision, name: "Denied", items } });
      assert.equal(denied.isError, true);
      assert.match(text(denied), /Forbidden.*403/);
      assert.equal(denied.structuredContent, undefined);
    }
  }
  assert.equal(calls.filter(({ method }) => method !== "GET").length, 6);
});
