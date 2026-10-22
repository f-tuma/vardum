import assert from "node:assert/strict";
import test from "node:test";
import {
  ApiRequestError,
  VardEditorUnavailableError,
  deleteVardEditor,
  getVardEditor,
  isVardRevisionConflict,
  replaceVardEditorItems,
  updateVardEditor,
  getVardEditorV2,
  updateVardEditorV2,
  replaceVardEditorItemsV2,
  deleteVardEditorV2,
} from "./asset-api.js";

const revision = `v1:${"a".repeat(64)}`;
const currentRevision = `v1:${"b".repeat(64)}`;
const definition = { schema: 1, id: "vard", workspaceId: "workspace", name: "Site", isPublic: false, updatedAt: "2026-01-01", folderRules: [], items: [], revision };

test("guarded editor requests carry the opaque baseline, existing/null IDs and dedicated routes", async (t) => {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
    return Response.json(definition);
  });
  await getVardEditor("workspace", "vard");
  await updateVardEditor("workspace", "vard", revision, { name: "New" });
  const item = { assetId: "asset", versionId: null, outputPath: "logo.svg", transformation: null, writable: false };
  await replaceVardEditorItems("workspace", "vard", revision, [{ ...item, id: "mapping" }, { ...item, id: null }]);
  await deleteVardEditor("workspace", "vard", revision);
  assert.deepEqual(calls.slice(0, 3).map(({ url }) => url), [
    "/api/workspaces/workspace/vards/vard/editor",
    "/api/workspaces/workspace/vards/vard/editor",
    "/api/workspaces/workspace/vards/vard/editor/items",
  ]);
  assert.deepEqual(calls[1]?.body, { name: "New", expectedRevision: revision });
  assert.deepEqual(calls[2]?.body, { expectedRevision: revision, items: [{ ...item, id: "mapping" }, { ...item, id: null }] });
  assert.equal(new URL(calls[3]!.url, "http://example.test").searchParams.get("expectedRevision"), revision);
  assert.equal(calls[3]?.method, "DELETE");
});

const capabilitiesV2 = { vardDefinitionSchema: 2 };
const revisionV2 = `v2:${"a".repeat(64)}`;
const linked = {
  id: "linked", outputPath: "public/logo.png", binding: { kind: "use", assetUseId: "library-use" },
  linkedUse: { id: "library-use", key: "mobile/logo.png", displayName: "Mobile logo", sourceDisplayName: "Logo", revision: 3, sourceProcessing: false },
  resolved: { assetId: "real-source", key: "logo.svg", versionId: "ready-version", sourceChecksum: "source-sha", sourceMimeType: "image/svg+xml",
    mimeType: "image/png", size: 24, transformation: { w: 64, h: 64, pad: 12.5, fit: "contain", format: "png" }, writable: false, pinned: false,
    fingerprint: "fingerprint", downloadUrl: "/w/demo/__v/ready-version/logo.svg?format=png&sig=signed", availabilityError: null },
};
const definitionV2 = { definitionSchema: 2, storedDefinitionSchema: 2, revision: revisionV2, id: "vard", workspaceId: "workspace",
  name: "Linked", isPublic: false, updatedAt: "2026-01-01", folderRules: [], items: [linked] };

test("schema2 requests preserve the literal use, send explicit negotiation and never fall back", async (t) => {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
    return init?.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json(definitionV2);
  });
  const saved = await getVardEditorV2("workspace", "vard", capabilitiesV2);
  assert.equal(saved.items[0]?.binding.kind, "use");
  await updateVardEditorV2("workspace", "vard", revisionV2, { returnToSourceOnly: true }, capabilitiesV2);
  await replaceVardEditorItemsV2("workspace", "vard", revisionV2, [{ id: "linked", outputPath: "other.png", binding: { kind: "use", assetUseId: "library-use" } }], capabilitiesV2);
  await deleteVardEditorV2("workspace", "vard", revisionV2, capabilitiesV2);
  assert.equal(calls[0]?.url, "/api/workspaces/workspace/vards/vard/editor?definitionSchema=2");
  assert.deepEqual(calls[1]?.body, { returnToSourceOnly: true, definitionSchema: 2, expectedRevision: revisionV2 });
  assert.deepEqual(calls[2]?.body, { definitionSchema: 2, expectedRevision: revisionV2,
    items: [{ id: "linked", outputPath: "other.png", binding: { kind: "use", assetUseId: "library-use" } }] });
  assert.equal(new URL(calls[3]!.url, "http://example.test").searchParams.get("definitionSchema"), "2");
  assert.equal(calls.length, 4);
});

