// Disposable deployment acceptance only. No workspace context is set; tenant
// rows must remain invisible. Keep this module free of environment or secrets
// so it can share the stdin fixture module used by the saved API image probe.
// pg_policies uses deterministic pg_get_expr output on supported PostgreSQL 15/17;
// compare both explicit source predicates, including NULL/missing expressions.
export const runtimeDatabaseProbeSql = `
SELECT current_user AS role,
  (SELECT count(*)::int FROM public.asset) AS unscoped_assets,
  (SELECT count(*)::int FROM public.known_usage) AS unscoped_known_usages,
  (SELECT count(*)::int FROM public.known_usage_check) AS unscoped_known_checks,
  (SELECT count(*) = 2 AND bool_and(relrowsecurity AND relforcerowsecurity)
    FROM pg_class WHERE relnamespace = 'public'::regnamespace
      AND relname IN ('known_usage', 'known_usage_check')) AS usage_rls,
  (SELECT count(*) = 2 AND bool_and(COALESCE(
      policyname = 'workspace_isolation' AND cmd = 'ALL'
      AND permissive = 'PERMISSIVE' AND roles = ARRAY['public']::name[]
      AND qual = '(workspace_id = current_setting(''app.workspace_id''::text, true))'
      AND with_check = '(workspace_id = current_setting(''app.workspace_id''::text, true))',
      false))
    FROM pg_policies WHERE schemaname = 'public'
      AND tablename IN ('known_usage', 'known_usage_check')) AS usage_tenant_policies,
  has_table_privilege(current_user, 'public.known_usage', 'SELECT')
    AND has_table_privilege(current_user, 'public.known_usage', 'INSERT')
    AND has_table_privilege(current_user, 'public.known_usage', 'UPDATE')
    AND has_table_privilege(current_user, 'public.known_usage', 'DELETE') AS usage_crud,
  has_table_privilege(current_user, 'public.known_usage_check', 'SELECT')
    AND has_table_privilege(current_user, 'public.known_usage_check', 'INSERT')
    AND NOT has_any_column_privilege(current_user, 'public.known_usage_check', 'UPDATE')
    AND NOT has_table_privilege(current_user, 'public.known_usage_check', 'DELETE') AS checks_append_only
`;

export function validateRuntimeDatabaseProbe(row) {
  if (row?.role !== "varda_app" || row.unscoped_assets !== 0 ||
      row.unscoped_known_usages !== 0 || row.unscoped_known_checks !== 0 ||
      row.usage_rls !== true || row.usage_tenant_policies !== true ||
      row.usage_crud !== true || row.checks_append_only !== true)
    throw new Error("Deployed runtime role, private inventory RLS or append-only check grants failed");
}
