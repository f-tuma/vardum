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
