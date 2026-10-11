import assert from "node:assert/strict";
import { createServer } from "node:http";
import test, { type TestContext } from "node:test";
import type { VardEditorDefinition, VardEditorItemInput } from "@vardum/shared";
import { VardumClient, VardumHttpError } from "./client.js";

const revision = `v1:${"a".repeat(64)}`;
const currentRevision = `v1:${"b".repeat(64)}`;
const itemId = "11111111-1111-4111-8111-111111111111";
const pinId = "22222222-2222-4222-8222-222222222222";
const assetId = "33333333-3333-4333-8333-333333333333";
const definition: VardEditorDefinition = {
  schema: 1, id: "vard", workspaceId: "workspace", name: "Website", isPublic: false,
  updatedAt: "2026-01-01T00:00:00Z", revision, folderRules: [],
  items: [{
    id: itemId, assetId, key: "logo.svg", outputPath: "logo.svg", writable: false,
    pinned: true, pinnedVersionId: pinId, versionId: null, transformation: null,
    sourceChecksum: null, mimeType: null, size: null, fingerprint: null, downloadUrl: null,
  }],
};
type Call = { method: string; path: string; query: URLSearchParams; body?: unknown; key?: string };
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
  t.after(() => new Promise<void>((resolve) => api.close(() => resolve())));
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  const address = api.address();
  assert.ok(address && typeof address !== "string");
  return { calls, client: new VardumClient(`http://127.0.0.1:${address.port}`, "editor-key") };
}

const items: VardEditorItemInput[] = [{
  id: itemId, assetId, versionId: pinId, outputPath: "moved/logo.svg", writable: false, transformation: null,
}, {
  id: null, assetId, versionId: null, outputPath: "latest.svg", writable: true, transformation: null,
}];

test("guarded SDK forwards original revisions, stable IDs and unavailable literal pins on dedicated endpoints", async (t) => {
  const { client, calls } = await fixture(t, (call) => call.path === "/api/capabilities"
    ? { body: { vardEditRevision: 1 } }
    : call.method === "DELETE" ? { status: 204 } : { body: definition });
  assert.deepEqual(await client.vardEditor("workspace", "vard"), definition);
  assert.deepEqual(await client.updateVardEditor("workspace", "vard", { expectedRevision: revision, name: "Renamed" }), definition);
  assert.deepEqual(await client.replaceVardEditorItems("workspace", "vard", revision, items), definition);
  await client.deleteVardEditor("workspace", "vard", revision);
  const editorCalls = calls.filter(({ path }) => path !== "/api/capabilities");
  assert.deepEqual(editorCalls.map(({ method, path }) => [method, path]), [
    ["GET", "/api/workspaces/workspace/vards/vard/editor"],
    ["PATCH", "/api/workspaces/workspace/vards/vard/editor"],
    ["PUT", "/api/workspaces/workspace/vards/vard/editor/items"],
    ["DELETE", "/api/workspaces/workspace/vards/vard/editor"],
  ]);
  assert.deepEqual(editorCalls[1]?.body, { expectedRevision: revision, name: "Renamed" });
  assert.deepEqual(editorCalls[2]?.body, { expectedRevision: revision, items });
  assert.equal(editorCalls[3]?.query.get("expectedRevision"), revision);
  assert.equal(editorCalls[3]?.body, undefined);
  assert.ok(calls.every(({ key }) => key === "editor-key"));
});

test("revision conflicts preserve typed details and never fetch a new token or retry", async (t) => {
  const { client, calls } = await fixture(t, (call) => call.path === "/api/capabilities"
    ? { body: { vardEditRevision: 1 } }
    : { status: 409, body: { code: "vard_revision_conflict", error: "Vard changed; reload before saving.", currentRevision } });
  for (const mutate of [
    () => client.updateVardEditor("workspace", "vard", { expectedRevision: revision, name: "Stale" }),
    () => client.replaceVardEditorItems("workspace", "vard", revision, items),
    () => client.deleteVardEditor("workspace", "vard", revision),
  ]) {
    await assert.rejects(mutate, (error: unknown) => {
      assert.ok(error instanceof VardumHttpError);
      assert.equal(error.message, "Vard changed; reload before saving. (409)");
      assert.equal(error.status, 409);
      assert.equal(error.code, "vard_revision_conflict");
      assert.equal(error.currentRevision, currentRevision);
      return true;
    });
  }
  assert.deepEqual(calls.map(({ method }) => method), ["GET", "PATCH", "GET", "PUT", "GET", "DELETE"]);
  assert.equal(calls.filter(({ path, method }) => path.endsWith("/editor") && method === "GET").length, 0);
});