test("schema2 rejects missing capability, ignored negotiation, invalid tokens and flattenable bindings", async (t) => {
  let calls = 0;
  let response: unknown = definition;
  t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json(response); });
  await Promise.all([undefined, {}, { vardDefinitionSchema: 1 }].map((cap) =>
    assert.rejects(getVardEditorV2("workspace", "vard", cap), VardEditorUnavailableError)));
  assert.equal(calls, 0);
  await assert.rejects(getVardEditorV2("workspace", "vard", capabilitiesV2), VardEditorUnavailableError);
  for (const malformed of [
    { ...definitionV2, definitionSchema: 1 }, { ...definitionV2, storedDefinitionSchema: "2" }, { ...definitionV2, revision },
    { ...definitionV2, items: [{ ...linked, binding: { ...linked.binding, transformation: null } }] },
    { ...definitionV2, items: [{ ...linked, binding: { kind: "use" } }] },
    { ...definitionV2, items: [{ ...linked, resolved: { ...linked.resolved, writable: true } }] },
    { ...definitionV2, items: [{ ...linked, resolved: { ...linked.resolved, availabilityError: "Unavailable" } }] },
    { ...definitionV2, items: [{ ...linked, linkedUse: { ...linked.linkedUse, sourceProcessing: undefined } }] },
  ]) {
    response = malformed;
    // oxlint-disable-next-line no-await-in-loop -- test each response before replacing the shared mock
    await assert.rejects(getVardEditorV2("workspace", "vard", capabilitiesV2), VardEditorUnavailableError);
  }
  const beforeWrites = calls;
  await assert.rejects(updateVardEditorV2("workspace", "vard", revision, { name: "Wrong protocol" }, capabilitiesV2), VardEditorUnavailableError);
  await assert.rejects(replaceVardEditorItemsV2("workspace", "vard", revisionV2, [{ id: "linked", outputPath: "logo.png", binding: { kind: "use", assetUseId: "library-use", assetId: "source" } } as never], capabilitiesV2), VardEditorUnavailableError);
  assert.equal(calls, beforeWrites);
});

test("schema2 keeps unavailable literal rows repairable and preserves typed409 without retry", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url: string, init?: RequestInit) => {
    calls++;
    if (init?.method) return Response.json({ code: "vard_revision_conflict", error: "Vard changed; reload before saving.", currentRevision: `v2:${"b".repeat(64)}` }, { status: 409 });
    return Response.json({ ...definitionV2, items: [{ ...linked, linkedUse: null, resolved: { ...linked.resolved,
      versionId: null, sourceChecksum: null, fingerprint: null, downloadUrl: null, availabilityError: "Source unavailable" } }] });
  });
  assert.deepEqual((await getVardEditorV2("workspace", "vard", capabilitiesV2)).items[0]?.binding, linked.binding);
  await assert.rejects(updateVardEditorV2("workspace", "vard", revisionV2, { name: "New" }, capabilitiesV2), isVardRevisionConflict);
  assert.equal(calls, 2);
});

test("structured stale conflicts remain distinct from output collisions and retain currentRevision without retry", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    return Response.json({ code: "vard_revision_conflict", error: "Vard changed; reload before saving.", currentRevision }, { status: 409 });
  });
  await assert.rejects(updateVardEditor("workspace", "vard", revision, { name: "New" }), (cause: unknown) => {
    assert.ok(cause instanceof ApiRequestError);
    assert.equal(cause.status, 409);
    assert.equal(cause.code, "vard_revision_conflict");
    assert.equal(cause.currentRevision, currentRevision);
    assert.equal(isVardRevisionConflict(cause), true);
    return true;
  });
  assert.equal(calls, 1);
  assert.equal(isVardRevisionConflict(new ApiRequestError("Output collision", 409)), false);
  assert.equal(isVardRevisionConflict(new ApiRequestError("Forbidden", 403, "vard_revision_conflict")), false);
});

test("missing/malformed revisions, missing literal pins and guarded 404 fail closed without legacy requests", async (t) => {
  const calls: string[] = [];
  let reply: unknown = { ...definition, revision: undefined };
  let status = 200;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    calls.push(url);
    return Response.json(reply, { status });
  });
  await assert.rejects(getVardEditor("workspace", "vard"), VardEditorUnavailableError);
  reply = { ...definition, revision: "v1:bad" };
  await assert.rejects(getVardEditor("workspace", "vard"), VardEditorUnavailableError);
  reply = { ...definition, items: [{ id: "item", pinned: true, versionId: null }] };
  await assert.rejects(getVardEditor("workspace", "vard"), VardEditorUnavailableError);
  reply = { error: "Not found" }; status = 404;
  await assert.rejects(updateVardEditor("workspace", "vard", revision, { name: "New" }), (cause: unknown) => cause instanceof ApiRequestError && cause.status === 404);
  assert.equal(calls.length, 4);
  assert.ok(calls.every((url) => url.endsWith("/editor")));
  await assert.rejects(updateVardEditor("workspace", "vard", "bad", { name: "New" }), VardEditorUnavailableError);
  assert.equal(calls.length, 4);
});
