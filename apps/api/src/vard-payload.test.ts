import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { asset, assetUse, assetVersion, vard, vardItem, type VardTransformation } from "./db/app-schema.js";
import type { useRows } from "./asset-use-query.js";
import { config } from "./config.js";
import type { Transaction } from "./db/tenant.js";
import { canonicalizeTransformation } from "./transformation.js";
import { folderUseItemId, VardResolutionError } from "./vard-folder-rules.js";
import { buildVardPayloadInTransaction } from "./vard-payload.js";

function fixture(count = 1000) {
  const vardId = randomUUID();
  const record = {
    id: vardId,
    name: "Fixture",
    isPublic: true,
    folderRules: [] as { sourcePrefix: string; outputPrefix: string; includeUses?: boolean }[],
    updatedAt: new Date(),
    workspaceSlug: "fixture",
  };
  const items = Array.from({ length: count }, (_, index) => ({
    id: randomUUID(),
    assetId: randomUUID(),
    assetUseId: null as string | null,
    isPublic: true,
    key: `source-${index}.png`,
    outputPath: `output-${index}.png`,
    transformation: null as VardTransformation | null,
    writable: false,
    pinnedVersionId: null as string | null,
    currentVersionId: randomUUID(),
  }));
  const versions = items.map((item) => ({
    id: item.currentVersionId,
    assetId: item.assetId,
    status: "ready",
    checksum: "fixture",
    mimeType: "image/png",
    size: 4,
    width: 32,
    height: 32,
  }));
  const uses: Awaited<ReturnType<typeof useRows>> = [];
  function link(index: number, values: Partial<(typeof uses)[number]> = {}) {
    const item = items[index]!;
    const version = versions[index]!;
    const use = {
      id: randomUUID(), key: `linked-${index}.png`, displayName: `Linked ${index}`,
      sourceAssetId: item.assetId, transformation: null, outputMimeType: "image/png",
      revision: 1, updatedAt: new Date(), sourceKey: item.key,
      sourceDisplayName: `Source ${index}`, isPublic: item.isPublic,
      currentVersionId: item.currentVersionId, sourceMimeType: version.mimeType,
      sourceWidth: version.width, sourceHeight: version.height, sourceProcessing: false,
      ...values,
    };
    uses.push(use);
    item.assetUseId = use.id;
    return use;
  }
  const folderSources: Array<{ assetId: string; key: string; mimeType: string;
    isPublic: boolean; currentVersionId: string | null }> = [];
  const folderUses: Array<{ assetUseId: string; assetId: string; key: string;
    outputMimeType: string; sourceKey: string; isPublic: boolean;
    currentVersionId: string | null; sourceMimeType: string | null }> = [];
  function includeUse(index: number, key: string, values: Partial<(typeof uses)[number]> = {}) {
    const use = link(index, { key, ...values });
    folderUses.push({ assetUseId: use.id, assetId: use.sourceAssetId, key: use.key,
      outputMimeType: use.outputMimeType, sourceKey: use.sourceKey, isPublic: use.isPublic,
      currentVersionId: use.currentVersionId, sourceMimeType: use.sourceMimeType });
    return use;
  }
  const folderQueries: Array<{ kind: "source" | "use"; params: unknown[]; where: string;
    privateWindow: string; limit: number | undefined; joins: Array<{ kind: string; sql: string }> }> = [];
  const versionQueries: unknown[][] = [];
  const useQueries: unknown[][] = [];
  const tx = {
    select(selection?: Record<string, unknown>) {
      let table: unknown, condition: SQL | undefined, limit: number | undefined;
      const joins: Array<{ kind: string; sql: string }> = [];
      const query = {
        from(value: unknown) {
          table = value;
          return query;
        },
        innerJoin(_table: unknown, value: SQL) {
          joins.push({ kind: "inner", sql: new PgDialect().sqlToQuery(value).sql });
          return query;
        },
        leftJoin(_table: unknown, value: SQL) {
          joins.push({ kind: "left", sql: new PgDialect().sqlToQuery(value).sql });
          return query;
        },
        $dynamic() {
          return query;
        },
        where(value: SQL) {
          condition = value;
          return query;
        },
        orderBy() {
          return query;
        },
        limit(value: number) {
          limit = value;
          return query;
        },
        then(
          resolve: (rows: unknown[]) => unknown,
          reject: (error: unknown) => unknown,
        ) {
          let rows: unknown[];
          if (table === vard) rows = [record];
          else if (table === vardItem) rows = items;
          else if (selection?.hasPrivateMember && (table === asset || table === assetUse)) {
            const compiled = new PgDialect().sqlToQuery(condition!);
            folderQueries.push({ kind: table === asset ? "source" : "use", params: compiled.params,
              where: compiled.sql, privateWindow: new PgDialect().sqlToQuery(selection.hasPrivateMember as SQL).sql,
              joins, limit });
            const all = table === asset ? folderSources : folderUses;
            const hasPrivateMember = all.some((row) => !row.isPublic);
            rows = all.slice(0, limit).map((row) => ({ ...row, hasPrivateMember }));
          }
          else if (table === assetUse) {
            const params = new PgDialect().sqlToQuery(condition!).params;
            useQueries.push(params);
            rows = uses.filter((use) => params.includes(use.id));
          }
          else if (table === assetVersion) {
            const params = new PgDialect().sqlToQuery(condition!).params;
            versionQueries.push(params);
            rows = versions.filter((version) => params.includes(version.id));
          } else throw new Error("Unexpected table in payload query fixture");
          return Promise.resolve(rows).then(resolve, reject);
        },
      };
      return query;
    },
  } as unknown as Transaction;
  return { vardId, record, items, versions, uses, link, includeUse, folderSources, folderUses, folderQueries, versionQueries, useQueries, tx };
}
test("selected payload validates 1000 outputs but queries and builds only selected exact asset/path versions", async () => {
  const f = fixture();
  const selected = f.items[321]!;
  const payload = await buildVardPayloadInTransaction(
    f.tx,
    "fixture-ws",
    f.vardId,
    {
      selectedTargets: [
        { assetId: selected.assetId, outputPath: selected.outputPath },
      ],
    },
  );
  assert.equal(payload!.items.length, 1);
  assert.equal(payload!.items[0]!.versionId, selected.currentVersionId);
  assert.deepEqual(
    f.versionQueries,
    [["fixture-ws", selected.currentVersionId]],
    "actual generated SQL must not bind unselected version IDs",
  );
  const wrong = fixture();
  const empty = await buildVardPayloadInTransaction(
    wrong.tx,
    "fixture-ws",
    wrong.vardId,
    {
      selectedTargets: [
        { assetId: randomUUID(), outputPath: wrong.items[0]!.outputPath },
      ],
    },
  );
  assert.equal(empty!.items.length, 0);
  assert.equal(
    wrong.versionQueries.length,
    0,
    "an output rebound to another asset must not hydrate its source",
  );
});
test("unselected collisions and output overflow invalidate the entire selected Vard before any version lookup", async () => {
  for (const count of [1000, 1001]) {
    const f = fixture(count);
    const selected = f.items[321]!;
    if (count === 1000)
      f.items[1]!.outputPath = f.items[0]!.outputPath.toUpperCase();
    await assert.rejects(
      buildVardPayloadInTransaction(f.tx, "fixture-ws", f.vardId, {
        selectedTargets: [
          { assetId: selected.assetId, outputPath: selected.outputPath },
        ],
      }),
      VardResolutionError,
    );
    assert.equal(f.versionQueries.length, 0);
  }
});
test("default Vard payload retains complete manifest hydration and anonymous privacy checks", async () => {
  const f = fixture(3);
  const payload = await buildVardPayloadInTransaction(
    f.tx,
    "fixture-ws",
    f.vardId,
  );
  assert.equal(payload!.items.length, 3);
  assert.deepEqual(f.versionQueries[0], [
    "fixture-ws",
    ...f.items.map((item) => item.currentVersionId),
  ]);
  const privateFixture = fixture(2);
  privateFixture.items[1]!.isPublic = false;
  assert.equal(
    await buildVardPayloadInTransaction(
      privateFixture.tx,
      "fixture-ws",
      privateFixture.vardId,
      {
        anonymous: true,
        selectedTargets: [
          {
            assetId: privateFixture.items[0]!.assetId,
            outputPath: privateFixture.items[0]!.outputPath,
          },
        ],
      },
    ),
    null,
  );
  assert.equal(privateFixture.versionQueries.length, 0);
});