test("guarded SDK refuses unsupported capabilities, malformed tokens and incomplete editor responses", async (t) => {
  let capability: unknown = undefined;
  let response: unknown = definition;
  let status = 200;
  const { client, calls } = await fixture(t, (call) => call.path === "/api/capabilities"
    ? { body: { vardEditRevision: capability } } : { status, body: response });
  for (capability of [undefined, 0, 2, "1", true]) {
    await assert.rejects(client.vardEditor("workspace", "vard"), /vardEditRevision: 1/);
    await assert.rejects(client.updateVardEditor("workspace", "vard", { expectedRevision: revision, name: "Unsafe" }), /vardEditRevision: 1/);
    await assert.rejects(client.replaceVardEditorItems("workspace", "vard", revision, items), /vardEditRevision: 1/);
    await assert.rejects(client.deleteVardEditor("workspace", "vard", revision), /vardEditRevision: 1/);
  }
  assert.ok(calls.every(({ path }) => path === "/api/capabilities"));
  capability = 1;
  const beforeInvalid = calls.length;
  for (const expectedRevision of ["", "v1:abc", revision.toUpperCase(), "123"]) {
    await assert.rejects(client.updateVardEditor("workspace", "vard", { expectedRevision, name: "Unsafe" }), /original expectedRevision/);
    await assert.rejects(client.replaceVardEditorItems("workspace", "vard", expectedRevision, items), /original expectedRevision/);
    await assert.rejects(client.deleteVardEditor("workspace", "vard", expectedRevision), /original expectedRevision/);
  }
  const omittedId = { ...items[0], id: undefined } as unknown as VardEditorItemInput;
  const omittedPin = { ...items[0], versionId: undefined } as unknown as VardEditorItemInput;
  await assert.rejects(client.replaceVardEditorItems("workspace", "vard", revision, [omittedId]), /existing UUID or null id/);
  await assert.rejects(client.replaceVardEditorItems("workspace", "vard", revision, [omittedPin]), /explicit UUID or null versionId/);
  assert.equal(calls.length, beforeInvalid);
  const { revision: _revision, ...withoutRevision } = definition;
  const { pinnedVersionId: _pin, ...withoutPin } = definition.items[0]!;
  for (response of [withoutRevision, { ...definition, revision: "v1:invalid" }, { ...definition, items: [withoutPin] }]) {
    await assert.rejects(client.vardEditor("workspace", "vard"), /invalid Vard editor definition/);
  }
  status = 404;
  response = { error: "Not Found" };
  await assert.rejects(client.updateVardEditor("workspace", "vard", { expectedRevision: revision, name: "Unsafe" }), /Not Found \(404\)/);
  assert.ok(calls.every(({ path }) => path === "/api/capabilities" || path.includes("/editor")), "no legacy endpoint fallback");
});

test("ordinary HTTP error messages and legacy manifest requests remain unchanged", async (t) => {
  const { client, calls } = await fixture(t, () => ({ status: 403, body: { error: "Forbidden", message: "Read denied" } }));
  await assert.rejects(client.manifest({ schema: 1, server: client.server, workspace: "workspace", vard: "vard" }), (error: unknown) => {
    assert.ok(error instanceof VardumHttpError);
    assert.equal(error.message, "Read denied (403)");
    assert.equal(error.code, undefined);
    assert.equal(error.currentRevision, undefined);
    return true;
  });
  assert.deepEqual(calls.map(({ path }) => path), ["/api/workspaces/workspace/vards/vard/manifest"]);
});
