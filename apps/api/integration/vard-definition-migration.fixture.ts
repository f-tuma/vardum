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
    const bindings = join(scratchRoot, "vard-definition-0020");
    await cp(migrationsFolder, bindings, { recursive: true });
    const bindingsJournalPath = join(bindings, "meta/_journal.json");
    const bindingsJournal = JSON.parse(await readFile(bindingsJournalPath, "utf8")) as typeof journal;
    assert.equal(bindingsJournal.entries[index + 1]!.tag, "0021_vard_folder_uses");
    bindingsJournal.entries = bindingsJournal.entries.slice(0, index + 1);
    await writeFile(bindingsJournalPath, JSON.stringify(bindingsJournal));
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
      await migrate(drizzle(database!), { migrationsFolder: bindings });
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
    await t.test("0020 upgrade promotes only true folder opt-ins with exact child and timestamp preservation", async () => {
      const useId = randomUUID(), directId = randomUUID(), folderId = randomUUID();
      const client = await database!.connect();
      try {
        await client.query("BEGIN");
        // This is the real historical0020 guard, which accepts exact2 only.
        await client.query("SELECT set_config('vardum.vard_definition_schema','2',true)");
        await client.query(`INSERT INTO asset_use(id,workspace_id,source_asset_id,key,display_name,output_mime_type,created_by,updated_by)
          VALUES ($1,'ws-history',$2,'art/original.svg','Historical use','image/svg+xml','creator','editor')`, [useId, assetId]);
        for (const [id, includeUses] of [[directId, false], [folderId, true]] as const) {
          await client.query(`INSERT INTO vard(id,workspace_id,name,definition_schema,folder_rules,created_at,created_by,updated_at,updated_by)
            VALUES ($1,'ws-history',$3,2,$2,'2026-01-05 00:00:00.123456+00','creator','2026-01-06 00:00:00.654321+00','editor')`,
          [id, JSON.stringify([{ sourcePrefix: "art/", outputPrefix: "public/", includeUses }]), id]);
          for (const kind of ["source", "pin", "transform", "writable", "use"] as const) {
            await client.query(`INSERT INTO vard_item(workspace_id,vard_id,definition_schema,asset_id,asset_use_id,version_id,output_path,transformation,writable,created_at,created_by,updated_at,updated_by)
              VALUES ('ws-history',$1,2,$2,$3,$4,$5,$6,$7,'2026-01-07 00:00:00.123456+00','item-creator','2026-01-08 00:00:00.654321+00','item-editor')`,
            [id, assetId, kind === "use" ? useId : null, kind === "pin" ? versionId : null, `${kind}.svg`, kind === "transform" ? JSON.stringify({ w: 64, pad: 0.125 }) : null, kind === "writable"]);
          }
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally { client.release(); }
      const savedParents = await parents(), savedItems = await items();
      const savedUses = (await database!.query("SELECT to_jsonb(u) AS record FROM asset_use u ORDER BY id")).rows;
      await migrate(drizzle(database!), { migrationsFolder });
      assert.deepEqual(await parents(), savedParents.map((row) => row.id === folderId ? { ...row, definition_schema: 3 } : row));
      assert.deepEqual(await items(), savedItems.map((row) => row.vard_id === folderId ? { ...row, definition_schema: 3 } : row));
      assert.deepEqual((await database!.query("SELECT to_jsonb(u) AS record FROM asset_use u ORDER BY id")).rows, savedUses);
      assert.deepEqual((await database!.query("SELECT to_jsonb(a) AS record FROM asset a")).rows, beforeSource);
      assert.deepEqual((await database!.query("SELECT to_jsonb(v) AS record FROM asset_version v")).rows, beforeVersions);
      const catalog = (await database!.query(`SELECT
        (SELECT count(*)::int FROM pg_policies WHERE schemaname='public' AND tablename IN ('vard','vard_item') AND policyname='vard_definition_capability' AND permissive='RESTRICTIVE' AND cmd='ALL' AND qual LIKE '%definition_schema = 3%' AND qual LIKE '%''3''%' AND with_check LIKE '%definition_schema = 3%') AS policies,
        (SELECT count(*)::int FROM pg_constraint WHERE conrelid='vard_item'::regclass AND conname='vard_item_vard_fk' AND array_length(conkey,1)=3 AND confupdtype='c' AND confdeltype='c' AND convalidated AND NOT condeferrable) AS parent_fk,
        (SELECT count(*)::int FROM pg_constraint WHERE conrelid='vard'::regclass AND conname='vard_folder_rules_definition_check' AND convalidated) AS folder_check,
        (SELECT provolatile='i' AND proisstrict AND proparallel='s' FROM pg_proc WHERE oid='public.vard_folder_rules_fit_definition(jsonb,smallint)'::regprocedure) AS pure_function
      `)).rows[0];
      assert.deepEqual(catalog, { policies: 2, parent_fk: 1, folder_check: 1, pure_function: true });
      const guard = (await database!.query("SELECT pg_get_functiondef('public.guard_vard_definition_capability()'::regprocedure) AS body")).rows[0].body;
      assert.match(guard, /old_marker = 3 OR new_marker = 3/);
      assert.doesNotMatch(guard, /pg_trigger_depth|current_user|session_user/);
      assert.equal((await database!.query("SELECT current_setting('vardum.vard_definition_schema',true) IS DISTINCT FROM '2' AND current_setting('vardum.vard_definition_schema',true) IS DISTINCT FROM '3' AS safe")).rows[0].safe, true);
      await assert.rejects(database!.query("UPDATE vard SET definition_schema=2 WHERE id=$1", [folderId]),
        (error: unknown) => (error as { constraint: string }).constraint === "vard_definition_capability_guard");
      const capable = await database!.connect();
      try {
        await capable.query("BEGIN");
        await capable.query("SELECT set_config('vardum.vard_definition_schema','3',true)");
        await assert.rejects(capable.query("UPDATE vard SET definition_schema=2 WHERE id=$1", [folderId]),
          (error: unknown) => (error as { constraint: string }).constraint === "vard_folder_rules_definition_check");
      } finally { await capable.query("ROLLBACK"); capable.release(); }
      assert.deepEqual(await parents(), savedParents.map((row) => row.id === folderId ? { ...row, definition_schema: 3 } : row));
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
