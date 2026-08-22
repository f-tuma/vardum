import { randomUUID } from "node:crypto";
import { fromNodeHeaders } from "better-auth/node";
import { and, asc, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { auth } from "./auth.js";
import { authorizeWorkspaceAdmin } from "./authorization.js";
import { config } from "./config.js";
import { auditEvent, workspace as workspaceTable } from "./db/app-schema.js";
import { db } from "./db/index.js";
import { invitation, member, organization, user } from "./db/auth-schema.js";
import { inWorkspace } from "./db/tenant.js";
import { sendActionEmail, smtpEnabled } from "./mail.js";

const workspaceParams = z.object({ workspaceId: z.string().min(1) });
const invitationParams = z.object({ invitationId: z.string().min(1) });
const workspaceInvitationParams = workspaceParams.extend({
  invitationId: z.string().min(1),
});
const createInvitationBody = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  role: z.enum(["owner", "editor", "viewer"]),
});
const invitationLifetime = 48 * 60 * 60 * 1000;

async function sendInvitation({
  id,
  email,
  role,
  organizationName,
  inviterName,
}: {
  id: string;
  email: string;
  role: string;
  organizationName: string;
  inviterName: string;
}) {
  const url = new URL("/accept-invitation", config.WEB_URL);
  url.searchParams.set("id", id);
  await sendActionEmail({
    to: email,
    subject: `Join ${organizationName} on Vardum`,
    intro: `${inviterName} invited you to join ${organizationName} as ${role}.`,
    action: "Accept invitation",
    url: url.toString(),
  });
}

