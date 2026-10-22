import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { cp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { setTimeout } from "node:timers/promises";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Pool, PoolClient } from "pg";

/** Returns the historical cleanup check to run after runtime-role provisioning. */
export async function checkUploadIntegrityMigration(
  t: TestContext,
  admin: Pool,
  migrations: string,
  root: string,
): Promise<(objects: Map<string, Buffer>) => Promise<void>> {
  const previous = join(root, "upload-integrity-0018");
  await cp(migrations, previous, { recursive: true });
  const journalPath = join(previous, "meta/_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
    entries: Array<{ tag: string }>;
  };
  const upgradeIndex = journal.entries.findIndex(
    ({ tag }) => tag === "0019_upload_object_integrity",
  );
  assert.ok(upgradeIndex > 0);
  assert.equal(journal.entries[upgradeIndex - 1]!.tag, "0018_asset_archive");
  journal.entries = journal.entries.slice(0, upgradeIndex);
  await writeFile(journalPath, JSON.stringify(journal));
  await migrate(drizzle(admin), { migrationsFolder: previous });
  assert.equal(
    (await admin.query("SELECT to_regclass('public.asset_upload') AS relation"))
      .rows[0].relation,
    null,
    "historical uploads must be inserted before the ledger exists",
  );

  const assetId = randomUUID();
  const vardId = randomUUID();
  const statuses = ["pending", "processing", "failed", "ready"] as const;
  const historical = statuses.map((status, index) => ({
    id: randomUUID(),
    status,
    number: index + 1,
    attemptId: status === "processing" ? randomUUID() : null,
    jobId: status === "processing" ? randomUUID() : null,
  }));
  const ready = historical.find(({ status }) => status === "ready")!;
  const processing = historical.find(({ status }) => status === "processing")!;
  const concurrentId = randomUUID();
  const versionIds = [...historical.map(({ id }) => id), concurrentId];
  const legacyBytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="16"><rect width="32" height="16" fill="red"/></svg>');
  const replayBytes = Buffer.from(legacyBytes.toString().replace('fill="red"', 'fill="tan"'));
  const checksum = createHash("sha256").update(legacyBytes).digest("hex");
  const storageKey = (versionId: string) =>
    `originals/ws/${assetId}/${versionId}/source`;
  let migrationClient: PoolClient | undefined;
  let writerClient: PoolClient | undefined;
  let originalQuery: PoolClient["query"] | undefined;
  let migration: Promise<void> | undefined;
  let writer: Promise<unknown> | undefined;
  let releaseBackfill = () => {};
  let retainHistoricalData = false;
  const cleanupFixture = async (objects?: Map<string, Buffer>) => {
    if (objects) {
      for (const key of objects.keys()) {
        if (key.startsWith(`originals/ws/${assetId}/`)) objects.delete(key);
      }
    }
    await admin.query("DELETE FROM vard WHERE id=$1", [vardId]);
    await admin.query("DELETE FROM asset WHERE id=$1", [assetId]);
    if ((await admin.query("SELECT to_regclass('public.asset_upload') AS relation")).rows[0].relation) {
      await admin.query("DELETE FROM asset_upload WHERE version_id=ANY($1::uuid[])", [versionIds]);
    }
  };
  try {
    await admin.query(
      "INSERT INTO asset(id,workspace_id,key,display_name,created_by,updated_by) VALUES($1,'ws',$2,'Historical upload','fixture','fixture')",
      [assetId, `historical-upload/${assetId}`],
    );
    for (const version of historical) {
      await admin.query(
        `INSERT INTO asset_version(
          id,workspace_id,asset_id,number,status,storage_key,filename,mime_type,size,
          checksum,expected_checksum,width,height,error,ingest_job_id,ingest_attempt_id,
          retryable,created_at,created_by,updated_at,updated_by
        ) VALUES($1,'ws',$2,$3,$4,$5,'historical.svg','image/svg+xml',$14,
          $6,$7,$8,$9,$10,$11,$12,$13,'2026-01-01T00:00:00Z','fixture',
          '2026-01-02T00:00:00Z','fixture')`,
        [
          version.id, assetId, version.number, version.status, storageKey(version.id),
          version.status === "ready" ? checksum : null, checksum,
          version.status === "ready" ? 32 : null,
          version.status === "ready" ? 16 : null,
          version.status === "failed" ? "Historical retryable failure" : null,
          version.jobId, version.attemptId, version.status === "failed", legacyBytes.length,
        ],
      );
    }
    await admin.query("UPDATE asset SET current_version_id=$2 WHERE id=$1", [assetId, ready.id]);
    await admin.query(
      "INSERT INTO vard(id,workspace_id,name,created_by,updated_by) VALUES($1,'ws',$2,'fixture','fixture')",
      [vardId, `Historical upload ${vardId}`],
    );
    await admin.query(
      "INSERT INTO vard_item(workspace_id,vard_id,asset_id,version_id,output_path,created_by,updated_by) VALUES('ws',$1,$2,$3,'historical.svg','fixture','fixture')",
      [vardId, assetId, ready.id],
    );
    const beforeVersions = (await admin.query(
      "SELECT * FROM asset_version WHERE asset_id=$1 ORDER BY number", [assetId],
    )).rows;
    const beforeAsset = (await admin.query("SELECT * FROM asset WHERE id=$1", [assetId])).rows;
    const beforePin = (await admin.query("SELECT * FROM vard_item WHERE vard_id=$1", [vardId])).rows;
    const expectedPin = beforePin.map((item) => ({ ...item, definition_schema: 1, asset_use_id: null }));

    migrationClient = await admin.connect();
    writerClient = await admin.connect();
    const migrationPid = (await migrationClient.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;
    const writerPid = (await writerClient.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;
    let enteredBackfill!: () => void;
    const backfillEntered = new Promise<void>((resolve) => { enteredBackfill = resolve; });
    const backfillGate = new Promise<void>((resolve) => { releaseBackfill = resolve; });
    let paused = false;
    originalQuery = migrationClient.query;
    // Pause the real Drizzle transaction after its actual backfill. This leaves
    // migration bookkeeping, statement boundaries and COMMIT on the normal path.
    const query = originalQuery;
    const client = migrationClient;
    client.query = (async (...args: unknown[]) => {
      const result: unknown = await Reflect.apply(query, client, args);
      const command = args[0];
      const text = typeof command === "string" ? command
        : (command as { text?: string } | undefined)?.text;
      if (!paused && text && /^\s*INSERT\s+INTO\s+"?asset_upload"?\s*\(/i.test(text)) {
        paused = true;
        enteredBackfill();
        await backfillGate;
      }
      return result;
    }) as PoolClient["query"];
    migration = migrate(drizzle(client), { migrationsFolder: migrations });
    // Observe rejection immediately, including if an unexpected migration fails
    // before reaching the gate, so no background promise becomes unhandled.
    void migration.catch(() => {});
    await Promise.race([
      backfillEntered,
      migration.then(() => { throw new Error("Integrity migration did not execute its backfill"); }),
    ]);

    let writerSettled = false;
    writer = writerClient.query(
      "INSERT INTO asset_version(id,workspace_id,asset_id,number,storage_key,filename,mime_type,size,created_by,updated_by) VALUES($1,'ws',$2,5,$3,'concurrent.svg','image/svg+xml',123,'fixture','fixture')",
      [concurrentId, assetId, storageKey(concurrentId)],
    ).then(
      (result) => { writerSettled = true; return result; },
      (error: unknown) => { writerSettled = true; throw error; },
    );
    void writer.catch(() => {});
    const deadline = Date.now() + 5_000;
    let blocked = false;
    do {
      const row = (await admin.query<{ blocked: boolean }>(`
        SELECT EXISTS (
          SELECT 1 FROM pg_locks
          WHERE pid=$1 AND relation='public.asset_version'::regclass
            AND mode='RowExclusiveLock' AND NOT granted
        ) AND $2::int=ANY(pg_blocking_pids($1)) AS blocked
      `, [writerPid, migrationPid])).rows[0]!;
      blocked = row.blocked;
      if (blocked || writerSettled) break;
      await setTimeout(10);
    } while (Date.now() < deadline);
    assert.equal(writerSettled, false, "an upload inserted between backfill and trigger must wait for the migration");
    assert.equal(blocked, true, "the concurrent INSERT must hold a pending table lock blocked by the migrator");
    releaseBackfill();
    await migration;
    await writer;

    assert.deepEqual(
      (await admin.query("SELECT * FROM asset_version WHERE id=ANY($1::uuid[]) ORDER BY number", [historical.map(({ id }) => id)])).rows,
      beforeVersions,
      "upgrading preserves every historical pending/processing/failed/ready field",
    );
    assert.deepEqual((await admin.query("SELECT * FROM asset WHERE id=$1", [assetId])).rows, beforeAsset);
    assert.deepEqual((await admin.query("SELECT * FROM vard_item WHERE vard_id=$1", [vardId])).rows, expectedPin,
      "ready current/pinned identity, historical source key and checksum are unchanged");
    const ledgerSql = "SELECT version_id,workspace_id,asset_id,storage_key,created_at FROM asset_upload WHERE version_id=ANY($1::uuid[]) ORDER BY version_id";
    const ledger = (await admin.query(ledgerSql, [versionIds])).rows;
    const trackedVersions = (await admin.query(
      "SELECT id AS version_id,workspace_id,asset_id,storage_key,created_at FROM asset_version WHERE asset_id=$1 ORDER BY id", [assetId],
    )).rows;
    assert.equal(ledger.length, 5, "all four historical states and the concurrent insert are tracked");
    assert.deepEqual(ledger, trackedVersions);
    assert.equal(ledger.some((row) => row.version_id === ready.id), true,
      "the historical ready source is tracked without rewriting its object identity");
    await assert.rejects(
      admin.query("UPDATE asset_version SET status='ready',checksum=$2 WHERE id=$1", [processing.id, checksum]),
      /must be sealed/,
      "an old worker cannot publish the pre-upgrade client-writable key",
    );
    await assert.rejects(
      admin.query("UPDATE asset_version SET checksum=$2 WHERE id=$1", [ready.id, "d".repeat(64)]),
      /immutable/,
      "the grandfathered ready identity is still immutable",
    );
    await migrate(drizzle(admin), { migrationsFolder: migrations });
    assert.deepEqual((await admin.query(ledgerSql, [versionIds])).rows, ledger,
      "tracked migrator reruns preserve the durable inventory");
    t.diagnostic("Historical 0018→0019 pending/processing/failed/ready upgrade and locked concurrent upload passed.");
    retainHistoricalData = true;
    return async (objects) => {
      try {
        const { cleanupUploadObjects } = await import("../src/upload-objects.js");
        const { pool } = await import("../src/db/index.js");
        assert.equal((await pool.query("SELECT current_user AS role")).rows[0].role, "varda_app",
          "historical cleanup must use the provisioned runtime role");
        assert.equal((await pool.query("SELECT * FROM asset_upload WHERE version_id=ANY($1::uuid[])", [versionIds])).rowCount, 0,
          "the runtime connection has no unscoped access to the historical ledger");
        const readyKey = storageKey(ready.id);
        const now = Date.now();
        objects.set(readyKey, legacyBytes);
        await cleanupUploadObjects(new Date(now));
        assert.deepEqual(objects.get(readyKey), legacyBytes,
          "cleanup preserves the original bytes of a historical ready version");
        assert.equal(createHash("sha256").update(objects.get(readyKey)!).digest("hex"), checksum);
        assert.deepEqual(
          (await admin.query("SELECT * FROM asset_version WHERE id=ANY($1::uuid[]) ORDER BY number", [historical.map(({ id }) => id)])).rows,
          beforeVersions,
          "runtime cleanup does not rewrite historical statuses, ready keys or checksums",
        );
        assert.deepEqual((await admin.query("SELECT * FROM asset WHERE id=$1", [assetId])).rows, beforeAsset);
        assert.deepEqual((await admin.query("SELECT * FROM vard_item WHERE vard_id=$1", [vardId])).rows, expectedPin,
          "current and pinned references survive historical ready cleanup");
        assert.deepEqual((await admin.query(ledgerSql, [versionIds])).rows, ledger);

        await admin.query("DELETE FROM vard WHERE id=$1", [vardId]);
        await admin.query("DELETE FROM asset WHERE id=$1", [assetId]);
        assert.equal((await admin.query("SELECT * FROM asset_version WHERE id=ANY($1::uuid[])", [versionIds])).rowCount, 0);
        assert.deepEqual((await admin.query(ledgerSql, [versionIds])).rows, ledger,
          "historical ready cleanup inventory survives metadata deletion");
        // The asset-delete job has removed the original. A still valid old POST
        // can complete afterwards, so the retained ledger must sweep it again.
        assert.equal(objects.delete(readyKey), true);
        assert.equal(replayBytes.length, legacyBytes.length);
        assert.notEqual(createHash("sha256").update(replayBytes).digest("hex"), checksum);
        objects.set(readyKey, replayBytes);
        await cleanupUploadObjects(new Date(now + 86_400_001));
        assert.equal(objects.has(readyKey), false,
          "a late recreation after historical ready deletion is swept");
        assert.deepEqual((await admin.query(ledgerSql, [versionIds])).rows, ledger);
        objects.set(readyKey, replayBytes);
        await cleanupUploadObjects(new Date(now + 2 * 86_400_001));
        assert.equal(objects.has(readyKey), false,
          "a second late recreation is swept without losing the durable tombstone");
        assert.deepEqual((await admin.query(ledgerSql, [versionIds])).rows, ledger);
        t.diagnostic("Historical ready bytes survived cleanup; deleted historical keys and repeated late recreations were swept under the runtime role.");
      } finally {
        await cleanupFixture(objects);
      }
    };
  } finally {
    releaseBackfill();
    await Promise.allSettled([migration, writer].filter((operation) => operation !== undefined));
    if (migrationClient && originalQuery) migrationClient.query = originalQuery;
    migrationClient?.release();
    writerClient?.release();
    if (!retainHistoricalData) await cleanupFixture();
  }
}
