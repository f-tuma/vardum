import { randomUUID } from "node:crypto";
import { defaultKeyHasher } from "@better-auth/api-key";
import { generateRandomString } from "better-auth/crypto";
import { and, asc, count, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { authorizeWorkspaceAdmin } from "./authorization.js";
import { auditEvent } from "./db/app-schema.js";
import { apikey, member, organization, user } from "./db/auth-schema.js";
import { inWorkspace } from "./db/tenant.js";

const workspaceParams = z.object({ workspaceId: z.string().min(1) });
const updateWorkspaceBody = z.object({
  name: z.string().trim().min(1).max(80),
});
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
          .where(eq(member.organizationId, workspaceId))
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
          .select({ id: member.id, userId: member.userId, role: member.role })
          .from(member)
          .where(
            and(
              eq(member.id, memberId),
              eq(member.organizationId, workspaceId),
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
                eq(member.organizationId, workspaceId),
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
        return reply.code(409).send({ error: "Workspace needs an owner" });
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
            id: organization.id,
            name: organization.name,
            slug: organization.slug,
          })
          .from(organization)
          .where(eq(organization.id, workspaceId));
        if (!current || current.name === request.body.name) return current;

        const [workspace] = await transaction
          .update(organization)
          .set({ name: request.body.name })
          .where(eq(organization.id, workspaceId))
          .returning({
            id: organization.id,
            name: organization.name,
            slug: organization.slug,
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
}