test("live uses retain the saved complete recipe and canonical source identity without changing their fixed output path", async () => {
  const f = fixture(2);
  f.versions[1]!.mimeType = "image/svg+xml";
  const original = f.link(0);
  const recipe: VardTransformation = {
    w: 40, h: 60, fit: "contain", format: "png", q: 91,
    pad: 12.25, bg: "#abcdef", layer: "artwork", render: "v2",
  };
  const transformed = f.link(1, { transformation: recipe });
  const payload = await buildVardPayloadInTransaction(f.tx, "fixture-ws", f.vardId);
  const [a, b] = payload!.items;
  assert.equal(a!.assetId, original.sourceAssetId);
  assert.equal(a!.key, f.items[0]!.key);
  assert.equal(a!.transformation, null);
  assert.equal(a!.writable, false);
  assert.equal(a!.pinned, false);
  assert.equal(a!.downloadUrl, `/w/fixture/__v/${f.versions[0]!.id}/${f.items[0]!.key}`);
  assert.deepEqual(b!.transformation, recipe);
  assert.equal(b!.outputPath, f.items[1]!.outputPath);
  assert.equal(b!.assetId, transformed.sourceAssetId);
  assert.equal(b!.key, f.items[1]!.key);
  assert.equal(b!.sourceMimeType, "image/svg+xml");
  assert.equal(b!.mimeType, "image/png");
  assert.equal(b!.fingerprint, `${f.versions[1]!.id}:${canonicalizeTransformation(recipe)}`);
  assert.ok(b!.downloadUrl!.startsWith(`/w/fixture/__v/${f.versions[1]!.id}/${f.items[1]!.key}?`));
  assert.ok(b!.downloadUrl!.includes("pad=12.25"));
  assert.ok(b!.downloadUrl!.includes("render=v2"));
  for (const item of payload!.items) {
    assert.equal("bindingIdentity" in item, false);
    assert.equal("availabilityError" in item, false);
    assert.equal("linkedUse" in item, false);
  }
  // Updating the use changes only effective output; its Vard ID/path remain.
  const oldFingerprint = b!.fingerprint;
  transformed.transformation = { ...recipe, w: 80 };
  transformed.key = "a-new-use-name.png";
  transformed.revision += 1;
  const refreshed = await buildVardPayloadInTransaction(f.tx, "fixture-ws", f.vardId);
  assert.equal(refreshed!.items[1]!.id, b!.id);
  assert.equal(refreshed!.items[1]!.outputPath, b!.outputPath);
  assert.notEqual(refreshed!.items[1]!.fingerprint, oldFingerprint);
});

