import { randomUUID } from "node:crypto";
import { defaultKeyHasher } from "@better-auth/api-key";
import { generateRandomString } from "better-auth/crypto";
import { and, asc, count, desc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { fromDrizzle } from "pg-boss";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { authorizeAsset, authorizeWorkspaceAdmin } from "./authorization.js";
import {
  assetVersion,
  auditEvent,
  workspace as workspaceTable,
} from "./db/app-schema.js";
import { apikey, member, user } from "./db/auth-schema.js";
import { inWorkspace } from "./db/tenant.js";
import { assetDeleteQueue, boss } from "./queue.js";

const workspaceParams = z.object({ workspaceId: z.string().min(1) });
const updateWorkspaceBody = z.object({
  name: z.string().trim().min(1).max(80),
});
const deleteWorkspaceBody = z.object({
  confirmation: z.string().min(1).max(128),
});
const workspaceCleanupDelay = 20 * 60 * 1000;
const memberParams = workspaceParams.extend({ memberId: z.string().min(1) });
const updateMemberBody = z.object({
  role: z.enum(["owner", "editor", "viewer"]),
});
const apiKeyParams = workspaceParams.extend({ keyId: z.string().min(1) });
const createApiKeyBody = z.object({
  name: z.string().trim().min(1).max(32),
  access: z.enum(["read", "write"]),
});
const assetPermissions = {
  read: { asset: ["read"] },
  write: { asset: ["read", "create", "update", "delete", "publish"] },
} as const;
const createCliKeyBody = z.object({
  // Named after the machine, so a stale key is recognisable in the key list.
  label: z
    .string()
    .trim()
    .min(1)
    .max(24)
    .regex(/^[a-zA-Z0-9._-]+$/),
  access: z.enum(["read", "write"]),
});

export function registerWorkspaceRoutes(app: FastifyInstance) {
  const api = app.withTypeProvider<ZodTypeProvider>();

  api.get(
    "/api/workspaces/:workspaceId/members",
    { schema: { params: workspaceParams } },
    async (request, reply) => {
      const { workspaceId } = request.params;
      const authorization = await authorizeWorkspaceAdmin(request, workspaceId);
      if (!("principal" in authorization)) {
        return reply
          .code(authorization.statusCode)
          .send({ error: authorization.error });
      }

      const members = await inWorkspace(workspaceId, (transaction) =>
        transaction
          .select({
            id: member.id,
            userId: member.userId,
            role: member.role,
            createdAt: member.createdAt,
            name: user.name,
            email: user.email,
          })
          .from(member)
          .innerJoin(user, eq(user.id, member.userId))
          .where(
            eq(member.organizationId, authorization.principal.organizationId),
          )
          .orderBy(asc(member.createdAt)),
      );
      return { members };
    },
  );

  api.patch(
    "/api/workspaces/:workspaceId/members/:memberId",
    {
      schema: {
        params: memberParams,
        body: updateMemberBody,
      },
    },
    async (request, reply) => {
      const { workspaceId, memberId } = request.params;
      const authorization = await authorizeWorkspaceAdmin(request, workspaceId);
      if (!("principal" in authorization)) {
        return reply
          .code(authorization.statusCode)
          .send({ error: authorization.error });
      }

      const result = await inWorkspace(workspaceId, async (transaction) => {
        const [current] = await transaction
          .select({
            id: member.id,
            userId: member.userId,
            role: member.role,
            name: user.name,
            email: user.email,
          })
          .from(member)
          .innerJoin(user, eq(user.id, member.userId))
          .where(
            and(
              eq(member.id, memberId),
              eq(member.organizationId, authorization.principal.organizationId),
            ),
          );
        if (!current) return { status: "missing" as const };
        if (current.role === request.body.role)
          return { status: "updated" as const, member: current };

        if (current.role === "owner" && request.body.role !== "owner") {
          const [owners] = await transaction
            .select({ count: count() })
            .from(member)
            .where(
              and(
                eq(
                  member.organizationId,
                  authorization.principal.organizationId,
                ),
                eq(member.role, "owner"),
              ),
            );
          if ((owners?.count ?? 0) <= 1)
            return { status: "last-owner" as const };
        }

        const [updated] = await transaction
          .update(member)
          .set({ role: request.body.role })
          .where(eq(member.id, memberId))
          .returning({
            id: member.id,
            userId: member.userId,
            role: member.role,
          });
        if (!updated) return { status: "missing" as const };

        await transaction.insert(auditEvent).values({
          workspaceId,
          actorType: authorization.principal.actorType,
          actorId: authorization.principal.actorId,
          action: "workspace.member_role_updated",
          targetType: "member",
          targetId: updated.id,
          metadata: {
            userId: updated.userId,
            name: current.name,
            email: current.email,
            previousRole: current.role,
            role: updated.role,
          },
          requestId: request.id,
        });
        return { status: "updated" as const, member: updated };
      });

      if (result.status === "missing")
        return reply.code(404).send({ error: "Member not found" });
      if (result.status === "last-owner")
        return reply.code(409).send({ error: "Organization needs an owner" });
      return result.member;
    },
  );

  api.get(
    "/api/workspaces/:workspaceId/api-keys",
    { schema: { params: workspaceParams } },
    async (request, reply) => {
      const { workspaceId } = request.params;
      const authorization = await authorizeWorkspaceAdmin(request, workspaceId);
      if (!("principal" in authorization)) {
        return reply
          .code(authorization.statusCode)
          .send({ error: authorization.error });
      }

      const keys = await inWorkspace(workspaceId, (transaction) =>
        transaction
          .select({
            id: apikey.id,
            name: apikey.name,
            start: apikey.start,
            enabled: apikey.enabled,
            permissions: apikey.permissions,
            createdAt: apikey.createdAt,
            lastRequest: apikey.lastRequest,
          })
          .from(apikey)
          .where(
            and(
              eq(apikey.configId, "workspace"),
              eq(apikey.referenceId, workspaceId),
            ),
          )
          .orderBy(desc(apikey.createdAt)),
      );
      return {
        keys: keys.map(({ permissions, ...key }) => ({
          ...key,
          access: permissions?.includes('"create"') ? "write" : "read",
        })),
      };
    },
  );

  api.post(
    "/api/workspaces/:workspaceId/api-keys",
    {
      schema: {
        params: workspaceParams,
        body: createApiKeyBody,
      },
    },
    async (request, reply) => {
      const { workspaceId } = request.params;
      const authorization = await authorizeWorkspaceAdmin(request, workspaceId);
      if (!("principal" in authorization)) {
        return reply
          .code(authorization.statusCode)
          .send({ error: authorization.error });
      }

      const key = `varda_${generateRandomString(64, "a-z", "A-Z")}`;
      const id = randomUUID();
      const now = new Date();
      const created = await inWorkspace(workspaceId, async (transaction) => {
        const [record] = await transaction
          .insert(apikey)
          .values({
            id,
            configId: "workspace",
            name: request.body.name,
            start: key.slice(0, 6),
            prefix: "varda_",
            key: await defaultKeyHasher(key),
            referenceId: workspaceId,
            createdAt: now,
            updatedAt: now,
            permissions: JSON.stringify(assetPermissions[request.body.access]),
          })
          .returning({
            id: apikey.id,
            name: apikey.name,
            start: apikey.start,
            enabled: apikey.enabled,
            createdAt: apikey.createdAt,
          });
        if (!record) throw new Error("API key creation failed");

        await transaction.insert(auditEvent).values({
          workspaceId,
          actorType: authorization.principal.actorType,
          actorId: authorization.principal.actorId,
          action: "workspace.api_key_created",
          targetType: "api_key",
          targetId: record.id,
          metadata: { name: record.name, access: request.body.access },
          requestId: request.id,
        });
        return record;
      });

      return { ...created, key, access: request.body.access };
    },
  );

  // What `vardum login` calls once the browser has confirmed it. Separate from
  // the admin endpoint above because this mints a key for yourself: it is
  // authorized by the very permissions the key will carry, so it can never hand
  // out more access than the person asking already has.
  api.post(
    "/api/workspaces/:workspaceId/cli-keys",
    { schema: { params: workspaceParams, body: createCliKeyBody } },
    async (request, reply) => {
      const { workspaceId } = request.params;
      const { label, access } = request.body;
      const authorization = await authorizeAsset(
        request,
        workspaceId,
        [...assetPermissions[access].asset],
      );
      if (!("principal" in authorization)) {
        return reply
          .code(authorization.statusCode)
          .send({ error: authorization.error });
      }
      // A key must not be able to mint another key; only a signed-in person can.
      if (authorization.principal.actorType !== "user")
        return reply.code(403).send({ error: "Forbidden" });

      const key = `varda_${generateRandomString(64, "a-z", "A-Z")}`;
      const id = randomUUID();
      const now = new Date();
      const name = `cli@${label}`.slice(0, 32);
      const created = await inWorkspace(workspaceId, async (transaction) => {
        const [record] = await transaction
          .insert(apikey)
          .values({
            id,
            configId: "workspace",
            name,
            start: key.slice(0, 6),
            prefix: "varda_",
            key: await defaultKeyHasher(key),
            referenceId: workspaceId,
            createdAt: now,
            updatedAt: now,
            permissions: JSON.stringify(assetPermissions[access]),
          })
          .returning({ id: apikey.id, name: apikey.name });
        if (!record) throw new Error("API key creation failed");

        await transaction.insert(auditEvent).values({
          workspaceId,
          actorType: authorization.principal.actorType,
          actorId: authorization.principal.actorId,
          action: "workspace.api_key_created",
          targetType: "api_key",
          targetId: record.id,
          metadata: { name: record.name, access, source: "cli" },
          requestId: request.id,
        });
        return record;
      });

      return { id: created.id, name: created.name, key, access };
    },
  );

  // Revoking the key this CLI holds, without needing workspace administration.
  api.delete(
    "/api/workspaces/:workspaceId/cli-keys",
    { schema: { params: workspaceParams } },
    async (request, reply) => {
      const { workspaceId } = request.params;
      const authorization = await authorizeAsset(request, workspaceId, [
        "read",
      ]);
      if (!("principal" in authorization)) {
        return reply
          .code(authorization.statusCode)
          .send({ error: authorization.error });
      }
      // Only the key presenting itself may be revoked this way.
      if (authorization.principal.actorType !== "api_key")
        return reply.code(403).send({ error: "Forbidden" });

      const keyId = authorization.principal.actorId;
      await inWorkspace(workspaceId, async (transaction) => {
        await transaction.delete(apikey).where(eq(apikey.id, keyId));
        await transaction.insert(auditEvent).values({
          workspaceId,
          actorType: "api_key",
          actorId: keyId,
          action: "workspace.api_key_deleted",
          targetType: "api_key",
          targetId: keyId,
          metadata: { source: "cli" },
          requestId: request.id,
        });
      });
      return reply.code(204).send();
    },
  );

  api.delete(
    "/api/workspaces/:workspaceId/api-keys/:keyId",
    { schema: { params: apiKeyParams } },
    async (request, reply) => {
      const { workspaceId, keyId } = request.params;
      const authorization = await authorizeWorkspaceAdmin(request, workspaceId);
      if (!("principal" in authorization)) {
        return reply
          .code(authorization.statusCode)
          .send({ error: authorization.error });
      }

      const deleted = await inWorkspace(workspaceId, async (transaction) => {
        const [record] = await transaction
          .delete(apikey)
          .where(
            and(
              eq(apikey.id, keyId),
              eq(apikey.configId, "workspace"),
              eq(apikey.referenceId, workspaceId),
            ),
          )
          .returning({ id: apikey.id, name: apikey.name });
        if (!record) return null;

        await transaction.insert(auditEvent).values({
          workspaceId,
          actorType: authorization.principal.actorType,
          actorId: authorization.principal.actorId,
          action: "workspace.api_key_deleted",
          targetType: "api_key",
          targetId: record.id,
          metadata: { name: record.name },
          requestId: request.id,
        });
        return record;
      });

      return deleted
        ? reply.code(204).send()
        : reply.code(404).send({ error: "API key not found" });
    },
  );

  api.patch(
    "/api/workspaces/:workspaceId",
    {
      schema: {
        params: workspaceParams,
        body: updateWorkspaceBody,
      },
    },
    async (request, reply) => {
      const { workspaceId } = request.params;
      const authorization = await authorizeWorkspaceAdmin(request, workspaceId);
      if (!("principal" in authorization)) {
        return reply
          .code(authorization.statusCode)
          .send({ error: authorization.error });
      }

      const updated = await inWorkspace(workspaceId, async (transaction) => {
        const [current] = await transaction
          .select({
            id: workspaceTable.id,
            name: workspaceTable.name,
            slug: workspaceTable.slug,
          })
          .from(workspaceTable)
          .where(eq(workspaceTable.id, workspaceId));
        if (!current || current.name === request.body.name) return current;

        const [workspace] = await transaction
          .update(workspaceTable)
          .set({
            name: request.body.name,
            updatedBy: authorization.principal.reference,
          })
          .where(eq(workspaceTable.id, workspaceId))
          .returning({
            id: workspaceTable.id,
            name: workspaceTable.name,
            slug: workspaceTable.slug,
          });
        if (!workspace) return null;

        await transaction.insert(auditEvent).values({
          workspaceId,
          actorType: authorization.principal.actorType,
          actorId: authorization.principal.actorId,
          action: "workspace.updated",
          targetType: "workspace",
          targetId: workspaceId,
          metadata: { previousName: current.name, name: workspace.name },
          requestId: request.id,
        });
        return workspace;
      });

      return updated ?? reply.code(404).send({ error: "Workspace not found" });
    },
  );

  api.delete(
    "/api/workspaces/:workspaceId",
    { schema: { params: workspaceParams, body: deleteWorkspaceBody } },
    async (request, reply) => {
      const { workspaceId } = request.params;
      const authorization = await authorizeWorkspaceAdmin(request, workspaceId);
      if (!("principal" in authorization)) {
        return reply
          .code(authorization.statusCode)
          .send({ error: authorization.error });
      }

      const deleted = await inWorkspace(workspaceId, async (transaction) => {
        const [workspace] = await transaction
          .select({
            id: workspaceTable.id,
            name: workspaceTable.name,
            slug: workspaceTable.slug,
          })
          .from(workspaceTable)
          .where(eq(workspaceTable.id, workspaceId))
          .for("update");
        if (!workspace) return { status: "missing" as const };
        if (request.body.confirmation !== workspace.slug)
          return { status: "confirmation" as const };

        const versions = await transaction
          .select({
            assetId: assetVersion.assetId,
            versionId: assetVersion.id,
            storageKey: assetVersion.storageKey,
          })
          .from(assetVersion)
          .where(eq(assetVersion.workspaceId, workspaceId));
        const byAsset = new Map<
          string,
          { versionIds: string[]; storageKeys: string[] }
        >();
        for (const version of versions) {
          const payload = byAsset.get(version.assetId) ?? {
            versionIds: [],
            storageKeys: [],
          };
          payload.versionIds.push(version.versionId);
          payload.storageKeys.push(version.storageKey);
          byAsset.set(version.assetId, payload);
        }
        for (const [assetId, payload] of byAsset) {
          await boss.send(assetDeleteQueue, payload, {
            db: fromDrizzle(transaction, sql),
            singletonKey: `workspace-delete:${workspaceId}:${assetId}`,
          });
        }
        await boss.send(
          assetDeleteQueue,
          {
            versionIds: [],
            storageKeys: [],
            prefixes: [`originals/${workspaceId}/`],
          },
          {
            db: fromDrizzle(transaction, sql),
            singletonKey: `workspace-delete:${workspaceId}:origin-sweep`,
            startAfter: new Date(Date.now() + workspaceCleanupDelay),
          },
        );

        await transaction
          .delete(apikey)
          .where(
            and(
              eq(apikey.configId, "workspace"),
              eq(apikey.referenceId, workspaceId),
            ),
          );
        await transaction
          .delete(workspaceTable)
          .where(eq(workspaceTable.id, workspaceId));
        return {
          status: "deleted" as const,
          workspace,
          versionCount: versions.length,
        };
      });

      if (deleted.status === "missing")
        return reply.code(404).send({ error: "Workspace not found" });
      if (deleted.status === "confirmation")
        return reply.code(400).send({ error: "Workspace slug does not match" });
      request.log.info(
        {
          workspaceId,
          workspaceSlug: deleted.workspace.slug,
          actorId: authorization.principal.actorId,
          versionCount: deleted.versionCount,
        },
        "workspace deleted",
      );
      return reply.code(204).send();
    },
  );
}
