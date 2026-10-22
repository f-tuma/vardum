import { and, asc, count, desc, eq, gt, inArray, or, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { authorizeAsset } from "./authorization.js";
import {
  asset,
  assetVersion,
  auditEvent,
  knownUsage,
  knownUsageCheck,
} from "./db/app-schema.js";
import { lockWorkspaceContent } from "./db/content-guard.js";
import { inWorkspace, inWorkspaceSnapshot, type Transaction } from "./db/tenant.js";
import {
  bindingStatus,
  checkSchema,
  consumerSchema,
  MAX_CHECKS_PER_BINDING,
  MAX_CHECKS_PER_CONSUMER,
  MAX_KNOWN_CONSUMERS,
  knownUsagePage,
  replaceConsumerSchema,
  revisionSchema,
  scopeToken,
  usageUuid,
  type BindingInput,
  type Destination,
  type EvidenceScope,
  type Source,
  type StoredBinding,
  type Target,
} from "./known-usage-model.js";
import { canonicalizeTransformation } from "./transformation.js";
import { VardResolutionError } from "./vard-folder-rules.js";
import { buildVardPayloadInTransaction } from "./vard-payload.js";

const workspaceParams = z.object({ workspaceId: z.string().min(1) });
const consumerParams = workspaceParams.extend({ consumerId: usageUuid });
const bindingParams = consumerParams.extend({ bindingId: usageUuid });
const pageQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    after: usageUuid.optional(),
  })
  .strict();
type ConsumerRow = typeof knownUsage.$inferSelect;
type Resolved = {
  exists: boolean;
  label: string | null;
  reason: string | null;
  source: Source | null;
  outputConfiguration: string;
  transformation: string;
};
class UsageError extends Error {
  constructor(
    readonly statusCode: 404 | 409,
    message: string,
  ) {
    super(message);
  }
}
async function checked<T>(reply: FastifyReply, operation: () => Promise<T>) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof UsageError)
      return reply.code(error.statusCode).send({ error: error.message });
    throw error;
  }
}
function sameTarget(a: Target, b: Target) {
  return (
    a.kind === b.kind &&
    a.assetId === b.assetId &&
    (a.kind !== "vard_output" ||
      (b.kind === "vard_output" &&
        a.vardId === b.vardId &&
        a.outputPath === b.outputPath))
  );
}
function evidenceView(row: typeof knownUsageCheck.$inferSelect) {
  return {
    id: row.id,
    bindingId: row.bindingId,
    checkedAt: row.checkedAt,
    recordedAt: row.recordedAt,
    actor: row.actor,
    source: row.source,
    scope: row.scope,
    commitRef: row.commitRef,
    releaseRef: row.releaseRef,
    note: row.note,
  };
}

