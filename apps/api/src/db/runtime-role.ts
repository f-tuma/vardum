import type { Pool, PoolClient } from "pg";

export const runtimeRole = "varda_app";

// A dedicated role: membership or ownership can restore privileges even when
// its own NOSUPERUSER/NOBYPASSRLS flags look safe.
export async function assertRuntimeDatabaseRole(database: Pool | PoolClient) {
  const { rows } = await database.query<{ unsafe: boolean }>(`
    SELECT
      r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication
      OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member = r.oid)
      OR EXISTS (SELECT 1 FROM pg_database WHERE datname = current_database() AND datdba = r.oid)
      OR has_database_privilege(current_user, current_database(), 'CREATE')
      OR EXISTS (
        SELECT 1 FROM pg_namespace n
        WHERE n.nspname IN ('public', 'pgboss', 'drizzle')
          AND (n.nspowner = r.oid OR has_schema_privilege(current_user, n.oid, 'CREATE'))
      )
      OR EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname IN ('public', 'pgboss', 'drizzle')
          AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
          AND (c.relowner = r.oid OR (c.relkind IN ('r', 'p')
            AND has_table_privilege(current_user, c.oid, 'TRUNCATE')))
      ) AS unsafe
    FROM pg_roles r WHERE r.rolname = current_user
  `);
  if (rows.length !== 1 || rows[0]!.unsafe) {
    throw new Error(
      "Unsafe runtime database role. API and worker require a dedicated non-owner role without superuser, BYPASSRLS, role memberships, schema creation or TRUNCATE privileges. Run migrations separately and use varda_app for DATABASE_URL.",
    );
  }
  const cleanup = await database.query<{ mutable: boolean }>(`
    SELECT EXISTS (
      SELECT 1 FROM pg_class WHERE oid = to_regclass('public.asset_upload_cleanup_scope')
        AND (has_any_column_privilege(current_user, oid, 'INSERT')
          OR has_any_column_privilege(current_user, oid, 'UPDATE')
          OR has_table_privilege(current_user, oid, 'DELETE'))
    ) AS mutable
  `);
  if (cleanup.rows[0]?.mutable !== false)
    throw new Error("Runtime upload cleanup directory must be read-only; review effective INSERT/UPDATE/DELETE grants");
}

// Only called by the privileged, one-shot migrator, after both schemas exist.
// Keep this out of auth/API configuration so runtime services never need the
// administrator's credentials or the ability to create roles.
export async function provisionRuntimeRole(database: Pool, password: string) {
  if (!/^[A-Za-z0-9_-]{24,}$/.test(password)) {
    throw new Error(
      "POSTGRES_APP_PASSWORD must contain at least 24 URL-safe letters, digits, underscores or hyphens",
    );
  }
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query(
      `
      SELECT r.oid, r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication
        OR r.rolname = current_user
        OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member = r.oid)
        OR EXISTS (SELECT 1 FROM pg_shdepend WHERE refobjid = r.oid AND deptype = 'o') AS unsafe
      FROM pg_roles r WHERE rolname = $1
    `,
      [runtimeRole],
    );
    if (existing.rows[0]?.unsafe) {
      throw new Error(
        "Existing varda_app role has elevated privileges or owns objects; review it before migration",
      );
    }
    // Validated above to be URL-safe, and deliberately never logged.
    await client.query(
      existing.rowCount
        ? `ALTER ROLE varda_app LOGIN NOINHERIT PASSWORD '${password}'`
        : `CREATE ROLE varda_app LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${password}'`,
    );

    const databaseName = await client.query<{ name: string }>(
      "SELECT quote_ident(current_database()) AS name",
    );
    await client.query(
      `GRANT CONNECT ON DATABASE ${databaseName.rows[0]!.name} TO varda_app`,
    );
    await client.query(`
      REVOKE CREATE ON SCHEMA public FROM PUBLIC;
      REVOKE ALL ON SCHEMA public, pgboss FROM varda_app;
      GRANT USAGE ON SCHEMA public, pgboss TO varda_app;
      REVOKE ALL ON ALL TABLES IN SCHEMA public, pgboss FROM varda_app;
      REVOKE ALL ON ALL SEQUENCES IN SCHEMA public, pgboss FROM varda_app;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO varda_app;
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO varda_app;
      REVOKE UPDATE, DELETE ON known_usage_check FROM varda_app;
      REVOKE INSERT, UPDATE, DELETE ON asset_upload_cleanup_scope FROM varda_app;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO varda_app;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO varda_app;
      REVOKE ALL ON ALL TABLES IN SCHEMA pgboss FROM PUBLIC;
      REVOKE ALL ON ALL FUNCTIONS IN SCHEMA pgboss FROM PUBLIC, varda_app;
      GRANT EXECUTE ON FUNCTION pgboss.create_queue(text, jsonb) TO varda_app;
      GRANT SELECT ON pgboss.version TO varda_app;
      GRANT UPDATE (cron_on, flow_on) ON pgboss.version TO varda_app;
    `);
    // Never grant access to BAM's executable migration commands or permit the
    // runtime to rewrite the queue schema version. Queue stats partition DDL is
    // disabled at runtime; the application's own delivery metrics are separate.
    const tables = await client.query<{ name: string }>(`
      SELECT quote_ident(tablename) AS name FROM pg_tables
      WHERE schemaname = 'pgboss' AND tablename NOT IN ('version', 'bam')
    `);
    for (const { name } of tables.rows) {
      await client.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON pgboss.${name} TO varda_app`,
      );
    }
    await client.query("SET LOCAL ROLE varda_app");
    await assertRuntimeDatabaseRole(client);
    // Effective privileges include PUBLIC and any inherited access. Do not
    // rewrite unrelated grants: refuse provisioning if append-only still fails.
    const checks = await client.query<{ mutable: boolean }>(`
      SELECT has_any_column_privilege(current_user, 'public.known_usage_check', 'UPDATE')
        OR has_table_privilege(current_user, 'public.known_usage_check', 'DELETE') AS mutable
    `);
    if (checks.rows.length !== 1 || checks.rows[0]!.mutable !== false)
      throw new Error(
        "Runtime role requires append-only known usage checks; review effective UPDATE/DELETE grants before migration",
      );
    await client.query("RESET ROLE");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
