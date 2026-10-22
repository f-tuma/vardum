import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

// A second database keeps the fresh production-migrator proof independent from
// historical upgrades. No auth, queue process or object server is needed here.
export async function checkVardDefinitionMigration(
  t: TestContext,
  { adminConnectionString, migrationsFolder, scratchRoot }: {
    adminConnectionString: string;
    migrationsFolder: string;
    scratchRoot: string;
  },
): Promise<void> {
  const databaseName = `vard_definition_${randomUUID().replaceAll("-", "")}`;
  const control = new Pool({ connectionString: adminConnectionString });
  const connection = new URL(adminConnectionString);
  connection.pathname = `/${databaseName}`;
  let database: Pool | undefined;
  let created = false;
  try {
    await control.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    database = new Pool({ connectionString: connection.toString() });
    const previous = join(scratchRoot, "vard-definition-0019");
    await cp(migrationsFolder, previous, { recursive: true });
    const journalPath = join(previous, "meta/_journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
      entries: Array<{ tag: string }>;
    };
    const index = journal.entries.findIndex(({ tag }) => tag === "0020_vard_definition_bindings");
    assert.ok(index > 0);
    assert.equal(journal.entries[index - 1]!.tag, "0019_upload_object_integrity");
    journal.entries = journal.entries.slice(0, index);
    await writeFile(journalPath, JSON.stringify(journal));
    await migrate(drizzle(database), { migrationsFolder: previous });
    assert.equal((await database.query("SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='vard' AND column_name='definition_schema') AS present")).rows[0].present, false);

    const assetId = randomUUID(), versionId = randomUUID();
    const parentIds = [randomUUID(), randomUUID()];
    await database.query("INSERT INTO organization(id,name,slug,created_at) VALUES ('org-history','History','org-history',now())");
    await database.query("INSERT INTO workspace(id,organization_id,name,slug,created_by,updated_by) VALUES ('ws-history','org-history','History','ws-history','creator','editor')");
    await database.query("INSERT INTO asset(id,workspace_id,key,display_name,created_by,updated_by) VALUES ($1,'ws-history','history.svg','History','creator','editor')", [assetId]);
    await database.query("INSERT INTO asset_version(id,workspace_id,asset_id,number,status,storage_key,filename,mime_type,size,created_by,updated_by) VALUES ($1,'ws-history',$2,1,'ready','historical/source','history.svg','image/svg+xml',42,'creator','editor')", [versionId, assetId]);
    await database.query("UPDATE asset SET current_version_id=$1 WHERE id=$2", [versionId, assetId]);
    for (const [index, id] of parentIds.entries()) {
      await database.query(`INSERT INTO vard(id,workspace_id,name,is_public,folder_rules,created_at,created_by,updated_at,updated_by)
        VALUES ($1,'ws-history',$2,$3,$4,'2026-01-01 00:00:00.123456+00','creator','2026-01-02 00:00:00.654321+00','editor')`,
      [id, `Historical ${index}`, index === 1, JSON.stringify([{ sourcePrefix: "art/", outputPrefix: "public/", includeUses: false }])]);
      for (const kind of ["pinned", "transformed", "writable"] as const) {
        await database.query(`INSERT INTO vard_item(workspace_id,vard_id,asset_id,version_id,output_path,transformation,writable,created_at,created_by,updated_at,updated_by)
          VALUES ('ws-history',$1,$2,$3,$4,$5,$6,'2026-01-03 00:00:00.123456+00','item-creator','2026-01-04 00:00:00.654321+00','item-editor')`,
        [id, assetId, kind === "pinned" ? versionId : null, `${kind}.svg`, kind === "transformed" ? JSON.stringify({ w: 64, pad: 0.125 }) : null, kind === "writable"]);
      }
    }
    const parents = async () => (await database!.query("SELECT to_jsonb(v) AS record FROM vard v ORDER BY id")).rows.map(({ record }) => record);
    const items = async () => (await database!.query("SELECT to_jsonb(i) AS record FROM vard_item i ORDER BY id")).rows.map(({ record }) => record);
    const beforeParents = await parents(), beforeItems = await items();
    const beforeSource = (await database.query("SELECT to_jsonb(a) AS record FROM asset a")).rows;
    const beforeVersions = (await database.query("SELECT to_jsonb(v) AS record FROM asset_version v")).rows;

    await t.test("0019 upgrade preserves literal definition, pins, recipe and exact timestamps", async () => {
      await migrate(drizzle(database!), { migrationsFolder });
      assert.deepEqual(await parents(), beforeParents.map((row) => ({ ...row, definition_schema: 1 })));
      assert.deepEqual(await items(), beforeItems.map((row) => ({ ...row, definition_schema: 1, asset_use_id: null })));
      assert.deepEqual((await database!.query("SELECT to_jsonb(a) AS record FROM asset a")).rows, beforeSource);
      assert.deepEqual((await database!.query("SELECT to_jsonb(v) AS record FROM asset_version v")).rows, beforeVersions);
      const row = (await database!.query(`SELECT
        (SELECT count(*)::int FROM pg_class WHERE relnamespace='public'::regnamespace AND relname IN ('vard','vard_item') AND relrowsecurity AND relforcerowsecurity) AS forced,
        (SELECT count(*)::int FROM pg_policies WHERE schemaname='public' AND tablename IN ('vard','vard_item') AND policyname='vard_definition_capability' AND permissive='RESTRICTIVE' AND cmd='ALL' AND qual IS NOT NULL AND with_check IS NOT NULL) AS policies,
        (SELECT count(*)::int FROM pg_constraint WHERE conrelid='vard_item'::regclass AND conname='vard_item_vard_fk' AND array_length(conkey,1)=3 AND confupdtype='c' AND confdeltype='c' AND convalidated AND NOT condeferrable) AS parent_fk,
        (SELECT count(*)::int FROM pg_trigger WHERE tgrelid IN ('vard'::regclass,'vard_item'::regclass) AND NOT tgisinternal AND tgname IN ('vard_definition_capability_guard','vard_item_definition_capability_guard') AND tgenabled='O') AS triggers
      `)).rows[0];
      assert.deepEqual(row, { forced: 2, policies: 2, parent_fk: 1, triggers: 2 });
      await assert.rejects(database!.query("UPDATE vard SET definition_schema=2 WHERE id=$1", [parentIds[0]]),
        (error: unknown) => (error as { constraint: string }).constraint === "vard_definition_capability_guard",
        "even the migration owner must explicitly declare capability before upgrading data");
      await database!.query("UPDATE vard SET name='Old writer still works' WHERE id=$1", [parentIds[0]]);
    });
    await t.test("tracked reruns leave migrated definitions and source history unchanged", async () => {
      const savedParents = await parents(), savedItems = await items();
      await migrate(drizzle(database!), { migrationsFolder });
      await migrate(drizzle(database!), { migrationsFolder });
      assert.deepEqual(await parents(), savedParents);
      assert.deepEqual(await items(), savedItems);
      assert.deepEqual((await database!.query("SELECT to_jsonb(v) AS record FROM asset_version v")).rows, beforeVersions);
    });
  } finally {
    await database?.end();
    if (created) await control.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    await control.end();
  }
}
