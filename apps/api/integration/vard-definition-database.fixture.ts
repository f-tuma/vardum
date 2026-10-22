import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import { setTimeout } from "node:timers/promises";
import { Pool, type PoolClient } from "pg";
import { assertVardDefinitionBaseline } from "../src/db/vard-definition.js";

type Graph = { id: string; itemId: string; sourceId: string; versionId: string; workspaceId: string };
type PgFailure = { code?: string; constraint?: string };
const capability = "vardum.vard_definition_schema";
const guard = "vard_definition_capability_guard";
const matches = (code: string, constraint?: string) => (error: unknown) =>
  (error as PgFailure).code === code && (!constraint || (error as PgFailure).constraint === constraint);

export async function checkVardDefinitionDatabase(
  t: TestContext,
  { admin, runtime, runtimeConnectionString }: {
    admin: Pool;
    runtime: Pool;
    runtimeConnectionString: string;
  },
): Promise<void> {
  const org = `vard-definition-${randomUUID()}`;
  const organizations = [org];
  const workspaces = [`${org}-a`, `${org}-b`];
  // Preserve the host's max1 pool and its deterministic physical-client tests.
  const concurrent = new Pool({ connectionString: runtimeConnectionString, max: 4 });
  async function begin(client: PoolClient, workspaceId?: string, cap?: string) {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout='8s'");
    if (workspaceId !== undefined) await client.query("SELECT set_config('app.workspace_id',$1,true)", [workspaceId]);
    if (cap !== undefined) await client.query("SELECT set_config($1,$2,true)", [capability, cap]);
  }
  async function transaction<T>(pool: Pool, workspaceId: string | undefined, cap: string | undefined, operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await begin(client, workspaceId, cap);
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }
  async function seed(marker: 1 | 2 | 3 = 1, workspaceId = workspaces[0]!, isPublic = false): Promise<Graph> {
    const graph = { id: randomUUID(), itemId: randomUUID(), sourceId: randomUUID(), versionId: randomUUID(), workspaceId };
    await transaction(admin, workspaceId, "3", async (client) => {
      await client.query("INSERT INTO asset(id,workspace_id,key,display_name,created_by,updated_by) VALUES ($1,$2,$3,'Source','fixture','fixture')", [graph.sourceId, workspaceId, `source/${graph.sourceId}.png`]);
      await client.query("INSERT INTO asset_version(id,workspace_id,asset_id,number,status,storage_key,filename,mime_type,size,created_by,updated_by) VALUES ($1,$2,$3,1,'ready',$4,'source.png','image/png',4,'fixture','fixture')", [graph.versionId, workspaceId, graph.sourceId, `${workspaceId}/${graph.versionId}/source`]);
      await client.query("INSERT INTO vard(id,workspace_id,name,is_public,definition_schema,created_by,updated_by) VALUES ($1,$2,$3,$4,$5,'fixture','fixture')", [graph.id, workspaceId, graph.id, isPublic, marker]);
      await client.query("INSERT INTO vard_item(id,workspace_id,vard_id,asset_id,definition_schema,output_path,created_by,updated_by) VALUES ($1,$2,$3,$4,$5,'source.png','fixture','fixture')", [graph.itemId, workspaceId, graph.id, graph.sourceId, marker]);
    });
    return graph;
  }
  async function makeUse(graph: Graph) {
    const id = randomUUID();
    await transaction(admin, graph.workspaceId, "3", async (client) => {
      await client.query("INSERT INTO asset_use(id,workspace_id,source_asset_id,key,display_name,output_mime_type,created_by,updated_by) VALUES ($1,$2,$3,$4,'Original use','image/png','fixture','fixture')", [id, graph.workspaceId, graph.sourceId, `use/${id}.png`]);
    });
    return id;
  }
  async function bind(client: PoolClient, graph: Graph, useId: string, marker: 2 | 3 = 2) {
    const id = randomUUID();
    await client.query("INSERT INTO vard_item(id,workspace_id,vard_id,definition_schema,asset_id,asset_use_id,output_path,created_by,updated_by) VALUES ($1,$2,$3,$4,$5,$6,'linked.png','fixture','fixture')", [id, graph.workspaceId, graph.id, marker, graph.sourceId, useId]);
    return id;
  }
  async function snapshot() {
    return (await admin.query(`SELECT jsonb_build_object(
      'parents',(SELECT coalesce(jsonb_agg(to_jsonb(v) ORDER BY id),'[]'::jsonb) FROM vard v WHERE workspace_id=ANY($1)),
      'items',(SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY id),'[]'::jsonb) FROM vard_item i WHERE workspace_id=ANY($1)),
      'sources',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY id),'[]'::jsonb) FROM asset a WHERE workspace_id=ANY($1)),
      'versions',(SELECT coalesce(jsonb_agg(to_jsonb(v) ORDER BY id),'[]'::jsonb) FROM asset_version v WHERE workspace_id=ANY($1)),
      'uses',(SELECT coalesce(jsonb_agg(to_jsonb(u) ORDER BY id),'[]'::jsonb) FROM asset_use u WHERE workspace_id=ANY($1)),
      'uploads',(SELECT coalesce(jsonb_agg(to_jsonb(u) ORDER BY version_id),'[]'::jsonb) FROM asset_upload u WHERE workspace_id=ANY($1)),
      'workspaces',(SELECT coalesce(jsonb_agg(to_jsonb(w) ORDER BY id),'[]'::jsonb) FROM workspace w WHERE id=ANY($1)),
      'organizations',(SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY id),'[]'::jsonb) FROM organization o WHERE id=ANY($2)),
      'audit',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY id),'[]'::jsonb) FROM audit_event a WHERE workspace_id=ANY($1))
    ) AS state`, [workspaces, organizations])).rows[0].state;
  }
  async function refusal(sql: string, values: unknown[], code: string, constraint?: string, pool = runtime, cap: string | null = "2", workspaceId = workspaces[0]) {
    const before = await snapshot();
    await assert.rejects(transaction(pool, workspaceId, cap ?? undefined, (client) => client.query(sql, values)), matches(code, constraint), sql);
    assert.deepEqual(await snapshot(), before, "a refusal must roll back every affected row");
  }
  async function waitForBlock(waiter: PoolClient, blocker: PoolClient) {
    const waiterPid = (await waiter.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const blockerPid = (await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    return { waiterPid, blockerPid };
  }
  async function observeBlock(waiterPid: number, blockerPid: number) {
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline) {
      const row = (await admin.query("SELECT $2::int=ANY(pg_blocking_pids($1)) AND EXISTS (SELECT 1 FROM pg_locks WHERE pid=$1 AND NOT granted) AS blocked", [waiterPid, blockerPid])).rows[0];
      if (row.blocked) return;
      await setTimeout(10);
    }
    assert.fail("expected a real PostgreSQL lock waiter before releasing the barrier");
  }
  const settled = <T>(operation: Promise<T>) => operation.then(
    (result) => ({ result, error: undefined }),
    (error: unknown) => ({ result: undefined, error }),
  );
  async function assertMatchingMarkers(graph: Graph, marker: 2 | 3 = 2) {
    const rows = (await admin.query("SELECT i.definition_schema AS child,v.definition_schema AS parent FROM vard_item i JOIN vard v ON v.id=i.vard_id WHERE i.vard_id=$1", [graph.id])).rows;
    assert.ok(rows.length > 0);
    assert.ok(rows.every(({ child, parent }) => child === marker && parent === marker));
  }

  try {
    await admin.query("INSERT INTO organization(id,name,slug,created_at) VALUES ($1,'Vard definitions',$1,now())", [org]);
    for (const id of workspaces) await admin.query("INSERT INTO workspace(id,organization_id,name,slug,created_by,updated_by) VALUES ($1,$2,$1,$1,'fixture','fixture')", [id, org]);

    await t.test("exact capability gates public/private parents and children without granting a tenant", async () => {
      const ordinary = await seed(1);
      const privateV2 = await seed(2);
      const publicV2 = await seed(2, workspaces[0], true);
      for (const cap of [undefined, "", "1", "invalid", "02", "2 "]) {
        await transaction(runtime, workspaces[0], cap, async (client) => {
          assert.equal((await client.query("SELECT * FROM vard WHERE id=$1", [ordinary.id])).rowCount, 1);
          assert.equal((await client.query("SELECT * FROM vard WHERE id=ANY($1::uuid[])", [[privateV2.id, publicV2.id]])).rowCount, 0);
          assert.equal((await client.query("SELECT * FROM vard_item WHERE vard_id=ANY($1::uuid[])", [[privateV2.id, publicV2.id]])).rowCount, 0);
          assert.equal((await client.query("UPDATE vard_item SET output_path='old.png' WHERE id=$1", [privateV2.itemId])).rowCount, 0);
          assert.equal((await client.query("DELETE FROM vard WHERE id=$1", [privateV2.id])).rowCount, 0);
          await client.query("UPDATE vard SET name=$2 WHERE id=$1", [ordinary.id, `source-only ${cap ?? "missing"}`]);
        });
      }
      await transaction(runtime, undefined, "2", async (client) => {
        assert.equal((await client.query("SELECT * FROM vard WHERE id=$1", [publicV2.id])).rowCount, 1);
        assert.equal((await client.query("SELECT * FROM vard WHERE id=$1", [privateV2.id])).rowCount, 0);
        assert.equal((await client.query("SELECT * FROM vard_item WHERE vard_id=$1", [publicV2.id])).rowCount, 0);
      });
      await transaction(runtime, workspaces[1], "2", async (client) => {
        assert.equal((await client.query("SELECT * FROM vard WHERE id=$1", [privateV2.id])).rowCount, 0);
        assert.equal((await client.query("SELECT * FROM vard_item WHERE vard_id=$1", [privateV2.id])).rowCount, 0);
      });
      await transaction(runtime, workspaces[0], "2", async (client) => {
        assert.equal((await client.query("SELECT * FROM vard WHERE id=$1", [privateV2.id])).rowCount, 1);
        assert.equal((await client.query("SELECT * FROM vard_item WHERE id=$1", [privateV2.itemId])).rowCount, 1);
      });
      for (const cap of [undefined, "", "1", "invalid"]) {
        await refusal("INSERT INTO vard(workspace_id,name,definition_schema,created_by,updated_by) VALUES ($1,$2,2,'fixture','fixture')", [workspaces[0], randomUUID()], "23514", guard, runtime, cap ?? null);
        for (const [sql, values] of [
          ["UPDATE vard SET name='owner mutation' WHERE id=$1", [privateV2.id]],
          ["UPDATE vard SET definition_schema=1 WHERE id=$1", [privateV2.id]],
          ["DELETE FROM vard WHERE id=$1", [privateV2.id]],
          ["UPDATE vard_item SET output_path='owner.png' WHERE id=$1", [privateV2.itemId]],
          ["UPDATE vard_item SET definition_schema=1 WHERE id=$1", [privateV2.itemId]],
          ["DELETE FROM vard_item WHERE id=$1", [privateV2.itemId]],
        ] as const) await refusal(sql, [...values], "23514", guard, admin, cap ?? null);
      }
      for (const sql of ["ALTER TABLE vard DISABLE TRIGGER ALL", "ALTER TABLE vard_item DISABLE ROW LEVEL SECURITY", "TRUNCATE vard_item"]) {
        await assert.rejects(runtime.query(sql), matches("42501"));
      }
    });

    await t.test("marker3 requires exact local3 while local2 retains only A definitions and no tenant grant", async () => {
      const ordinary = await seed(1), a = await seed(2), b = await seed(3);
      const publicA = await seed(2, workspaces[0], true), publicB = await seed(3, workspaces[0], true);
      for (const cap of [undefined, "", "1", "invalid", "02", "03", "2 ", "3 ", "2", "3"]) {
        const visible = [ordinary, ...(cap === "2" || cap === "3" ? [a] : []), ...(cap === "3" ? [b] : [])];
        await transaction(runtime, workspaces[0], cap, async (client) => {
          assert.deepEqual((await client.query("SELECT id FROM vard WHERE id=ANY($1::uuid[]) ORDER BY id", [[ordinary.id, a.id, b.id]])).rows.map(({ id }) => id), visible.map(({ id }) => id).sort());
          assert.deepEqual((await client.query("SELECT id FROM vard_item WHERE id=ANY($1::uuid[]) ORDER BY id", [[ordinary.itemId, a.itemId, b.itemId]])).rows.map(({ id }) => id), visible.map(({ itemId }) => itemId).sort());
          if (cap !== "3") {
            assert.equal((await client.query("UPDATE vard SET name='old A' WHERE id=$1", [b.id])).rowCount, 0);
            assert.equal((await client.query("DELETE FROM vard_item WHERE id=$1", [b.itemId])).rowCount, 0);
          }
        });
        await transaction(runtime, undefined, cap, async (client) => {
          const expected = [...(cap === "2" || cap === "3" ? [publicA.id] : []), ...(cap === "3" ? [publicB.id] : [])].sort();
          assert.deepEqual((await client.query("SELECT id FROM vard WHERE id=ANY($1::uuid[]) ORDER BY id", [[publicA.id, publicB.id, a.id, b.id]])).rows.map(({ id }) => id), expected);
          assert.equal((await client.query("SELECT * FROM vard_item WHERE vard_id=ANY($1::uuid[])", [[publicA.id, publicB.id]])).rowCount, 0);
        });
      }
      await transaction(runtime, workspaces[1], "3", async (client) => {
        assert.equal((await client.query("SELECT * FROM vard WHERE id=$1", [b.id])).rowCount, 0);
        assert.equal((await client.query("SELECT * FROM vard_item WHERE id=$1", [b.itemId])).rowCount, 0);
      });
      for (const cap of [undefined, "", "1", "invalid", "03", "3 ", "2"]) {
        await refusal("INSERT INTO vard(workspace_id,name,definition_schema,created_by,updated_by) VALUES ($1,$2,3,'fixture','fixture')", [workspaces[0], randomUUID()], "23514", guard, runtime, cap ?? null);
        for (const [sql, values] of [
          ["UPDATE vard SET definition_schema=3 WHERE id=$1", [a.id]],
          ["UPDATE vard SET name='owner mutation' WHERE id=$1", [b.id]],
          ["UPDATE vard SET definition_schema=2 WHERE id=$1", [b.id]],
          ["UPDATE vard SET definition_schema=1 WHERE id=$1", [b.id]],
          ["DELETE FROM vard WHERE id=$1", [b.id]],
          ["UPDATE vard_item SET output_path='owner.png' WHERE id=$1", [b.itemId]],
          ["UPDATE vard_item SET definition_schema=2 WHERE id=$1", [b.itemId]],
          ["UPDATE vard_item SET definition_schema=1 WHERE id=$1", [b.itemId]],
          ["DELETE FROM vard_item WHERE id=$1", [b.itemId]],
        ] as const) await refusal(sql, [...values], "23514", guard, admin, cap ?? null);
      }
      await transaction(runtime, b.workspaceId, "3", async (client) => {
        assert.equal((await client.query("UPDATE vard SET name='B capable' WHERE id=$1", [b.id])).rowCount, 1);
        assert.equal((await client.query("UPDATE vard_item SET output_path='B-capable.png' WHERE id=$1", [b.itemId])).rowCount, 1);
      });
    });

    await t.test("marker3 keeps use tuple constraints and true-only3 rules with an explicit safe downgrade", async () => {
      const graph = await seed(3), useId = await makeUse(graph);
      const linked = await transaction(runtime, graph.workspaceId, "3", (client) => bind(client, graph, useId, 3));
      for (const assignment of ["version_id=$2", "transformation='{}'::jsonb", "transformation='null'::jsonb", "writable=true"]) {
        await refusal(`UPDATE vard_item SET ${assignment} WHERE id=$1`, assignment.includes("$2") ? [linked, graph.versionId] : [linked], "23514", "vard_item_use_binding_check", runtime, "3");
      }
      const insert = "INSERT INTO vard_item(workspace_id,vard_id,definition_schema,asset_id,asset_use_id,output_path,created_by,updated_by) VALUES ($1,$2,2,$3,$4,'mismatch.png','fixture','fixture')";
      await refusal(insert, [graph.workspaceId, graph.id, graph.sourceId, useId], "23503", "vard_item_vard_fk", runtime, "3");
      await refusal("UPDATE vard SET definition_schema=1 WHERE id=$1", [graph.id], "23514", "vard_item_use_binding_check", runtime, "3");
      for (const marker of [1, 2] as const) {
        const sourceOnly = await seed(marker);
        await refusal("UPDATE vard SET folder_rules=$2 WHERE id=$1", [sourceOnly.id, JSON.stringify([{ includeUses: true }])], "23514", "vard_folder_rules_definition_check", runtime, "3");
        await transaction(runtime, sourceOnly.workspaceId, "3", (client) => client.query("UPDATE vard SET folder_rules=$2 WHERE id=$1", [sourceOnly.id, JSON.stringify([{ includeUses: false }, {}])]));
      }
      await transaction(runtime, graph.workspaceId, "3", async (client) => {
        await client.query("UPDATE vard SET folder_rules=$2 WHERE id=$1", [graph.id, JSON.stringify([{ includeUses: true }])]);
        await client.query("DELETE FROM vard_item WHERE id=$1", [linked]);
      });
      await refusal("UPDATE vard SET definition_schema=1 WHERE id=$1", [graph.id], "23514", "vard_folder_rules_definition_check", runtime, "3");
      await transaction(runtime, graph.workspaceId, "3", async (client) => {
        await client.query("UPDATE vard SET folder_rules='[]' WHERE id=$1", [graph.id]);
        assert.equal((await client.query("SELECT definition_schema FROM vard WHERE id=$1", [graph.id])).rows[0].definition_schema, 3);
        await client.query("UPDATE vard SET definition_schema=1 WHERE id=$1", [graph.id]);
      });
      assert.equal((await admin.query("SELECT definition_schema FROM vard_item WHERE id=$1", [graph.itemId])).rows[0].definition_schema, 1);
      await transaction(runtime, graph.workspaceId, undefined, (client) => client.query("UPDATE vard_item SET output_path='source-only-again.png' WHERE id=$1", [graph.itemId]));
    });

    await t.test("tuple FKs and binding checks enforce parent format, source identity and tenant", async () => {
      const graph = await seed(2), other = await seed(2), foreign = await seed(2, workspaces[1]);
      const useId = await makeUse(graph), foreignUse = await makeUse(foreign);
      const insert = "INSERT INTO vard_item(workspace_id,vard_id,definition_schema,asset_id,asset_use_id,version_id,transformation,writable,output_path,created_by,updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'fixture','fixture')";
      const input = (overrides: Partial<{ workspace: string; parent: string; marker: number; source: string; use: string | null; pin: string | null; transform: string | null; writable: boolean }> = {}) => {
        const value = { workspace: graph.workspaceId, parent: graph.id, marker: 2, source: graph.sourceId, use: useId as string | null, pin: null as string | null, transform: null as string | null, writable: false, ...overrides };
        return [value.workspace, value.parent, value.marker, value.source, value.use, value.pin, value.transform, value.writable, `${randomUUID()}.png`];
      };
      for (const override of [{ pin: graph.versionId }, { transform: '{}' }, { transform: 'null' }, { writable: true }]) {
        await refusal(insert, input(override), "23514", "vard_item_use_binding_check");
      }
      await refusal(insert, input({ source: other.sourceId }), "23503", "vard_item_use_fk");
      await refusal(insert, input({ use: foreignUse }), "23503", "vard_item_use_fk");
      await refusal(insert, input({ parent: foreign.id }), "23503", "vard_item_vard_fk");
      await refusal(insert, input({ source: foreign.sourceId, use: null }), "23503", "vard_item_asset_fk");
      await refusal(insert, input({ workspace: foreign.workspaceId }), "42501");
      await refusal(insert, input({ marker: 1, use: null }), "23503", "vard_item_vard_fk");
      const ordinary = await seed(1);
      await refusal(insert, input({ parent: ordinary.id, use: null }), "23503", "vard_item_vard_fk");
      await refusal(insert, input({ parent: ordinary.id, marker: 1 }), "23514", "vard_item_use_binding_check");
      await transaction(runtime, graph.workspaceId, "2", (client) => bind(client, graph, useId));
      await refusal("DELETE FROM asset_use WHERE id=$1", [useId], "23503", "vard_item_use_fk", runtime, null);
      await refusal("DELETE FROM asset WHERE id=$1", [graph.sourceId], "23503", "asset_use_source_fk");
    });

    await t.test("upgrade cascades markers; downgrade is explicit and refuses bindings or folder opt-in", async () => {
      const graph = await seed(1), useId = await makeUse(graph);
      const before = (await admin.query("SELECT to_jsonb(i) AS record FROM vard_item i WHERE id=$1", [graph.itemId])).rows[0].record;
      const linked = await transaction(runtime, graph.workspaceId, "2", async (client) => {
        await client.query("UPDATE vard SET definition_schema=2 WHERE id=$1", [graph.id]);
        return bind(client, graph, useId);
      });
      const after = (await admin.query("SELECT to_jsonb(i) AS record FROM vard_item i WHERE id=$1", [graph.itemId])).rows[0].record;
      assert.deepEqual(after, { ...before, definition_schema: 2 }, "marker cascade preserves every other child field");
      await refusal("UPDATE vard SET definition_schema=1 WHERE id=$1", [graph.id], "23514", "vard_item_use_binding_check");
      await refusal("UPDATE vard_item SET definition_schema=1 WHERE id=$1", [graph.itemId], "23503", "vard_item_vard_fk");
      await transaction(runtime, graph.workspaceId, "2", (client) => client.query("DELETE FROM vard_item WHERE id=$1", [linked]));
      assert.equal((await admin.query("SELECT definition_schema FROM vard WHERE id=$1", [graph.id])).rows[0].definition_schema, 2, "removing the final binding is not an implicit downgrade");
      await refusal("UPDATE vard SET folder_rules=$2 WHERE id=$1", [graph.id, JSON.stringify([{ includeUses: true }])], "23514", "vard_folder_rules_definition_check");
      await transaction(runtime, graph.workspaceId, "3", (client) => client.query("UPDATE vard SET definition_schema=3,folder_rules=$2 WHERE id=$1", [graph.id, JSON.stringify([{ includeUses: true }])]));
      await refusal("UPDATE vard SET definition_schema=1 WHERE id=$1", [graph.id], "23514", "vard_folder_rules_definition_check", runtime, "3");
      await transaction(runtime, graph.workspaceId, "3", async (client) => {
        await client.query("UPDATE vard SET folder_rules='[]',definition_schema=1 WHERE id=$1", [graph.id]);
      });
      assert.equal((await admin.query("SELECT definition_schema FROM vard_item WHERE id=$1", [graph.itemId])).rows[0].definition_schema, 1);
      await transaction(runtime, graph.workspaceId, undefined, async (client) => {
        assert.equal((await client.query("SELECT * FROM vard WHERE id=$1", [graph.id])).rowCount, 1);
        await client.query("UPDATE vard_item SET output_path='back-in-v1.png' WHERE id=$1", [graph.itemId]);
      });
      for (const invalid of [null, true, {}, [null], [true], [{ includeUses: true }], [{ includeUses: null }], [{ includeUses: 0 }], [{ includeUses: "false" }], [{ includeUses: [false] }], [{ includeUses: {} }]]) {
        await refusal("UPDATE vard SET folder_rules=$2 WHERE id=$1", [graph.id, JSON.stringify(invalid)], "23514", "vard_folder_rules_definition_check");
      }
      await transaction(runtime, graph.workspaceId, undefined, (client) => client.query("UPDATE vard SET folder_rules=$2 WHERE id=$1", [graph.id, JSON.stringify([{ includeUses: false }, {}])]));
    });

    await t.test("source, parent, workspace and organization cascades cannot bypass the row trigger", async () => {
      const isolatedOrg = `cascade-${randomUUID()}`, isolatedWorkspace = `${isolatedOrg}-ws`;
      organizations.push(isolatedOrg);
      workspaces.push(isolatedWorkspace);
      await admin.query("INSERT INTO organization(id,name,slug,created_at) VALUES ($1,'Isolated cascade',$1,now())", [isolatedOrg]);
      await admin.query("INSERT INTO workspace(id,organization_id,name,slug,created_by,updated_by) VALUES ($1,$2,$1,$1,'fixture','fixture')", [isolatedWorkspace, isolatedOrg]);
      const graph = await seed(2, isolatedWorkspace);
      // No asset_use exists for this source: a successful test must reach the
      // item's OLD2 trigger, rather than pass due to source-use RESTRICT.
      for (const pool of [runtime, admin]) {
        await refusal("DELETE FROM asset WHERE id=$1", [graph.sourceId], "23514", guard, pool, null, graph.workspaceId);
        await refusal("DELETE FROM workspace WHERE id=$1", [graph.workspaceId], "23514", guard, pool, null, graph.workspaceId);
        await refusal("DELETE FROM organization WHERE id=$1", [isolatedOrg], "23514", guard, pool, null, graph.workspaceId);
      }
      await transaction(runtime, graph.workspaceId, "2", (client) => client.query("DELETE FROM asset WHERE id=$1", [graph.sourceId]));
      assert.equal((await admin.query("SELECT * FROM vard_item WHERE id=$1", [graph.itemId])).rowCount, 0);
      assert.equal((await admin.query("SELECT definition_schema FROM vard WHERE id=$1", [graph.id])).rows[0].definition_schema, 2);
      const parent = await seed(2, isolatedWorkspace);
      await transaction(runtime, parent.workspaceId, "2", (client) => client.query("DELETE FROM vard WHERE id=$1", [parent.id]));
      assert.equal((await admin.query("SELECT * FROM vard_item WHERE id=$1", [parent.itemId])).rowCount, 0);
      const ordinary = await seed(1, isolatedWorkspace);
      await transaction(runtime, ordinary.workspaceId, undefined, (client) => client.query("DELETE FROM asset WHERE id=$1", [ordinary.sourceId]));
      assert.equal((await admin.query("SELECT * FROM vard_item WHERE id=$1", [ordinary.itemId])).rowCount, 0, "schema1 source cascade retains its previous behavior");
    });

    await t.test("old A capability2 cannot bypass OLD3 in source, workspace or organization cascades", async () => {
      const isolatedOrg = `cascade3-${randomUUID()}`, isolatedWorkspace = `${isolatedOrg}-ws`;
      organizations.push(isolatedOrg); workspaces.push(isolatedWorkspace);
      await admin.query("INSERT INTO organization(id,name,slug,created_at) VALUES ($1,'Isolated B cascade',$1,now())", [isolatedOrg]);
      await admin.query("INSERT INTO workspace(id,organization_id,name,slug,created_by,updated_by) VALUES ($1,$2,$1,$1,'fixture','fixture')", [isolatedWorkspace, isolatedOrg]);
      const graph = await seed(3, isolatedWorkspace);
      // No use exists: refusals must actually reach OLD3 rather than RESTRICT.
      for (const pool of [runtime, admin]) for (const cap of [null, "", "invalid", "2"]) {
        await refusal("DELETE FROM asset WHERE id=$1", [graph.sourceId], "23514", guard, pool, cap, graph.workspaceId);
        await refusal("DELETE FROM workspace WHERE id=$1", [graph.workspaceId], "23514", guard, pool, cap, graph.workspaceId);
        await refusal("DELETE FROM organization WHERE id=$1", [isolatedOrg], "23514", guard, pool, cap, graph.workspaceId);
      }
      const before = await snapshot();
      await assert.rejects(transaction(runtime, graph.workspaceId, "2", async (client) => {
        await client.query("INSERT INTO audit_event(workspace_id,actor_type,action,target_type,target_id,request_id) VALUES ($1,'system','before-cascade','workspace',$1,'old-A-guard-rollback')", [graph.workspaceId]);
        await client.query("DELETE FROM workspace WHERE id=$1", [graph.workspaceId]);
      }), matches("23514", guard));
      assert.deepEqual(await snapshot(), before);
      await transaction(runtime, graph.workspaceId, "3", (client) => client.query("DELETE FROM asset WHERE id=$1", [graph.sourceId]));
      assert.equal((await admin.query("SELECT * FROM vard_item WHERE id=$1", [graph.itemId])).rowCount, 0);
      const parent = await seed(3, isolatedWorkspace);
      await transaction(runtime, parent.workspaceId, "3", (client) => client.query("DELETE FROM vard WHERE id=$1", [parent.id]));
      assert.equal((await admin.query("SELECT * FROM vard_item WHERE id=$1", [parent.itemId])).rowCount, 0);
      await seed(3, isolatedWorkspace);
      await transaction(runtime, isolatedWorkspace, "3", (client) => client.query("DELETE FROM workspace WHERE id=$1", [isolatedWorkspace]));
      assert.equal((await admin.query("SELECT * FROM vard WHERE workspace_id=$1", [isolatedWorkspace])).rowCount, 0);
    });

    for (const targetMarker of [2, 3] as const) for (const action of ["insert", "update", "delete"] as const) {
      for (const upgradeFirst of [true, false]) {
        await t.test(`upgrade to ${targetMarker} versus old child ${action}, ${upgradeFirst ? "upgrade" : "old writer"} holds the first lock`, async () => {
          const previousMarker = targetMarker === 3 ? 2 : 1;
          const graph = await seed(previousMarker), useId = await makeUse(graph);
          const old = await concurrent.connect(), capable = await concurrent.connect();
          const { waiterPid: oldPid, blockerPid: capablePid } = await waitForBlock(old, capable);
          let pending: ReturnType<typeof settled> | undefined;
          const oldWrite = () => action === "insert"
            ? old.query("INSERT INTO vard_item(workspace_id,vard_id,asset_id,definition_schema,output_path,created_by,updated_by) VALUES ($1,$2,$3,$4,'old-insert.png','old','old')", [graph.workspaceId, graph.id, graph.sourceId, previousMarker])
            : old.query(action === "update" ? "UPDATE vard_item SET output_path='old-update.png' WHERE id=$1" : "DELETE FROM vard_item WHERE id=$1", [graph.itemId]);
          try {
            await begin(old, graph.workspaceId, targetMarker === 3 ? "2" : undefined);
            await begin(capable, graph.workspaceId, String(targetMarker));
            if (upgradeFirst) {
              await capable.query("UPDATE vard SET definition_schema=$2 WHERE id=$1", [graph.id, targetMarker]);
              await bind(capable, graph, useId, targetMarker);
              pending = settled(oldWrite());
              // This statement starts with the old child snapshot, then waits
              // for the uncommitted FK cascade to publish its newer marker.
              await observeBlock(oldPid, capablePid);
              await capable.query("COMMIT");
              const outcome = await pending;
              if (outcome.error) {
                assert.ok(["23503", "23514", "42501"].includes((outcome.error as PgFailure).code ?? ""), String(outcome.error));
                await old.query("ROLLBACK");
              } else {
                assert.equal((outcome.result as { rowCount: number }).rowCount, 0, "an old statement must not mutate the upgraded definition");
                await old.query("COMMIT");
              }
            } else {
              assert.equal((await oldWrite()).rowCount, 1);
              pending = settled(capable.query("UPDATE vard SET definition_schema=$2 WHERE id=$1", [graph.id, targetMarker]));
              await observeBlock(capablePid, oldPid);
              await old.query("COMMIT");
              const outcome = await pending;
              assert.equal(outcome.error, undefined);
              await bind(capable, graph, useId, targetMarker);
              await capable.query("COMMIT");
            }
            await assertMatchingMarkers(graph, targetMarker);
            assert.equal((await admin.query("SELECT * FROM vard_item WHERE vard_id=$1 AND asset_use_id=$2", [graph.id, useId])).rowCount, 1);
            const source = (await admin.query("SELECT output_path FROM vard_item WHERE id=$1", [graph.itemId])).rows[0];
            if (upgradeFirst) assert.equal(source.output_path, "source.png");
            else if (action === "update") assert.equal(source.output_path, "old-update.png");
            else if (action === "delete") assert.equal(source, undefined);
          } finally {
            await Promise.allSettled([old.query("ROLLBACK"), capable.query("ROLLBACK")]);
            if (pending) await pending;
            old.release(); capable.release();
          }
        });
      }
    }

    for (const bindFirst of [true, false]) {
      await t.test(`binding versus use delete, ${bindFirst ? "binding" : "delete"} holds the first lock`, async () => {
        const graph = await seed(2), useId = await makeUse(graph);
        const binder = await concurrent.connect(), remover = await concurrent.connect();
        const { waiterPid: binderPid, blockerPid: removerPid } = await waitForBlock(binder, remover);
        let pending: ReturnType<typeof settled> | undefined;
        try {
          await begin(binder, graph.workspaceId, "2");
          await begin(remover, graph.workspaceId);
          if (bindFirst) {
            await bind(binder, graph, useId);
            pending = settled(remover.query("DELETE FROM asset_use WHERE id=$1", [useId]));
            await observeBlock(removerPid, binderPid);
            await binder.query("COMMIT");
            const outcome = await pending;
            assert.ok(matches("23503", "vard_item_use_fk")(outcome.error));
            await remover.query("ROLLBACK");
          } else {
            await remover.query("DELETE FROM asset_use WHERE id=$1", [useId]);
            pending = settled(bind(binder, graph, useId));
            await observeBlock(binderPid, removerPid);
            await remover.query("COMMIT");
            const outcome = await pending;
            assert.ok(matches("23503", "vard_item_use_fk")(outcome.error));
            await binder.query("ROLLBACK");
          }
          assert.equal((await admin.query("SELECT * FROM asset_use WHERE id=$1", [useId])).rowCount, bindFirst ? 1 : 0);
          assert.equal((await admin.query("SELECT * FROM vard_item WHERE vard_id=$1 AND asset_use_id=$2", [graph.id, useId])).rowCount, bindFirst ? 1 : 0);
          await assertMatchingMarkers(graph);
        } finally {
          await Promise.allSettled([binder.query("ROLLBACK"), remover.query("ROLLBACK")]);
          if (pending) await pending;
          binder.release(); remover.release();
        }
      });
    }

    await t.test("local capability ends on commit, rollback, error, reuse and reconnect", async () => {
      const original = await runtime.connect();
      const pid = (await original.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      try {
        for (const cap of ["2", "3"]) for (const ending of ["COMMIT", "ROLLBACK"]) {
          await begin(original, workspaces[0], cap);
          assert.equal((await original.query("SELECT current_setting($1,true) AS value", [capability])).rows[0].value, cap);
          await original.query(ending);
          await assertVardDefinitionBaseline(original);
          assert.notEqual((await original.query("SELECT current_setting('app.workspace_id',true) AS value")).rows[0].value, workspaces[0]);
        }
        await begin(original, workspaces[0], "3");
        await assert.rejects(original.query("SELECT 1/0"), matches("22012"));
        await original.query("ROLLBACK");
        await assertVardDefinitionBaseline(original);
      } finally { original.release(); }
      const reused = await runtime.connect();
      try {
        assert.equal((await reused.query("SELECT pg_backend_pid() AS pid")).rows[0].pid, pid);
        await assertVardDefinitionBaseline(reused);
      } finally { reused.release(); }

      let checks = 0;
      const checked = new Pool({ connectionString: runtimeConnectionString, max: 3,
        onConnect: async (client) => { checks++; await assertVardDefinitionBaseline(client); } });
      try {
        const clients = await Promise.all([checked.connect(), checked.connect(), checked.connect()]);
        const pids = new Set<number>();
        try {
          for (const client of clients) {
            pids.add((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
            await begin(client, workspaces[0], "3");
          }
          assert.equal(pids.size, 3);
          for (const client of clients) {
            await client.query("ROLLBACK");
            await assertVardDefinitionBaseline(client);
          }
        } finally { for (const client of clients) client.release(true); }
        const reconnected = await checked.connect();
        try {
          assert.equal(pids.has((await reconnected.query("SELECT pg_backend_pid() AS pid")).rows[0].pid), false);
          await assertVardDefinitionBaseline(reconnected);
          assert.equal(checks, 4);
        } finally { reconnected.release(); }
      } finally { await checked.end(); }
    });

    await t.test("awaited pool validation refuses startup2 or startup3 before a caller receives the client", async () => {
      for (const value of [undefined, "", "1", "invalid", "02", "03", "2", "3"]) {
        let acquired = false;
        const checked = new Pool({ connectionString: runtimeConnectionString, max: 1,
          options: `-c statement_timeout=1234${value === undefined ? "" : ` -c ${capability}=${value}`}`,
          onConnect: assertVardDefinitionBaseline });
        try {
          const acquire = checked.connect().then(async (client) => {
            acquired = true;
            try {
              assert.equal((await client.query("SHOW statement_timeout")).rows[0].statement_timeout, "1234ms");
              await assertVardDefinitionBaseline(client);
            } finally { client.release(); }
          });
          if (value === "2" || value === "3") {
            await assert.rejects(acquire, /Unsafe Vard definition capability baseline/);
            assert.equal(acquired, false);
            assert.equal(checked.totalCount, 0, "a rejected physical connection must be destroyed");
          } else { await acquire; assert.equal(acquired, true); }
        } finally { await checked.end(); }
      }
    });

    await t.test("capable workspace deletion uses Vards then uses then workspace", async () => {
      const before = await snapshot();
      await assert.rejects(transaction(runtime, workspaces[0], undefined, async (client) => {
        await client.query("INSERT INTO audit_event(workspace_id,actor_type,action,target_type,target_id,request_id) VALUES ($1,'system','before-cascade','workspace',$1,'guard-rollback')", [workspaces[0]]);
        await client.query("DELETE FROM workspace WHERE id=$1", [workspaces[0]]);
      }), (error: unknown) => ["23514", "23503"].includes((error as PgFailure).code ?? ""));
      assert.deepEqual(await snapshot(), before, "refused cascade also rolls back preceding audit work");
      for (const workspaceId of workspaces) {
        await transaction(runtime, workspaceId, "3", async (client) => {
          await client.query("DELETE FROM vard WHERE workspace_id=$1", [workspaceId]);
          await client.query("DELETE FROM asset_use WHERE workspace_id=$1", [workspaceId]);
          await client.query("DELETE FROM workspace WHERE id=$1", [workspaceId]);
        });
      }
      assert.equal((await admin.query("SELECT * FROM vard_item WHERE workspace_id=ANY($1)", [workspaces])).rowCount, 0);
    });
  } finally {
    await concurrent.end();
    await transaction(admin, undefined, "3", async (client) => {
      await client.query("DELETE FROM vard WHERE workspace_id=ANY($1)", [workspaces]);
      await client.query("DELETE FROM asset_use WHERE workspace_id=ANY($1)", [workspaces]);
      await client.query("DELETE FROM organization WHERE id=ANY($1)", [organizations]);
      await client.query("DELETE FROM asset_upload WHERE workspace_id=ANY($1)", [workspaces]);
    });
  }
}
