import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runtimeDatabaseProbeSql, validateRuntimeDatabaseProbe } from "./fixtures/runtime-database.mjs";

const ready = { role: "varda_app", unscoped_assets: 0, unscoped_asset_uses: 0, uses_rls: true, uses_tenant_policy: true, unscoped_known_usages: 0, unscoped_known_checks: 0, usage_rls: true, usage_tenant_policies: true, usage_crud: true, checks_append_only: true, cleanup_read_only: true };
test("current deployed database probe requires private inventory and exact append-only evidence permissions", () => {
  assert.doesNotThrow(() => validateRuntimeDatabaseProbe(ready));
  for (const [field, value] of [["role", "varda"], ["unscoped_assets", 1], ["unscoped_asset_uses", 1], ["uses_rls", false], ["uses_tenant_policy", false], ["unscoped_known_usages", 1], ["unscoped_known_checks", 1], ["usage_rls", false], ["usage_tenant_policies", false], ["usage_crud", false], ["checks_append_only", false], ["cleanup_read_only", false]])
    assert.throws(() => validateRuntimeDatabaseProbe({ ...ready, [field]: value }), /runtime role|RLS|append-only/);
  for (const field of Object.keys(ready)) { const row = { ...ready }; delete row[field]; assert.throws(() => validateRuntimeDatabaseProbe(row)); }
});
test("saved-image smoke includes the database fixture and retains role ownership checks", async () => {
  const smoke = await readFile(new URL("./smoke-production.sh", import.meta.url), "utf8");
  assert.match(smoke, /await assertRuntimeDatabaseRole\(pool\)/);
  assert.match(smoke, /pool\.query\(fixtures\.runtimeDatabaseProbeSql\)/);
  assert.match(smoke, /fixtures\.validateRuntimeDatabaseProbe\(result\.rows\[0\]\)/);
  assert.match(smoke, /scripts\/fixtures\/svg-compatibility\.mjs scripts\/fixtures\/runtime-database\.mjs/);
  assert.match(runtimeDatabaseProbeSql, /NOT has_any_column_privilege\(current_user, 'public\.known_usage_check', 'UPDATE'\)/);
  assert.match(runtimeDatabaseProbeSql, /NOT has_table_privilege\(current_user, 'public\.known_usage_check', 'DELETE'\)/);
  // The real PostgreSQL acceptance separately executes this SQL under varda_app.
});
