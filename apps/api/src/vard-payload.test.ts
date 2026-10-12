import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { assetVersion, vard, vardItem } from "./db/app-schema.js";
import type { Transaction } from "./db/tenant.js";
import { VardResolutionError } from "./vard-folder-rules.js";
import { buildVardPayloadInTransaction } from "./vard-payload.js";

function fixture(count = 1000) {
  const vardId = randomUUID();
  const items = Array.from({ length: count }, (_, index) => ({
    id: randomUUID(),
    assetId: randomUUID(),
    isPublic: true,
    key: `source-${index}.png`,
    outputPath: `output-${index}.png`,
    transformation: null,
    writable: false,
    pinnedVersionId: null,
    currentVersionId: randomUUID(),
  }));
  const versionQueries: unknown[][] = [];
  const tx = {
    select() {
      let table: unknown, condition: SQL | undefined;
      const query = {
        from(value: unknown) {
          table = value;
          return query;
        },
        innerJoin() {
          return query;
        },
        where(value: SQL) {
          condition = value;
          return query;
        },
        orderBy() {
          return query;
        },
        limit() {
          return query;
        },
        then(
          resolve: (rows: unknown[]) => unknown,
          reject: (error: unknown) => unknown,
        ) {
          let rows: unknown[];
          if (table === vard)
            rows = [
              {
                id: vardId,
                name: "Fixture",
                isPublic: true,
                folderRules: [],
                updatedAt: new Date(),
                workspaceSlug: "fixture",
              },
            ];
          else if (table === vardItem) rows = items;
          else if (table === assetVersion) {
            const params = new PgDialect().sqlToQuery(condition!).params;
            versionQueries.push(params);
            rows = items
              .filter((item) => params.includes(item.currentVersionId))
              .map((item) => ({
                id: item.currentVersionId,
                assetId: item.assetId,
                status: "ready",
                checksum: "fixture",
                mimeType: "image/png",
                size: 4,
              }));
          } else throw new Error("Unexpected table in payload query fixture");
          return Promise.resolve(rows).then(resolve, reject);
        },
      };
      return query;
    },
  } as unknown as Transaction;
  return { vardId, items, versionQueries, tx };
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
