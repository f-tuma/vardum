import type { ClientBase } from "pg";

// Only a capable transaction may declare format 2 or 3. Never inherit that declaration
// from a URI, PGOPTIONS, role/database default or a reused backend session.
export async function assertVardDefinitionBaseline(
  client: Pick<ClientBase, "query">,
): Promise<void> {
  const { rows } = await client.query<{ safe: boolean }>(`
    SELECT current_setting('vardum.vard_definition_schema', true)
      IS DISTINCT FROM '2'
      AND current_setting('vardum.vard_definition_schema', true)
      IS DISTINCT FROM '3' AS safe
  `);
  if (rows.length !== 1 || rows[0]?.safe !== true) {
    throw new Error(
      "Unsafe Vard definition capability baseline: formats 2 and 3 must be transaction-local",
    );
  }
}
