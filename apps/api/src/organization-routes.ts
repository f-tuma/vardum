import { randomUUID } from "node:crypto";
import { fromNodeHeaders } from "better-auth/node";
import { asc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { auth } from "./auth.js";
import { auditEvent, workspace } from "./db/app-schema.js";
import { member, organization } from "./db/auth-schema.js";
import { db } from "./db/index.js";
import { canCreateOrganization } from "./organization-policy.js";

const organizationParams = z.object({ organizationId: z.string().min(1) });
const createWorkspaceBody = z.object({
  name: z.string().trim().min(1).max(80),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .min(2)
    .max(63)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
});

export function registerOrganizationRoutes(app: FastifyInstance) {
  const api = app.withTypeProvider<ZodTypeProvider>();

  api.get("/api/organizations", async (request, reply) => {
    const headers = fromNodeHeaders(request.headers);
    const session = await auth.api.getSession({ headers });
    if (!session) return reply.code(401).send({ error: "Unauthorized" });

    const rows = await db
      .select({
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
        role: member.role,
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        workspaceSlug: workspace.slug,
      })
      .from(member)
      .innerJoin(organization, eq(organization.id, member.organizationId))
      .leftJoin(workspace, eq(workspace.organizationId, organization.id))
      .where(eq(member.userId, session.user.id))
      .orderBy(asc(organization.name), asc(workspace.createdAt));
    const organizations = new Map<
      string,
      {
        id: string;
        name: string;
        slug: string;
        role: string;
        canCreateWorkspace: boolean;
        workspaces: Array<{ id: string; name: string; slug: string }>;
      }
    >();
    for (const row of rows) {
      const item = organizations.get(row.id) ?? {
        id: row.id,
        name: row.name,
        slug: row.slug,
        role: row.role,
        canCreateWorkspace: row.role === "owner",
        workspaces: [],
      };
      if (row.workspaceId && row.workspaceName && row.workspaceSlug) {
        item.workspaces.push({
          id: row.workspaceId,
          name: row.workspaceName,
          slug: row.workspaceSlug,
        });
      }
      organizations.set(row.id, item);
    }
    return {
      organizations: [...organizations.values()],
      canCreateOrganization: canCreateOrganization(session.user.email),
    };
  });

  api.post(
    "/api/organizations/:organizationId/workspaces",
    { schema: { params: organizationParams, body: createWorkspaceBody } },
    async (request, reply) => {
      const headers = fromNodeHeaders(request.headers);
      const session = await auth.api.getSession({ headers });
      if (!session) return reply.code(401).send({ error: "Unauthorized" });
      const permission = await auth.api.hasPermission({
        headers,
        body: {
          organizationId: request.params.organizationId,
          permissions: { workspace: ["manage"] },
        },
      });
      if (!permission.success)
        return reply.code(403).send({ error: "Forbidden" });

      const id = randomUUID();
      try {
        const created = await db.transaction(async (transaction) => {
          const [record] = await transaction
            .insert(workspace)
            .values({
              id,
              organizationId: request.params.organizationId,
              name: request.body.name,
              slug: request.body.slug,
              createdBy: `user:${session.user.id}`,
              updatedBy: `user:${session.user.id}`,
            })
            .returning({
              id: workspace.id,
              organizationId: workspace.organizationId,
              name: workspace.name,
              slug: workspace.slug,
            });
          if (!record) throw new Error("Workspace creation failed");
          await transaction.execute(
            sql`select set_config('app.workspace_id', ${id}, true)`,
          );
          await transaction.insert(auditEvent).values({
            workspaceId: id,
            actorType: "user",
            actorId: session.user.id,
            action: "workspace.created",
            targetType: "workspace",
            targetId: id,
            metadata: { name: record.name, slug: record.slug },
            requestId: request.id,
          });
          return record;
        });
        return reply.code(201).send(created);
      } catch (error) {
        if (isUniqueViolation(error))
          return reply.code(409).send({ error: "Workspace slug is already used" });
        throw error;
      }
    },
  );
}

function isUniqueViolation(error: unknown) {
  let cause: unknown = error;
  for (let depth = 0; depth < 4 && cause instanceof Error; depth += 1) {
    if ((cause as Error & { code?: string }).code === "23505") return true;
    cause = (cause as Error & { cause?: unknown }).cause;
  }
  return false;
}
