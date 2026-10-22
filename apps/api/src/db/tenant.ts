import { sql } from "drizzle-orm";
import { db } from "./index.js";

export type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

function inDefinitionTransaction<T>(
  workspaceId: string | undefined,
  operation: (transaction: Transaction) => Promise<T>,
  snapshot: boolean,
) {
  return db.transaction(async (transaction) => {
    // This declaration belongs to the same checked-out connection and ends on
    // both COMMIT and ROLLBACK. Physical sessions retain effective baseline 1.
    await transaction.execute(
      sql`select set_config('vardum.vard_definition_schema', '2', true)`,
    );
    if (workspaceId !== undefined) await transaction.execute(
      sql`select set_config('app.workspace_id', ${workspaceId}, true)`,
    );
    return operation(transaction);
  }, snapshot ? { isolationLevel: "repeatable read", accessMode: "read only" } : undefined);
}

export function inWorkspace<T>(
  workspaceId: string,
  operation: (transaction: Transaction) => Promise<T>,
) {
  return inDefinitionTransaction(workspaceId, operation, false);
}

/** A complete capture uses one snapshot, beginning before either setup SELECT. */
export function inWorkspaceSnapshot<T>(
  workspaceId: string,
  operation: (transaction: Transaction) => Promise<T>,
) {
  return inDefinitionTransaction(workspaceId, operation, true);
}

/** Public discovery has capability but no tenant grant or network work. */
export function inVardDefinitionRead<T>(
  operation: (transaction: Transaction) => Promise<T>,
) {
  return inDefinitionTransaction(undefined, operation, true);
}
