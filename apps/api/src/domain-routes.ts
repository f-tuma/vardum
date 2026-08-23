import { randomBytes } from "node:crypto";
import * as dns from "node:dns/promises";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { authorizeWorkspaceAdmin } from "./authorization.js";
import { config } from "./config.js";
import { auditEvent, workspaceSettings } from "./db/app-schema.js";
import { inWorkspace } from "./db/tenant.js";

const workspaceParams = z.object({ workspaceId: z.string().min(1) });
const domainBody = z.object({ domain: z.string().trim().min(1).max(253) });
const domainPattern =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const challengePrefix = "vardum-verification=";
const domainTarget = config.CUSTOM_DOMAIN_TARGET
  ? normalizeCustomDomain(config.CUSTOM_DOMAIN_TARGET)
  : null;

type Resolver = Pick<typeof dns, "resolveCname" | "resolveTxt">;

export function normalizeCustomDomain(input: string) {
  const domain = domainToASCII(input.trim().toLowerCase().replace(/\.$/, ""));
  if (!domain || isIP(domain) || !domainPattern.test(domain))
    throw new Error("Enter a valid domain name");
  return domain;
}

export async function verifyDomainRecords(
  domain: string,
  token: string,
  target: string,
  resolver: Resolver = dns,
) {
  const challenge = `${challengePrefix}${token}`;
  const txt = await resolver
    .resolveTxt(`_vardum-challenge.${domain}`)
    .then((records) => records.some((parts) => parts.join("") === challenge))
    .catch(() => false);

  // Docker's internal DNS proxy (127.0.0.11) sometimes fails to forward CNAME
  // queries, so fall back to a public resolver if the system one fails.
  const cname =
    (await resolver
      .resolveCname(domain)
      .then((records) =>
        records.some(
          (record) => record.toLowerCase().replace(/\.$/, "") === target,
        ),
      )
      .catch(() => false)) || (await resolveCnameWithFallback(domain, target));

  return { txt, cname };
}

async function resolveCnameWithFallback(
  domain: string,
  target: string,
): Promise<boolean> {
  for (const server of ["1.1.1.1", "8.8.8.8"]) {
    try {
      const fallback = new dns.Resolver();
      fallback.setServers([server]);
      const records = await fallback.resolveCname(domain);
      if (
        records.some(
          (record) => record.toLowerCase().replace(/\.$/, "") === target,
        )
      )
        return true;
    } catch {}
  }
  return false;
}