// Batch assets and versions; each distinct Vard resolves at most once per request.
// Resolution reads declared Vard definitions, including generated folder outputs;
// it does not contact any registered destination or claim a deployment occurred.
async function targetResolver(
  tx: Transaction,
  workspaceId: string,
  bindings: BindingInput[],
) {
  const assetIds = [
    ...new Set(bindings.map((binding) => binding.target.assetId)),
  ];
  const assets = assetIds.length
    ? await tx
        .select()
        .from(asset)
        .where(
          and(eq(asset.workspaceId, workspaceId), inArray(asset.id, assetIds)),
        )
    : [];
  const assetById = new Map(assets.map((row) => [row.id, row]));
  const vards = new Map<
    string,
    | Awaited<ReturnType<typeof buildVardPayloadInTransaction>>
    | VardResolutionError
  >();
  const requestedTargets = new Map<
    string,
    Map<string, { assetId: string; outputPath: string }>
  >();
  for (const binding of bindings)
    if (binding.target.kind === "vard_output") {
      const targets = requestedTargets.get(binding.target.vardId) ?? new Map();
      const target = {
        assetId: binding.target.assetId,
        outputPath: binding.target.outputPath,
      };
      targets.set(JSON.stringify([target.assetId, target.outputPath]), target);
      requestedTargets.set(binding.target.vardId, targets);
    }
  for (const [vardId, targets] of requestedTargets) {
    try {
      const payload = await buildVardPayloadInTransaction(
        tx,
        workspaceId,
        vardId,
        {
          includePinnedVersionId: true,
          includeBindingIdentity: true,
          selectedTargets: [...targets.values()],
        },
      );
      // The helper validates the full namespace, then hydrates only selected
      // targets. Pages additionally cap distinct Vards to avoid unbounded
      // serial resolution across otherwise legal consumer rows.
      vards.set(vardId, payload);
    } catch (error) {
      if (!(error instanceof VardResolutionError)) throw error;
      vards.set(vardId, error);
    }
  }
  const versionIds = new Set(
    assets.flatMap((row) =>
      row.currentVersionId ? [row.currentVersionId] : [],
    ),
  );
  for (const payload of vards.values())
    if (payload && !(payload instanceof VardResolutionError))
      for (const item of payload.items)
        if (item.versionId) versionIds.add(item.versionId);
  const versions = versionIds.size
    ? await tx
        .select()
        .from(assetVersion)
        .where(
          and(
            eq(assetVersion.workspaceId, workspaceId),
            inArray(assetVersion.id, [...versionIds]),
          ),
        )
    : [];
  const versionById = new Map(versions.map((row) => [row.id, row]));
  return (target: Target): Resolved => {
    const sourceAsset = assetById.get(target.assetId);
    const missing = (reason: string): Resolved => ({
      exists: false,
      label: null,
      reason,
      source: null,
      outputConfiguration: "unresolved",
      transformation: "",
    });
    if (!sourceAsset) return missing("asset_missing");
    let versionId = sourceAsset.currentVersionId;
    let transformation = "";
    let outputConfiguration = "asset_latest";
    let label = sourceAsset.displayName;
    if (target.kind === "vard_output") {
      const payload = vards.get(target.vardId);
      if (payload instanceof VardResolutionError)
        return missing("vard_outputs_invalid");
      if (!payload) return missing("vard_missing");
      const item = payload.items.find(
        (candidate) => candidate.outputPath === target.outputPath,
      );
      if (!item) return missing("output_missing");
      if (item.assetId !== target.assetId) return missing("output_rebound");
      transformation = canonicalizeTransformation(item.transformation ?? {});
      outputConfiguration = item.bindingIdentity?.kind === "use"
        ? JSON.stringify(["use", item.bindingIdentity.assetUseId, transformation])
        : JSON.stringify([item.pinnedVersionId ?? null, transformation]);
      versionId = item.versionId;
      label = `${payload.name} / ${target.outputPath} (${sourceAsset.displayName})`;
    }
    const version = versionId ? versionById.get(versionId) : undefined;
    const ready =
      version?.status === "ready" && version.assetId === target.assetId;
    return {
      exists: true,
      label,
      reason: ready ? null : "source_unavailable",
      outputConfiguration,
      transformation,
      source: ready
        ? {
            assetId: target.assetId,
            versionId: version.id,
            number: version.number,
            checksum: version.checksum,
            fingerprint: `${version.id}:${transformation}`,
          }
        : null,
    };
  };
}
function checkedScope(
  binding: StoredBinding,
  destination: Destination,
  resolved: Resolved,
): EvidenceScope {
  return {
    destination,
    target: binding.target,
    mode: binding.mode,
    targetLabel: binding.targetLabel,
    outputConfiguration: resolved.outputConfiguration,
  };
}
async function viewConsumers(
  tx: Transaction,
  workspaceId: string,
  rows: ConsumerRow[],
  resolvedTargets?: Awaited<ReturnType<typeof targetResolver>>,
) {
  const resolve =
    resolvedTargets ??
    (await targetResolver(
      tx,
      workspaceId,
      rows.flatMap((row) => row.bindings),
    ));
  const scopes = rows
    .filter((row) => row.bindings.length)
    .map((row) =>
      and(
        eq(knownUsageCheck.consumerId, row.id),
        inArray(
          knownUsageCheck.bindingId,
          row.bindings.map((binding) => binding.id),
        ),
      ),
    );
  const checks = scopes.length
    ? await tx
        .selectDistinctOn([
          knownUsageCheck.consumerId,
          knownUsageCheck.bindingId,
        ])
        .from(knownUsageCheck)
        .where(and(eq(knownUsageCheck.workspaceId, workspaceId), or(...scopes)))
        .orderBy(
          knownUsageCheck.consumerId,
          knownUsageCheck.bindingId,
          desc(knownUsageCheck.recordedAt),
          desc(knownUsageCheck.id),
        )
    : [];
  const byBinding = new Map(
    checks.map((row) => [
      `${row.consumerId}:${row.bindingId}`,
      evidenceView(row),
    ]),
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    kind: row.kind,
    destinations: row.destinations,
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    bindings: row.bindings.map((binding) => {
      const resolved = resolve(binding.target);
      const destination = row.destinations.find(
        (item) => item.id === binding.destinationId,
      )!;
      const current = {
        resolved: resolved.exists && Boolean(resolved.source),
        reason: resolved.reason,
        source: resolved.source,
        scopeToken: scopeToken(checkedScope(binding, destination, resolved)),
      };
      const latestEvidence = byBinding.get(`${row.id}:${binding.id}`) ?? null;
      return {
        ...binding,
        current,
        latestEvidence,
        status: bindingStatus(current, latestEvidence),
      };
    }),
  }));
}
async function currentConsumer(
  tx: Transaction,
  workspaceId: string,
  consumerId: string,
  expectedRevision?: number,
) {
  const [row] = await tx
    .select()
    .from(knownUsage)
    .where(
      and(
        eq(knownUsage.workspaceId, workspaceId),
        eq(knownUsage.id, consumerId),
      ),
    )
    .for("update");
  if (!row) throw new UsageError(404, "Consumer not found");
  if (expectedRevision !== undefined && row.revision !== expectedRevision)
    throw new UsageError(409, "Consumer changed; reload before saving");
  return row;
}
async function validateBindings(
  tx: Transaction,
  workspaceId: string,
  inputs: BindingInput[],
  previous: StoredBinding[] = [],
) {
  const resolve = await targetResolver(tx, workspaceId, inputs);
  const bindings = inputs.map((binding): StoredBinding => {
    const old = previous.find((candidate) => candidate.id === binding.id);
    if (old && sameTarget(old.target, binding.target))
      return { ...binding, targetLabel: old.targetLabel };
    const resolved = resolve(binding.target);
    if (!resolved.exists)
      throw new UsageError(404, "Binding source not found in this workspace");
    return { ...binding, targetLabel: resolved.label! };
  });
  return { bindings, resolve };
}
async function audit(
  tx: Transaction,
  workspaceId: string,
  consumerId: string,
  action: string,
  actor: { actorType: "user" | "api_key"; actorId: string },
  requestId: string,
) {
  await tx.insert(auditEvent).values({
    workspaceId,
    actorType: actor.actorType,
    actorId: actor.actorId,
    action,
    targetType: "known_usage",
    targetId: consumerId,
    requestId,
  });
}

