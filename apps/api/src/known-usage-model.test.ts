import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  bindingStatus,
  knownUsagePage,
  checkSchema,
  consumerSchema,
  scopeToken,
  type EvidenceScope,
  type Source,
} from "./known-usage-model.js";
const destination = {
  id: randomUUID(),
  label: "Website",
  url: "https://example.test/path",
};
const target = { kind: "asset" as const, assetId: randomUUID() };
const binding = {
  id: randomUUID(),
  destinationId: destination.id,
  mode: "manual_frozen" as const,
  target,
};
const scope: EvidenceScope = {
  destination,
  target,
  mode: binding.mode,
  targetLabel: "Logo",
  outputConfiguration: "asset_latest",
};
const source: Source = {
  assetId: target.assetId,
  versionId: randomUUID(),
  number: 1,
  checksum: "fixture",
  fingerprint: "version-one:",
};
test("declared inventory validates explicit URLs, bounded fields and exact binding destinations", () => {
  const input = {
    name: "Website",
    kind: "first_party",
    destinations: [destination],
    bindings: [binding],
  };
  assert.ok(consumerSchema.safeParse(input).success);
  const normalized = consumerSchema.parse({
    ...input,
    destinations: [{ ...destination, id: destination.id.toUpperCase() }],
    bindings: [
      {
        ...binding,
        id: binding.id.toUpperCase(),
        destinationId: destination.id.toUpperCase(),
        target: { ...target, assetId: target.assetId.toUpperCase() },
      },
    ],
  });
  assert.equal(normalized.bindings[0]!.target.assetId, target.assetId);
  assert.equal(normalized.destinations[0]!.id, destination.id);
  for (const url of [
    "relative/path",
    "file:///tmp/secret",
    "javascript:alert(1)",
    "https://user:secret@example.test",
    "ftp://example.test",
    "x".repeat(2049),
  ])
    assert.equal(
      consumerSchema.safeParse({
        ...input,
        destinations: [{ ...destination, url }],
      }).success,
      false,
    );
  for (const invalid of [
    { ...input, bindings: [{ ...binding, destinationId: randomUUID() }] },
    { ...input, destinations: [destination, destination] },
    { ...input, bindings: [binding, binding] },
    {
      ...input,
      destinations: Array.from({ length: 21 }, () => ({
        ...destination,
        id: randomUUID(),
      })),
    },
    {
      ...input,
      bindings: Array.from({ length: 101 }, () => ({
        ...binding,
        id: randomUUID(),
      })),
    },
    { ...input, automation: true },
    {
      ...input,
      bindings: [{ ...binding, target: { ...target, workspaceId: "foreign" } }],
    },
  ])
    assert.equal(consumerSchema.safeParse(invalid).success, false);
});
test("scope tracks destination URL, source identity, mode and output definition while labels are descriptive", () => {
  const token = scopeToken(scope);
  assert.equal(
    scopeToken({
      ...scope,
      destination: { ...destination, label: "Renamed" },
      targetLabel: "New label",
    }),
    token,
  );
  for (const changed of [
    { ...scope, destination: { ...destination, url: "https://other.test" } },
    { ...scope, mode: "live_url" as const },
    { ...scope, target: { ...target, assetId: randomUUID() } },
    { ...scope, outputConfiguration: "w=200" },
  ])
    assert.notEqual(scopeToken(changed), token);
});
test("manual evidence statuses never infer external deployment from source state", () => {
  const current = { resolved: true, source, scopeToken: scopeToken(scope) };
  assert.equal(bindingStatus(current, null), "unknown");
  assert.equal(
    bindingStatus({ ...current, resolved: false }, null),
    "unresolved",
  );
  assert.equal(bindingStatus(current, { source, scope }), "recorded_match");
  assert.equal(
    bindingStatus(
      { ...current, source: { ...source, fingerprint: "version-two:" } },
      { source, scope },
    ),
    "source_changed",
  );
  assert.equal(
    bindingStatus({ ...current, scopeToken: "changed" }, { source, scope }),
    "scope_changed",
  );
  assert.equal(
    bindingStatus(
      { ...current, resolved: false, source: null },
      { source, scope },
    ),
    "unresolved",
  );
});
test("manual checks require an explicit real timestamp and bounded future time", () => {
  const input = {
    expectedRevision: 1,
    expectedScopeToken: scopeToken(scope),
    reportedVersionId: source.versionId,
    checkedAt: "2026-01-01T00:00:00Z",
  };
  assert.ok(checkSchema.safeParse(input).success);
  for (const checkedAt of [
    undefined,
    "2026-02-30T00:00:00Z",
    "invalid",
    new Date(Date.now() + 600_000).toISOString(),
  ])
    assert.equal(checkSchema.safeParse({ ...input, checkedAt }).success, false);
});

test("inventory pages use a whole-consumer prefix of at most 100 distinct Vards and always advance", () => {
  const vards = Array.from({ length: 200 }, () => randomUUID());
  const consumer = (ids: string[]) => ({
    bindings: ids.map((vardId) => ({
      ...binding,
      id: randomUUID(),
      target: {
        kind: "vard_output" as const,
        vardId,
        assetId: target.assetId,
        outputPath: "logo.png",
      },
    })),
  });
  const rows = [
    consumer(vards.slice(0, 100)),
    consumer(vards.slice(100)),
    consumer([]),
  ];
  const first = knownUsagePage(rows, 50);
  assert.deepEqual(first.consumers, [rows[0]]);
  assert.equal(first.hasMore, true);
  const second = knownUsagePage(rows.slice(1), 50);
  assert.deepEqual(second.consumers, rows.slice(1));
  assert.equal(second.hasMore, false);
  const repeated = knownUsagePage([rows[0]!, rows[0]!, consumer([])], 50);
  assert.equal(repeated.consumers.length, 3);
  assert.equal(repeated.hasMore, false);
  const limited = knownUsagePage(rows.slice(1), 1);
  assert.equal(limited.consumers.length, 1);
  assert.equal(limited.hasMore, true);
});
