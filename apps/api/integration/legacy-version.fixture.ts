import type { Pool } from "pg";

/**
 * Privileged fault injection for pre-existing malformed/unavailable records.
 * These fixtures exercise read-side defenses against historical data; normal
 * API/worker writes now reject these mutations (upload-integrity tests). Only
 * the disposable cluster owner can disable this one publication trigger.
 */
export async function mutateLegacyVersion(admin: Pool, query: string, values: unknown[]) {
  const client = await admin.connect();
  try {
    await client.query("BEGIN");
    await client.query("ALTER TABLE asset_version DISABLE TRIGGER asset_version_guard_publication");
    await client.query(query, values);
    await client.query("ALTER TABLE asset_version ENABLE TRIGGER asset_version_guard_publication");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}
