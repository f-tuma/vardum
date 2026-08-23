import { sql } from "drizzle-orm";
import { db } from "./index.js";

export type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export function inWorkspace<T>(
  workspaceId: string,
  operation: (transaction: Transaction) => Promise<T>,
) {
  return db.transaction(async (transaction) => {
    await transaction.execute(
      sql`select set_config('app.workspace_id', ${workspaceId}, true)`,
    );
    return operation(transaction);
  });
}