test("legacy use recipes do not acquire a renderer and internal metadata is explicit", async () => {
  const f = fixture(2);
  const use = f.link(0, {
    transformation: { w: 24, format: "png", pad: 0 }, sourceProcessing: true,
  });
  const payload = await buildVardPayloadInTransaction(f.tx, "fixture-ws", f.vardId, {
    includeBindingIdentity: true, includeEditorDiagnostics: true,
  });
  assert.deepEqual(payload!.items[0]!.bindingIdentity, { kind: "use", assetUseId: use.id });
  assert.deepEqual(payload!.items[1]!.bindingIdentity, { kind: "source" });
  assert.equal(payload!.items[0]!.availabilityError, null);
  assert.deepEqual(payload!.items[0]!.linkedUse, {
    id: use.id, key: use.key, displayName: use.displayName,
    revision: use.revision, sourceDisplayName: use.sourceDisplayName,
    sourceProcessing: true,
  });
  assert.deepEqual(payload!.items[0]!.transformation, use.transformation);
  assert.equal(payload!.items[0]!.downloadUrl!.includes("render="), false);
  assert.equal(payload!.items[0]!.downloadUrl!.includes("pad="), false);
});

test("unavailable uses preserve the literal output but never fall back to a ready source original", async () => {
  const cases = ["missing", "tuple", "source-type", "fixed-path", "svg", "pixels", "unready"] as const;
  for (const scenario of cases) {
    const f = fixture(1);
    const use = f.link(0);
    if (scenario === "missing") f.uses.length = 0;
    if (scenario === "tuple") use.sourceAssetId = randomUUID();
    if (scenario === "source-type") use.sourceMimeType = f.versions[0]!.mimeType = "image/jpeg";
    if (scenario === "fixed-path") f.items[0]!.outputPath = "fixed.jpeg";
    if (scenario === "svg") {
      use.transformation = { format: "svg" };
      use.outputMimeType = "image/svg+xml";
      use.key = "linked.svg";
    }
    if (scenario === "pixels") {
      use.transformation = { format: "png" };
      use.sourceMimeType = f.versions[0]!.mimeType = "image/svg+xml";
      use.sourceWidth = f.versions[0]!.width = config.TRANSFORM_MAX_OUTPUT_PIXELS + 1;
      use.sourceHeight = f.versions[0]!.height = 1;
    }
    if (scenario === "unready") use.sourceMimeType = null;
    const payload = await buildVardPayloadInTransaction(f.tx, "fixture-ws", f.vardId, {
      includeEditorDiagnostics: true, includeBindingIdentity: true,
    });
    const output = payload!.items[0]!;
    assert.equal(output.id, f.items[0]!.id, scenario);
    assert.equal(output.outputPath, f.items[0]!.outputPath, scenario);
    assert.equal(output.assetId, f.items[0]!.assetId, scenario);
    assert.equal(output.versionId, null, scenario);
    assert.equal(output.sourceChecksum, null, scenario);
    assert.equal(output.downloadUrl, null, scenario);
    assert.equal(output.fingerprint, null, scenario);
    assert.equal(output.size, null, scenario);
    assert.ok(output.availabilityError, scenario);
    assert.deepEqual(output.bindingIdentity, { kind: "use", assetUseId: use.id }, scenario);
    if (scenario === "pixels") assert.match(output.availabilityError!, /pixel limit/);
    if (scenario === "fixed-path") assert.match(output.availabilityError!, /path extension/);
    if (scenario === "svg") assert.match(output.availabilityError!, /require an SVG source/);
  }
});