export function registerDomainRoutes(app: FastifyInstance) {
  const api = app.withTypeProvider<ZodTypeProvider>();

  api.get(
    "/api/workspaces/:workspaceId/domain",
    { schema: { params: workspaceParams } },
    async (request, reply) => {
      const { workspaceId } = request.params;
      const authorization = await authorizeWorkspaceAdmin(request, workspaceId);
      if (!("principal" in authorization))
        return reply
          .code(authorization.statusCode)
          .send({ error: authorization.error });

      const [record] = await inWorkspace(workspaceId, (transaction) =>
        transaction
          .select({
            domain: workspaceSettings.customDomain,
            token: workspaceSettings.customDomainVerificationToken,
            verifiedAt: workspaceSettings.customDomainVerifiedAt,
          })
          .from(workspaceSettings)
          .where(eq(workspaceSettings.workspaceId, workspaceId)),
      );
      return domainResponse(record ?? null);
    },
  );

  api.put(
    "/api/workspaces/:workspaceId/domain",
    { schema: { params: workspaceParams, body: domainBody } },
    async (request, reply) => {
      if (!domainTarget)
        return reply
          .code(503)
          .send({ error: "Custom domains are not configured" });
      const { workspaceId } = request.params;
      const authorization = await authorizeWorkspaceAdmin(request, workspaceId);
      if (!("principal" in authorization))
        return reply
          .code(authorization.statusCode)
          .send({ error: authorization.error });

      let domain: string;
      try {
        domain = normalizeCustomDomain(request.body.domain);
      } catch (error) {
        return reply.code(400).send({ error: (error as Error).message });
      }
      const token = randomBytes(24).toString("base64url");
      try {
        const record = await inWorkspace(workspaceId, async (transaction) => {
          const [current] = await transaction
            .select({
              domain: workspaceSettings.customDomain,
              token: workspaceSettings.customDomainVerificationToken,
              verifiedAt: workspaceSettings.customDomainVerifiedAt,
            })
            .from(workspaceSettings)
            .where(eq(workspaceSettings.workspaceId, workspaceId));
          if (current?.domain === domain) return current;

          const [configured] = await transaction
            .insert(workspaceSettings)
            .values({
              workspaceId,
              customDomain: domain,
              customDomainVerificationToken: token,
              customDomainVerifiedAt: null,
              createdBy: authorization.principal.reference,
              updatedBy: authorization.principal.reference,
            })
            .onConflictDoUpdate({
              target: workspaceSettings.workspaceId,
              set: {
                customDomain: domain,
                customDomainVerificationToken: token,
                customDomainVerifiedAt: null,
                updatedBy: authorization.principal.reference,
              },
            })
            .returning({
              domain: workspaceSettings.customDomain,
              token: workspaceSettings.customDomainVerificationToken,
              verifiedAt: workspaceSettings.customDomainVerifiedAt,
            });
          if (!configured) throw new Error("Custom domain update failed");
          await transaction.insert(auditEvent).values({
            workspaceId,
            actorType: authorization.principal.actorType,
            actorId: authorization.principal.actorId,
            action: "workspace.custom_domain_configured",
            targetType: "custom_domain",
            targetId: domain,
            metadata: { domain, previousDomain: current?.domain },
            requestId: request.id,
          });
          return configured;
        });
        return domainResponse(record);
      } catch (error) {
        if (isUniqueViolation(error))
          return reply.code(409).send({ error: "Domain is already assigned" });
        throw error;
      }
    },
  );

  api.post(
    "/api/workspaces/:workspaceId/domain/verify",
    { schema: { params: workspaceParams } },
    async (request, reply) => {
      if (!domainTarget)
        return reply
          .code(503)
          .send({ error: "Custom domains are not configured" });
      const { workspaceId } = request.params;
      const authorization = await authorizeWorkspaceAdmin(request, workspaceId);
      if (!("principal" in authorization))
        return reply
          .code(authorization.statusCode)
          .send({ error: authorization.error });

      const [pending] = await inWorkspace(workspaceId, (transaction) =>
        transaction
          .select({
            domain: workspaceSettings.customDomain,
            token: workspaceSettings.customDomainVerificationToken,
            verifiedAt: workspaceSettings.customDomainVerifiedAt,
          })
          .from(workspaceSettings)
          .where(eq(workspaceSettings.workspaceId, workspaceId)),
      );
      if (!pending?.domain || !pending.token)
        return reply
          .code(404)
          .send({ error: "Custom domain is not configured" });

      const checks = await verifyDomainRecords(
        pending.domain,
        pending.token,
        domainTarget,
      );
      const verifiedAt = checks.txt && checks.cname ? new Date() : null;
      const record = await inWorkspace(workspaceId, async (transaction) => {
        const [current] = await transaction
          .select({
            domain: workspaceSettings.customDomain,
            token: workspaceSettings.customDomainVerificationToken,
            verifiedAt: workspaceSettings.customDomainVerifiedAt,
          })
          .from(workspaceSettings)
          .where(eq(workspaceSettings.workspaceId, workspaceId))
          .for("update");
        if (
          !current ||
          current.domain !== pending.domain ||
          current.token !== pending.token
        )
          return null;
        await transaction
          .update(workspaceSettings)
          .set({
            customDomainVerifiedAt: verifiedAt,
            updatedBy: authorization.principal.reference,
          })
          .where(eq(workspaceSettings.workspaceId, workspaceId));
        const wasVerified = Boolean(current.verifiedAt);
        const isVerified = Boolean(verifiedAt);
        if (wasVerified !== isVerified) {
          await transaction.insert(auditEvent).values({
            workspaceId,
            actorType: authorization.principal.actorType,
            actorId: authorization.principal.actorId,
            action: isVerified
              ? "workspace.custom_domain_verified"
              : "workspace.custom_domain_unverified",
            targetType: "custom_domain",
            targetId: current.domain ?? workspaceId,
            metadata: { domain: current.domain, checks },
            requestId: request.id,
          });
        }
        return { ...current, verifiedAt };
      });
      if (!record)
        return reply
          .code(409)
          .send({ error: "Custom domain changed during verification" });
      return { ...domainResponse(record), checks };
    },
  );

  api.delete(
    "/api/workspaces/:workspaceId/domain",
    { schema: { params: workspaceParams } },
    async (request, reply) => {
      const { workspaceId } = request.params;
      const authorization = await authorizeWorkspaceAdmin(request, workspaceId);
      if (!("principal" in authorization))
        return reply
          .code(authorization.statusCode)
          .send({ error: authorization.error });

      await inWorkspace(workspaceId, async (transaction) => {
        const [current] = await transaction
          .select({ domain: workspaceSettings.customDomain })
          .from(workspaceSettings)
          .where(eq(workspaceSettings.workspaceId, workspaceId));
        if (!current?.domain) return;
        await transaction
          .update(workspaceSettings)
          .set({
            customDomain: null,
            customDomainVerificationToken: null,
            customDomainVerifiedAt: null,
            updatedBy: authorization.principal.reference,
          })
          .where(eq(workspaceSettings.workspaceId, workspaceId));
        await transaction.insert(auditEvent).values({
          workspaceId,
          actorType: authorization.principal.actorType,
          actorId: authorization.principal.actorId,
          action: "workspace.custom_domain_removed",
          targetType: "custom_domain",
          targetId: current.domain,
          metadata: { domain: current.domain },
          requestId: request.id,
        });
      });
      return reply.code(204).send();
    },
  );
}

function domainResponse(
  record: {
    domain: string | null;
    token: string | null;
    verifiedAt: Date | null;
  } | null,
) {
  const domain = record?.domain ?? null;
  const token = record?.token ?? null;
  return {
    domain,
    status: domain
      ? record?.verifiedAt
        ? "verified"
        : "pending"
      : "unconfigured",
    verifiedAt: record?.verifiedAt ?? null,
    target: domainTarget,
    verification:
      domain && token
        ? {
            name: `_vardum-challenge.${domain}`,
            value: `${challengePrefix}${token}`,
          }
        : null,
  };
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ("code" in error && error.code === "23505") return true;
  return "cause" in error && isUniqueViolation(error.cause);
}