export function registerKnownUsageRoutes(app: FastifyInstance) {
  const api = app.withTypeProvider<ZodTypeProvider>();
  api.get(
    "/api/workspaces/:workspaceId/known-usages",
    { schema: { params: workspaceParams, querystring: pageQuery } },
    async (request, reply) => {
      const { workspaceId } = request.params;
      const auth = await authorizeAsset(request, workspaceId, ["read"]);
      if (!("principal" in auth))
        return reply.code(auth.statusCode).send({ error: auth.error });
      return inWorkspaceSnapshot(workspaceId, async (tx) => {
        const rows = await tx
          .select()
          .from(knownUsage)
          .where(
            and(
              eq(knownUsage.workspaceId, workspaceId),
              request.query.after
                ? gt(knownUsage.id, request.query.after)
                : undefined,
            ),
          )
          .orderBy(asc(knownUsage.id))
          .limit(request.query.limit + 1);
        const page = knownUsagePage(rows, request.query.limit);
        return {
          consumers: await viewConsumers(tx, workspaceId, page.consumers),
          nextCursor: page.hasMore ? page.consumers.at(-1)!.id : null,
        };
      });
    },
  );
  api.get(
    "/api/workspaces/:workspaceId/known-usages/:consumerId",
    { schema: { params: consumerParams } },
    async (request, reply) => {
      const { workspaceId, consumerId } = request.params;
      const auth = await authorizeAsset(request, workspaceId, ["read"]);
      if (!("principal" in auth))
        return reply.code(auth.statusCode).send({ error: auth.error });
      return checked(reply, () =>
        inWorkspaceSnapshot(workspaceId, async (tx) => {
          const rows = await tx
            .select()
            .from(knownUsage)
            .where(
              and(
                eq(knownUsage.workspaceId, workspaceId),
                eq(knownUsage.id, consumerId),
              ),
            );
          if (!rows.length) throw new UsageError(404, "Consumer not found");
          return (await viewConsumers(tx, workspaceId, rows))[0]!;
        }),
      );
    },
  );
  api.post(
    "/api/workspaces/:workspaceId/known-usages",
    { schema: { params: workspaceParams, body: consumerSchema } },
    async (request, reply) => {
      const { workspaceId } = request.params;
      const auth = await authorizeAsset(request, workspaceId, ["create"]);
      if (!("principal" in auth))
        return reply.code(auth.statusCode).send({ error: auth.error });
      return checked(reply, async () => {
        const result = await inWorkspace(workspaceId, async (tx) => {
          await lockWorkspaceContent(tx, workspaceId);
          const [total] = await tx
            .select({ count: count() })
            .from(knownUsage)
            .where(eq(knownUsage.workspaceId, workspaceId));
          if (total!.count >= MAX_KNOWN_CONSUMERS)
            throw new UsageError(409, "Workspace consumer limit reached");
          const { bindings, resolve } = await validateBindings(
            tx,
            workspaceId,
            request.body.bindings,
          );
          const [row] = await tx
            .insert(knownUsage)
            .values({
              workspaceId,
              ...request.body,
              bindings,
              createdBy: auth.principal.reference,
              updatedBy: auth.principal.reference,
            })
            .returning();
          await audit(
            tx,
            workspaceId,
            row!.id,
            "known_usage.created",
            auth.principal,
            request.id,
          );
          return (await viewConsumers(tx, workspaceId, [row!], resolve))[0]!;
        });
        return reply.code(201).send(result);
      });
    },
  );
  api.put(
    "/api/workspaces/:workspaceId/known-usages/:consumerId",
    { schema: { params: consumerParams, body: replaceConsumerSchema } },
    async (request, reply) => {
      const { workspaceId, consumerId } = request.params;
      const auth = await authorizeAsset(request, workspaceId, ["update"]);
      if (!("principal" in auth))
        return reply.code(auth.statusCode).send({ error: auth.error });
      return checked(reply, () =>
        inWorkspace(workspaceId, async (tx) => {
          await lockWorkspaceContent(tx, workspaceId);
          const row = await currentConsumer(
            tx,
            workspaceId,
            consumerId,
            request.body.expectedRevision,
          );
          const { expectedRevision, ...input } = request.body;
          const { bindings, resolve } = await validateBindings(
            tx,
            workspaceId,
            input.bindings,
            row.bindings,
          );
          const [updated] = await tx
            .update(knownUsage)
            .set({
              ...input,
              bindings,
              revision: expectedRevision + 1,
              updatedBy: auth.principal.reference,
            })
            .where(eq(knownUsage.id, consumerId))
            .returning();
          await audit(
            tx,
            workspaceId,
            consumerId,
            "known_usage.updated",
            auth.principal,
            request.id,
          );
          return (
            await viewConsumers(tx, workspaceId, [updated!], resolve)
          )[0]!;
        }),
      );
    },
  );
  api.delete(
    "/api/workspaces/:workspaceId/known-usages/:consumerId",
    {
      schema: {
        params: consumerParams,
        body: z.object({ expectedRevision: revisionSchema }).strict(),
      },
    },
    async (request, reply) => {
      const { workspaceId, consumerId } = request.params;
      const auth = await authorizeAsset(request, workspaceId, ["delete"]);
      if (!("principal" in auth))
        return reply.code(auth.statusCode).send({ error: auth.error });
      return checked(reply, async () => {
        await inWorkspace(workspaceId, async (tx) => {
          await lockWorkspaceContent(tx, workspaceId);
          await currentConsumer(
            tx,
            workspaceId,
            consumerId,
            request.body.expectedRevision,
          );
          await tx.delete(knownUsage).where(eq(knownUsage.id, consumerId));
          await audit(
            tx,
            workspaceId,
            consumerId,
            "known_usage.deleted",
            auth.principal,
            request.id,
          );
        });
        return reply.code(204).send();
      });
    },
  );
  api.post(
    "/api/workspaces/:workspaceId/known-usages/:consumerId/bindings/:bindingId/checks",
    { schema: { params: bindingParams, body: checkSchema } },
    async (request, reply) => {
      const { workspaceId, consumerId, bindingId } = request.params;
      const auth = await authorizeAsset(request, workspaceId, ["update"]);
      if (!("principal" in auth))
        return reply.code(auth.statusCode).send({ error: auth.error });
      return checked(reply, () =>
        inWorkspace(workspaceId, async (tx) => {
          await lockWorkspaceContent(tx, workspaceId);
          const row = await currentConsumer(
            tx,
            workspaceId,
            consumerId,
            request.body.expectedRevision,
          );
          const binding = row.bindings.find((item) => item.id === bindingId);
          if (!binding) throw new UsageError(404, "Binding not found");
          // Resolve once for the whole response while the content guard keeps
          // source state stable through report insertion and serialization.
          const resolve = await targetResolver(tx, workspaceId, row.bindings);
          const resolved = resolve(binding.target);
          const scope = checkedScope(
            binding,
            row.destinations.find((item) => item.id === binding.destinationId)!,
            resolved,
          );
          if (scopeToken(scope) !== request.body.expectedScopeToken)
            throw new UsageError(
              409,
              "Binding scope changed; reload before reporting",
            );
          if (!resolved.exists || !resolved.source)
            throw new UsageError(409, "Binding source is unresolved");
          const [reported] = await tx
            .select()
            .from(assetVersion)
            .where(
              and(
                eq(assetVersion.workspaceId, workspaceId),
                eq(assetVersion.assetId, binding.target.assetId),
                eq(assetVersion.id, request.body.reportedVersionId),
                eq(assetVersion.status, "ready"),
              ),
            );
          if (!reported)
            throw new UsageError(
              404,
              "Reported source version not found in this workspace",
            );
          const [total] = await tx
            .select({
              count: count(),
              bindingCount: sql<number>`count(*) filter (where ${knownUsageCheck.bindingId} = ${bindingId})::int`,
            })
            .from(knownUsageCheck)
            .where(
              and(
                eq(knownUsageCheck.workspaceId, workspaceId),
                eq(knownUsageCheck.consumerId, consumerId),
              ),
            );
          if (
            total!.count >= MAX_CHECKS_PER_CONSUMER ||
            total!.bindingCount >= MAX_CHECKS_PER_BINDING
          )
            throw new UsageError(409, "Consumer manual report limit reached");
          await tx.insert(knownUsageCheck).values({
            workspaceId,
            consumerId,
            bindingId,
            checkedAt: new Date(request.body.checkedAt),
            actor: auth.principal.reference,
            scope,
            source: {
              assetId: reported.assetId,
              versionId: reported.id,
              number: reported.number,
              checksum: reported.checksum,
              fingerprint: `${reported.id}:${resolved.transformation}`,
            },
            commitRef: request.body.commitRef ?? null,
            releaseRef: request.body.releaseRef ?? null,
            note: request.body.note ?? null,
          });
          const [updated] = await tx
            .update(knownUsage)
            .set({
              revision: row.revision + 1,
              updatedBy: auth.principal.reference,
            })
            .where(eq(knownUsage.id, consumerId))
            .returning();
          await audit(
            tx,
            workspaceId,
            consumerId,
            "known_usage.check_reported",
            auth.principal,
            request.id,
          );
          return (
            await viewConsumers(tx, workspaceId, [updated!], resolve)
          )[0]!;
        }),
      );
    },
  );
  api.get(
    "/api/workspaces/:workspaceId/known-usages/:consumerId/bindings/:bindingId/checks",
    { schema: { params: bindingParams, querystring: pageQuery } },
    async (request, reply) => {
      const { workspaceId, consumerId, bindingId } = request.params;
      const auth = await authorizeAsset(request, workspaceId, ["read"]);
      if (!("principal" in auth))
        return reply.code(auth.statusCode).send({ error: auth.error });
      return checked(reply, () =>
        inWorkspace(workspaceId, async (tx) => {
          const [row] = await tx
            .select({ id: knownUsage.id, bindings: knownUsage.bindings })
            .from(knownUsage)
            .where(
              and(
                eq(knownUsage.workspaceId, workspaceId),
                eq(knownUsage.id, consumerId),
              ),
            );
          if (!row) throw new UsageError(404, "Consumer not found");
          if (request.query.after) {
            const [cursor] = await tx
              .select({ id: knownUsageCheck.id })
              .from(knownUsageCheck)
              .where(
                and(
                  eq(knownUsageCheck.workspaceId, workspaceId),
                  eq(knownUsageCheck.consumerId, consumerId),
                  eq(knownUsageCheck.bindingId, bindingId),
                  eq(knownUsageCheck.id, request.query.after),
                ),
              )
              .limit(1);
            if (!cursor) throw new UsageError(404, "Check cursor not found");
          }
          const rows = await tx
            .select()
            .from(knownUsageCheck)
            .where(
              and(
                eq(knownUsageCheck.workspaceId, workspaceId),
                eq(knownUsageCheck.consumerId, consumerId),
                eq(knownUsageCheck.bindingId, bindingId),
                request.query.after
                  ? // Resolve the boundary in PostgreSQL to retain microseconds.
                    sql`(${knownUsageCheck.recordedAt}, ${knownUsageCheck.id}) <
                    (SELECT recorded_at, id FROM known_usage_check
                      WHERE workspace_id = ${workspaceId}
                        AND consumer_id = ${consumerId}::uuid
                        AND binding_id = ${bindingId}::uuid
                        AND id = ${request.query.after}::uuid)`
                  : undefined,
              ),
            )
            .orderBy(desc(knownUsageCheck.recordedAt), desc(knownUsageCheck.id))
            .limit(request.query.limit + 1);
          if (
            !row.bindings.some((binding) => binding.id === bindingId) &&
            !rows.length
          ) {
            // Removed bindings remain readable while their immutable reports
            // exist. An unrelated UUID has no such retained declaration.
            const [retained] = await tx
              .select({ id: knownUsageCheck.id })
              .from(knownUsageCheck)
              .where(
                and(
                  eq(knownUsageCheck.workspaceId, workspaceId),
                  eq(knownUsageCheck.consumerId, consumerId),
                  eq(knownUsageCheck.bindingId, bindingId),
                ),
              )
              .limit(1);
            if (!retained) throw new UsageError(404, "Binding not found");
          }
          const page = rows.slice(0, request.query.limit);
          return {
            checks: page.map(evidenceView),
            nextCursor:
              rows.length > request.query.limit ? page.at(-1)!.id : null,
          };
        }),
      );
    },
  );
}