test("use hydration is bounded to selected targets after full namespace and privacy validation", async () => {
  const f = fixture(3);
  f.link(0);
  const selectedUse = f.link(1);
  f.link(2);
  const selected = f.items[1]!;
  const payload = await buildVardPayloadInTransaction(f.tx, "fixture-ws", f.vardId, {
    selectedTargets: [{ assetId: selected.assetId, outputPath: selected.outputPath }],
  });
  assert.equal(payload!.items.length, 1);
  assert.deepEqual(f.useQueries, [["fixture-ws", selectedUse.id]]);
  assert.deepEqual(f.versionQueries, [["fixture-ws", selected.currentVersionId]]);

  const privateFixture = fixture(2);
  privateFixture.items[1]!.isPublic = false;
  privateFixture.items[1]!.outputPath = privateFixture.items[0]!.outputPath;
  privateFixture.link(1, { sourceMimeType: null });
  assert.equal(await buildVardPayloadInTransaction(privateFixture.tx, "fixture-ws", privateFixture.vardId, {
    anonymous: true, includeEditorDiagnostics: true,
  }), null);
  assert.equal(privateFixture.useQueries.length, 0);
  assert.equal(privateFixture.versionQueries.length, 0);
});

test("capture rechecks the public flag before outputs and never exposes editor diagnostics anonymously", async () => {
  const f = fixture(1);
  f.record.isPublic = false;
  f.link(0);
  assert.equal(await buildVardPayloadInTransaction(f.tx, "fixture-ws", f.vardId, {
    requirePublic: true,
  }), null);
  assert.equal(f.useQueries.length, 0);
  assert.equal(f.versionQueries.length, 0);
  f.record.isPublic = true;
  const payload = await buildVardPayloadInTransaction(f.tx, "fixture-ws", f.vardId, {
    anonymous: true, requirePublic: true, includeEditorDiagnostics: true,
  });
  assert.equal("availabilityError" in payload!.items[0]!, false);
  assert.equal("linkedUse" in payload!.items[0]!, false);
});

