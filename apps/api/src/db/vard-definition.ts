import type { ClientBase } from "pg";

// Only a capable transaction may declare format 2. Never inherit that declaration
// from a URI, PGOPTIONS, role/database default or a reused backend session.
export async function assertVardDefinitionBaseline(
  client: Pick<ClientBase, "query">,
): Promise<void> {
  const { rows } = await client.query<{ safe: boolean }>(`
    SELECT current_setting('vardum.vard_definition_schema', true)
      IS DISTINCT FROM '2' AS safe
  `);
  if (rows.length !== 1 || rows[0]?.safe !== true) {
    throw new Error(
      "Unsafe Vard definition capability baseline: format 2 must be transaction-local",
    );
  }
}
