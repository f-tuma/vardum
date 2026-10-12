import assert from "node:assert/strict";
import test from "node:test";
import { createKnownUsage, deleteKnownUsage, getKnownUsageInventory, isUsageConflict, recordUsageCheck, updateKnownUsage, UsageRequestError, type UsageConsumerInput } from "./usage-api";

const input: UsageConsumerInput = {
  name: "Marketing", kind: "first_party", destinations: [{ id: "destination", label: "Home", url: "https://site.example/home" }],
  bindings: [{ id: "binding", destinationId: "destination", mode: "manual_frozen", target: { kind: "vard_output", vardId: "vard", outputPath: "public/logo.svg", assetId: "asset" } }],
};
test("usage update preserves binding and destination identity and includes the captured revision", async (t) => {
  let call!: { url: string; init: RequestInit };
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => { call = { url, init }; return Response.json({ id: "consumer", revision: 8 }); });
  await updateKnownUsage("workspace", "consumer", 7, input);
  assert.equal(call.url, "/api/workspaces/workspace/known-usages/consumer");
  assert.equal(call.init.method, "PUT");
  assert.deepEqual(JSON.parse(String(call.init.body)), { ...input, expectedRevision: 7 });
});
test("manual reports send explicit observed version, date, revision, and scope without client author claims", async (t) => {
  let body!: Record<string, unknown>;
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => { body = JSON.parse(String(init.body)); return Response.json({}); });
  await recordUsageCheck("workspace", "consumer", "binding", { expectedRevision: 7, expectedScopeToken: "captured-scope", checkedAt: "2026-10-10T10:00:00Z", reportedVersionId: "observed-older-version", releaseRef: "release-42" });
  assert.equal(body.reportedVersionId, "observed-older-version");
  assert.equal(body.checkedAt, "2026-10-10T10:00:00Z");
  assert.equal(body.expectedScopeToken, "captured-scope");
  assert.equal(body.expectedRevision, 7);
  assert.equal(Object.hasOwn(body, "actor"), false);
});
test("creation has no implicit manual check, and deletion handles an empty success response", async (t) => {
  const bodies: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return init.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json({}); });
  await createKnownUsage("workspace", input);
  await deleteKnownUsage("workspace", "consumer", 3);
  assert.deepEqual(bodies, [input, { expectedRevision: 3 }]);
});
test("all 409 conflicts are typed and do not retry a mutation", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls += 1; return Response.json({ error: "Binding scope changed", code: "usage_scope_conflict" }, { status: 409 }); });
  await assert.rejects(() => updateKnownUsage("workspace", "consumer", 1, input), (cause: unknown) => isUsageConflict(cause) && cause.code === "usage_scope_conflict" && cause.message === "Binding scope changed");
  assert.equal(calls, 1);
  assert.equal(isUsageConflict(new UsageRequestError("Bad URL", 400)), false);
});
test("complete inventory follows opaque cursors and de-duplicates records across a live page boundary", async (t) => {
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    requests.push(url);
    return requests.length === 1 ? Response.json({ consumers: [{ id: "a", name: "Original" }], nextCursor: "opaque/+ cursor" }) : Response.json({ consumers: [{ id: "a", name: "Fresh" }, { id: "b", name: "Second" }], nextCursor: null });
  });
  const result = await getKnownUsageInventory("workspace");
  assert.deepEqual(result.consumers.map(({ name }) => name), ["Fresh", "Second"]);
  assert.equal(new URL(requests[1]!, "http://localhost").searchParams.get("after"), "opaque/+ cursor");
  assert.equal(new URL(requests[1]!, "http://localhost").searchParams.get("limit"), "50");
});
test("a failed later page never exposes an incomplete inventory as a total", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => ++calls === 1 ? Response.json({ consumers: [{ id: "a" }], nextCursor: "next" }) : Response.json({ error: "Temporary outage" }, { status: 503 }));
  await assert.rejects(() => getKnownUsageInventory("workspace"), /Temporary outage/);
});
test("repeated inventory cursors fail instead of making an unbounded read", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls += 1; return Response.json({ consumers: [{ id: "same-record" }], nextCursor: "same" }); });
  await assert.rejects(() => getKnownUsageInventory("workspace"), /did not advance/);
  assert.equal(calls, 2);
});

test("manual report version pages use the private asset endpoint and carry the older boundary", async (t) => {
  const { listUsageVersionPage } = await import("./usage-api");
  let url = "";
  const signal = new AbortController().signal;
  t.mock.method(globalThis, "fetch", async (requestUrl: string, init: RequestInit) => { url = requestUrl; assert.equal(init.signal, signal); return Response.json({ versions: [], currentVersionId: null, nextCursor: null }); });
  await listUsageVersionPage("workspace", "asset", 52, signal);
  const parsed = new URL(url, "http://localhost");
  assert.equal(parsed.pathname, "/api/workspaces/workspace/assets/asset/versions");
  assert.equal(parsed.searchParams.get("limit"), "50");
  assert.equal(parsed.searchParams.get("before"), "52");
});

test("resource-budgeted single-consumer pages load the full 200-record registered inventory", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    const before = new URL(url, "http://localhost").searchParams.get("after");
    assert.equal(before, calls ? `consumer-${calls}` : null);
    calls += 1;
    return Response.json({ consumers: [{ id: `consumer-${calls}`, name: `Consumer ${calls}` }], nextCursor: calls < 200 ? `consumer-${calls}` : null });
  });
  const result = await getKnownUsageInventory("workspace");
  assert.equal(calls, 200);
  assert.equal(result.consumers.length, 200);
  assert.equal(result.consumers[199]?.name, "Consumer 200");
});

test("inventory bounds reject a 201st distinct consumer instead of exposing a false complete count", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    return Response.json({ consumers: [{ id: `consumer-${calls}` }], nextCursor: calls < 201 ? `consumer-${calls}` : null });
  });
  await assert.rejects(() => getKnownUsageInventory("workspace"), /exceeded its consumer limit/);
  assert.equal(calls, 201);
});

test("inventory rejects a changing cursor that adds no records", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    return Response.json({ consumers: [{ id: "same-record" }], nextCursor: `cursor-${calls}` });
  });
  await assert.rejects(() => getKnownUsageInventory("workspace"), /made no progress/);
  assert.equal(calls, 2);
});
