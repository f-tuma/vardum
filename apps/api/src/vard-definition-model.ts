import { and, eq } from "drizzle-orm";
import type { FastifyReply } from "fastify";
import { z } from "zod";
import { vard } from "./db/app-schema.js";
import type { Transaction } from "./db/tenant.js";

export class VardDefinitionUpgradeError extends Error {
  constructor() {
    super("This Vard uses live library bindings; use a schema 2 editor.");
  }
}

/** Call within the operation's snapshot or after its workspace content guard. */
export async function assertVardDefinitionProtocol(
  tx: Transaction,
  workspaceId: string,
  vardId: string,
  protocol: 1 | 2,
) {
  const [record] = await tx.select({ definitionSchema: vard.definitionSchema })
    .from(vard).where(and(eq(vard.workspaceId, workspaceId), eq(vard.id, vardId)));
  if (record && record.definitionSchema >= 2 && protocol !== 2)
    throw new VardDefinitionUpgradeError();
  return record?.definitionSchema ?? null;
}

export function vardDefinitionUpgradeFailure(reply: FastifyReply) {
  return reply.code(409).send({
    code: "vard_definition_upgrade_required",
    error: "This Vard uses live library bindings; use a schema 2 editor.",
    requiredDefinitionSchema: 2,
  });
}

const reserved = ["definitionSchema", "storedDefinitionSchema", "binding", "assetUseId", "returnToSourceOnly"];
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Keep old unknown-field compatibility, but never strip new binding intent. */
export function legacyVardInput<T extends z.ZodType>(schema: T) {
  return z.preprocess((raw, context) => {
    if (!object(raw)) return raw;
    const rows = Array.isArray(raw.items) ? raw.items : [];
    if (reserved.some((key) => key in raw) || rows.some((row) =>
      object(row) && reserved.some((key) => key in row))) {
      context.addIssue({ code: "custom", message: "Live library bindings require the schema 2 editor" });
      return z.NEVER;
    }
    return raw;
  }, schema);
}