test("generated uses match use keys while canonical source URLs and complete live recipes stay separate", async () => {
  const f = fixture(1);
  const recipe = { w: 40, h: 60, fit: "contain" as const, format: "png" as const,
    q: 91, pad: 12.25, bg: "#abcdef", render: "v2" as const };
  f.versions[0]!.mimeType = "image/svg+xml";
  f.items[0]!.key = "outside/source.svg";
  const use = f.includeUse(0, "linked/card", { transformation: recipe });
  const source = f.items[0]!;
  f.items.length = 0;
  f.record.folderRules = [{ sourcePrefix: "linked/", outputPrefix: "public/", includeUses: true }];
  const first = (await buildVardPayloadInTransaction(f.tx, "fixture-ws", f.vardId, {
    includeBindingIdentity: true,
  }))!.items[0]!;
  assert.equal(first.id, folderUseItemId(use.id, "public/card.png"));
  assert.equal(first.assetId, source.assetId);
  assert.equal(first.key, source.key);
  assert.equal(first.outputPath, "public/card.png");
  assert.deepEqual(first.transformation, recipe);
  assert.deepEqual(first.bindingIdentity, { kind: "use", assetUseId: use.id });
  assert.equal(first.pinned, false);
  assert.equal(first.writable, false);
  assert.ok(first.downloadUrl!.startsWith(`/w/fixture/__v/${source.currentVersionId}/${source.key}?`));
  assert.ok(first.downloadUrl!.includes("pad=12.25"));
  assert.ok(first.downloadUrl!.includes("bg=%23abcdef"));
  use.transformation = { ...recipe, w: 80 };
  const updated = (await buildVardPayloadInTransaction(f.tx, "fixture-ws", f.vardId))!.items[0]!;
  assert.equal(updated.id, first.id);
  assert.notEqual(updated.fingerprint, first.fingerprint);
  const nextVersionId = randomUUID();
  f.versions[0]!.id = nextVersionId;
  f.folderUses[0]!.currentVersionId = use.currentVersionId = nextVersionId;
  const next = (await buildVardPayloadInTransaction(f.tx, "fixture-ws", f.vardId))!.items[0]!;
  assert.equal(next.id, first.id);
  assert.equal(next.versionId, nextVersionId);
  use.outputMimeType = f.folderUses[0]!.outputMimeType = "image/webp";
  use.transformation = { ...recipe, format: "webp" };
  const reformatted = (await buildVardPayloadInTransaction(f.tx, "fixture-ws", f.vardId))!.items[0]!;
  assert.equal(reformatted.outputPath, "public/card.webp");
  assert.notEqual(reformatted.id, first.id);
  f.folderUses.length = 0;
  assert.deepEqual((await buildVardPayloadInTransaction(f.tx, "fixture-ws", f.vardId))!.items, []);
});