export function registerInvitationRoutes(app: FastifyInstance) {
  const api = app.withTypeProvider<ZodTypeProvider>();

  api.get(
    "/api/workspaces/:workspaceId/invitations",
    { schema: { params: workspaceParams } },
    async (request, reply) => {
      const { workspaceId } = request.params;
      const authorization = await authorizeWorkspaceAdmin(request, workspaceId);
      if (!("principal" in authorization))
        return reply
          .code(authorization.statusCode)
          .send({ error: authorization.error });

      const invitations = await inWorkspace(workspaceId, (transaction) =>
        transaction
          .select({
            id: invitation.id,
            email: invitation.email,
            role: invitation.role,
            status: invitation.status,
            expiresAt: invitation.expiresAt,
            createdAt: invitation.createdAt,
          })
          .from(invitation)
          .where(
            and(
              eq(
                invitation.organizationId,
                authorization.principal.organizationId,
              ),
              eq(invitation.status, "pending"),
            ),
          )
          .orderBy(desc(invitation.createdAt)),
      );
      return {
        invitations: invitations.map((record) => ({
          ...record,
          role: record.role ?? "viewer",
        })),
      };
    },
  );

  api.post(
    "/api/workspaces/:workspaceId/invitations",
    { schema: { params: workspaceParams, body: createInvitationBody } },
    async (request, reply) => {
      if (!smtpEnabled)
        return reply
          .code(503)
          .send({ error: "Email delivery is not configured" });

      const { workspaceId } = request.params;
      const authorization = await authorizeWorkspaceAdmin(request, workspaceId);
      if (!("principal" in authorization))
        return reply
          .code(authorization.statusCode)
          .send({ error: authorization.error });

      const id = randomUUID();
      const now = new Date();
      const result = await inWorkspace(workspaceId, async (transaction) => {
        const [organizationRecord] = await transaction
          .select({ name: organization.name })
          .from(organization)
          .where(eq(organization.id, authorization.principal.organizationId));
        const [inviter] = await transaction
          .select({ name: user.name })
          .from(user)
          .where(eq(user.id, authorization.principal.actorId));
        if (!organizationRecord || !inviter)
          return { status: "missing" as const };

        const [existingMember] = await transaction
          .select({ id: member.id })
          .from(member)
          .innerJoin(user, eq(user.id, member.userId))
          .where(
            and(
              eq(member.organizationId, authorization.principal.organizationId),
              eq(user.email, request.body.email),
            ),
          );
        if (existingMember) return { status: "member" as const };

        const [existingInvitation] = await transaction
          .select({ id: invitation.id })
          .from(invitation)
          .where(
            and(
              eq(
                invitation.organizationId,
                authorization.principal.organizationId,
              ),
              eq(invitation.email, request.body.email),
              eq(invitation.status, "pending"),
            ),
          );
        if (existingInvitation) return { status: "pending" as const };

        const [created] = await transaction
          .insert(invitation)
          .values({
            id,
            organizationId: authorization.principal.organizationId,
            email: request.body.email,
            role: request.body.role,
            status: "pending",
            expiresAt: new Date(now.getTime() + invitationLifetime),
            createdAt: now,
            inviterId: authorization.principal.actorId,
          })
          .returning({
            id: invitation.id,
            email: invitation.email,
            role: invitation.role,
            status: invitation.status,
            expiresAt: invitation.expiresAt,
            createdAt: invitation.createdAt,
          });
        if (!created) throw new Error("Invitation creation failed");

        await transaction.insert(auditEvent).values({
          workspaceId,
          actorType: authorization.principal.actorType,
          actorId: authorization.principal.actorId,
          action: "workspace.invitation_created",
          targetType: "invitation",
          targetId: created.id,
          metadata: { email: created.email, role: created.role },
          requestId: request.id,
        });
        return {
          status: "created" as const,
          invitation: created,
          organizationName: organizationRecord.name,
          inviterName: inviter.name,
        };
      });

      if (result.status === "missing")
        return reply.code(404).send({ error: "Organization not found" });
      if (result.status === "member")
        return reply.code(409).send({ error: "User is already a member" });
      if (result.status === "pending")
        return reply.code(409).send({ error: "Invitation is already pending" });

      await sendInvitation({
        ...result.invitation,
        role: result.invitation.role ?? "viewer",
        organizationName: result.organizationName,
        inviterName: result.inviterName,
      });
      return reply.code(201).send(result.invitation);
    },
  );

  api.post(
    "/api/workspaces/:workspaceId/invitations/:invitationId/resend",
    { schema: { params: workspaceInvitationParams } },
    async (request, reply) => {
      if (!smtpEnabled)
        return reply
          .code(503)
          .send({ error: "Email delivery is not configured" });

      const { workspaceId, invitationId } = request.params;
      const authorization = await authorizeWorkspaceAdmin(request, workspaceId);
      if (!("principal" in authorization))
        return reply
          .code(authorization.statusCode)
          .send({ error: authorization.error });

      const result = await inWorkspace(workspaceId, async (transaction) => {
        const [record] = await transaction
          .select({
            id: invitation.id,
            email: invitation.email,
            role: invitation.role,
            organizationName: organization.name,
          })
          .from(invitation)
          .innerJoin(
            organization,
            eq(organization.id, invitation.organizationId),
          )
          .where(
            and(
              eq(invitation.id, invitationId),
              eq(
                invitation.organizationId,
                authorization.principal.organizationId,
              ),
              eq(invitation.status, "pending"),
            ),
          );
        const [inviter] = await transaction
          .select({ name: user.name })
          .from(user)
          .where(eq(user.id, authorization.principal.actorId));
        if (!record || !inviter) return null;

        const expiresAt = new Date(Date.now() + invitationLifetime);
        await transaction
          .update(invitation)
          .set({ expiresAt })
          .where(eq(invitation.id, invitationId));
        await transaction.insert(auditEvent).values({
          workspaceId,
          actorType: authorization.principal.actorType,
          actorId: authorization.principal.actorId,
          action: "workspace.invitation_resent",
          targetType: "invitation",
          targetId: record.id,
          metadata: { email: record.email, role: record.role },
          requestId: request.id,
        });
        return { ...record, expiresAt, inviterName: inviter.name };
      });

      if (!result)
        return reply.code(404).send({ error: "Pending invitation not found" });
      await sendInvitation({
        id: result.id,
        email: result.email,
        role: result.role ?? "viewer",
        organizationName: result.organizationName,
        inviterName: result.inviterName,
      });
      return { expiresAt: result.expiresAt };
    },
  );

  api.delete(
    "/api/workspaces/:workspaceId/invitations/:invitationId",
    { schema: { params: workspaceInvitationParams } },
    async (request, reply) => {
      const { workspaceId, invitationId } = request.params;
      const authorization = await authorizeWorkspaceAdmin(request, workspaceId);
      if (!("principal" in authorization))
        return reply
          .code(authorization.statusCode)
          .send({ error: authorization.error });

      const revoked = await inWorkspace(workspaceId, async (transaction) => {
        const [record] = await transaction
          .update(invitation)
          .set({ status: "canceled" })
          .where(
            and(
              eq(invitation.id, invitationId),
              eq(
                invitation.organizationId,
                authorization.principal.organizationId,
              ),
              eq(invitation.status, "pending"),
            ),
          )
          .returning({
            id: invitation.id,
            email: invitation.email,
            role: invitation.role,
          });
        if (!record) return null;
        await transaction.insert(auditEvent).values({
          workspaceId,
          actorType: authorization.principal.actorType,
          actorId: authorization.principal.actorId,
          action: "workspace.invitation_revoked",
          targetType: "invitation",
          targetId: record.id,
          metadata: { email: record.email, role: record.role },
          requestId: request.id,
        });
        return record;
      });
      return revoked
        ? reply.code(204).send()
        : reply.code(404).send({ error: "Pending invitation not found" });
    },
  );

  api.post(
    "/api/invitations/:invitationId/accept",
    { schema: { params: invitationParams } },
    async (request, reply) => {
      const session = await auth.api.getSession({
        headers: fromNodeHeaders(request.headers),
      });
      if (!session) return reply.code(401).send({ error: "Unauthorized" });

      const { invitationId } = request.params;
      const [pending] = await db
        .select({
          organizationId: invitation.organizationId,
          workspaceId: workspaceTable.id,
        })
        .from(invitation)
        .innerJoin(
          workspaceTable,
          eq(workspaceTable.organizationId, invitation.organizationId),
        )
        .where(eq(invitation.id, invitationId))
        .orderBy(asc(workspaceTable.createdAt))
        .limit(1);
      if (!pending)
        return reply.code(404).send({ error: "Invitation not found" });

      const result = await inWorkspace(
        pending.workspaceId,
        async (transaction) => {
          const [record] = await transaction
            .select({
              id: invitation.id,
              organizationId: invitation.organizationId,
              organizationName: organization.name,
              email: invitation.email,
              role: invitation.role,
              status: invitation.status,
              expiresAt: invitation.expiresAt,
            })
            .from(invitation)
            .innerJoin(
              organization,
              eq(organization.id, invitation.organizationId),
            )
            .where(eq(invitation.id, invitationId));
          if (!record) return { status: "missing" as const };
          if (record.status !== "pending") return { status: "used" as const };
          if (record.expiresAt <= new Date())
            return { status: "expired" as const };
          if (record.email.toLowerCase() !== session.user.email.toLowerCase())
            return { status: "email" as const };

          const [existing] = await transaction
            .select({ id: member.id })
            .from(member)
            .where(
              and(
                eq(member.organizationId, record.organizationId),
                eq(member.userId, session.user.id),
              ),
            );
          if (existing) return { status: "member" as const };

          const [accepted] = await transaction
            .update(invitation)
            .set({ status: "accepted" })
            .where(
              and(
                eq(invitation.id, invitationId),
                eq(invitation.status, "pending"),
              ),
            )
            .returning({ id: invitation.id });
          if (!accepted) return { status: "used" as const };
          await transaction.insert(member).values({
            id: randomUUID(),
            organizationId: record.organizationId,
            userId: session.user.id,
            role: record.role ?? "viewer",
            createdAt: new Date(),
          });
          await transaction.insert(auditEvent).values({
            workspaceId: pending.workspaceId,
            actorType: "user",
            actorId: session.user.id,
            action: "workspace.invitation_accepted",
            targetType: "invitation",
            targetId: record.id,
            metadata: { email: record.email, role: record.role },
            requestId: request.id,
          });
          return {
            status: "accepted" as const,
            workspaceId: pending.workspaceId,
            organizationName: record.organizationName,
          };
        },
      );

      if (result.status === "missing")
        return reply.code(404).send({ error: "Invitation not found" });
      if (result.status === "used")
        return reply
          .code(409)
          .send({ error: "Invitation is no longer pending" });
      if (result.status === "expired")
        return reply.code(410).send({ error: "Invitation has expired" });
      if (result.status === "email")
        return reply
          .code(403)
          .send({ error: "Invitation belongs to a different email" });
      if (result.status === "member")
        return reply.code(409).send({ error: "User is already a member" });
      return result;
    },
  );
}