test("generated unready or mismatched uses retain membership without an Original fallback", async () => {
  for (const scenario of ["unready", "fixed-path"] as const) {
    const f = fixture(1);
    const use = f.includeUse(0, "linked/card.png");
    f.items.length = 0;
    f.record.folderRules = [{ sourcePrefix: "linked/", outputPrefix: "public/", includeUses: true }];
    if (scenario === "unready") {
      f.versions[0]!.status = "processing";
      use.sourceMimeType = f.folderUses[0]!.sourceMimeType = null;
    } else {
      use.outputMimeType = f.folderUses[0]!.outputMimeType = "image/webp";
      use.transformation = { format: "webp" };
    }
    const result = (await buildVardPayloadInTransaction(f.tx, "fixture-ws", f.vardId, {
      includeEditorDiagnostics: true,
    }))!.items[0]!;
    assert.equal(result.id, folderUseItemId(use.id, "public/card.png"), scenario);
    assert.equal(result.outputPath, "public/card.png", scenario);
    for (const value of [result.versionId, result.sourceChecksum, result.fingerprint, result.downloadUrl, result.size])
      assert.equal(value, null, scenario);
    assert.ok(result.availabilityError, scenario);
  }
});

test("both full matching privacy windows precede source overflow and selected availability hydration", async () => {
  const f = fixture(0);
  f.record.folderRules = [{ sourcePrefix: "linked/", outputPrefix: "public/", includeUses: true }];
  f.folderSources.push(...Array.from({ length: 1001 }, (_, index) => ({
    assetId: `source-${index}`, key: `linked/source-${index}.png`, mimeType: "image/png",
    isPublic: true, currentVersionId: null,
  })));
  f.folderUses.push(...Array.from({ length: 1002 }, (_, index) => ({
    assetUseId: `use-${index}`, assetId: `outside-${index}`, key: `linked/use-${index}`,
    outputMimeType: "image/png", sourceKey: `outside/source-${index}.png`,
    isPublic: index !== 1001, currentVersionId: null, sourceMimeType: null,
  })));
  assert.equal(await buildVardPayloadInTransaction(f.tx, "fixture-ws", f.vardId, {
    anonymous: true, selectedTargets: [{ assetId: "source-0", outputPath: "public/source-0.png" }],
  }), null);
  assert.deepEqual(f.folderQueries.map((query) => query.kind), ["source", "use"]);
  for (const query of f.folderQueries) {
    assert.equal(query.limit, 1001);
    assert.match(query.privateWindow, /bool_or\(not .*is_public.*\) over \(\)/);
  }
  const useQuery = f.folderQueries[1]!;
  assert.match(useQuery.where, /starts_with\("asset_use"\."key"/);
  assert.doesNotMatch(useQuery.where, /status|mime_type/);
  assert.equal(useQuery.joins[1]!.kind, "left");
  assert.match(useQuery.joins[1]!.sql, /status/);
  assert.equal(f.useQueries.length, 0);
  assert.equal(f.versionQueries.length, 0);
  await assert.rejects(buildVardPayloadInTransaction(f.tx, "fixture-ws", f.vardId), /more than 1000/);
});

test("folder use hydration remains selected-only after whole namespace validation and opt-in is explicit", async () => {
  const f = fixture(2);
  const use = f.includeUse(0, "linked/card");
  const canonical = f.items.shift()!;
  f.record.folderRules = [{ sourcePrefix: "linked/", outputPrefix: "public/", includeUses: true }];
  const result = await buildVardPayloadInTransaction(f.tx, "fixture-ws", f.vardId, {
    selectedTargets: [{ assetId: canonical.assetId, outputPath: "public/card.png" }],
  });
  assert.equal(result!.items.length, 1);
  assert.deepEqual(f.useQueries, [["fixture-ws", use.id]]);
  assert.deepEqual(f.versionQueries, [["fixture-ws", canonical.currentVersionId]]);
  f.record.folderRules[0]!.includeUses = false;
  f.folderQueries.length = 0;
  const withoutOptIn = await buildVardPayloadInTransaction(f.tx, "fixture-ws", f.vardId);
  assert.equal(withoutOptIn!.items.length, 1);
  assert.deepEqual(f.folderQueries.map((query) => query.kind), ["source"]);
});
