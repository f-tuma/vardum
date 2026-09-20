import { isAPIError } from "better-auth/api";
import { fromNodeHeaders } from "better-auth/node";
import { eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { auth } from "./auth.js";
import { workspace } from "./db/app-schema.js";
import { db } from "./db/index.js";

export type AssetAction = "read" | "create" | "update" | "delete" | "publish";
type Principal = {
  actorType: "user" | "api_key";
  actorId: string;
  reference: string;
  organizationId: string;
};
export type AuthorizationResult =
  | { principal: Principal }
  | { statusCode: 401 | 403; error: "Unauthorized" | "Forbidden" };

export async function authorizeWorkspaceAdmin(
  request: FastifyRequest,
  workspaceId: string,
): Promise<AuthorizationResult> {
  const headers = fromNodeHeaders(request.headers);
  const session = await auth.api.getSession({ headers });
  if (!session) return { statusCode: 401, error: "Unauthorized" };

  const organizationId = await findWorkspaceOrganizationId(workspaceId);
  if (!organizationId) return { statusCode: 403, error: "Forbidden" };
  const permission = await auth.api.hasPermission({
    headers,
    body: {
      organizationId,
      permissions: { workspace: ["manage"] },
    },
  });

  return permission.success
    ? {
        principal: {
          actorType: "user",
          actorId: session.user.id,
          reference: `user:${session.user.id}`,
          organizationId,
        },
      }
    : { statusCode: 403, error: "Forbidden" };
}

export async function authorizeAsset(
  request: FastifyRequest,
  workspaceId: string,
  actions: AssetAction[],
): Promise<AuthorizationResult> {
  const apiKey = request.headers["x-api-key"];
  if (typeof apiKey === "string") {
    const result = await auth.api.verifyApiKey({
      body: {
        key: apiKey,
        configId: "workspace",
        permissions: { asset: actions },
      },
    });
    const key = result.valid ? result.key : null;
    const organizationId =
      key?.referenceId === workspaceId
        ? await findWorkspaceOrganizationId(workspaceId)
        : null;

    return key && organizationId
      ? {
          principal: {
            actorType: "api_key",
            actorId: key.id,
            reference: `api_key:${key.id}`,
            organizationId,
          },
        }
      : { statusCode: 401, error: "Unauthorized" };
  }

  const headers = fromNodeHeaders(request.headers);
  const session = await auth.api.getSession({ headers });
  if (!session) return { statusCode: 401, error: "Unauthorized" };

  const organizationId = await findWorkspaceOrganizationId(workspaceId);
  if (!organizationId) return { statusCode: 403, error: "Forbidden" };
  const permission = await auth.api
    .hasPermission({
      headers,
      body: { organizationId, permissions: { asset: actions } },
    })
    .catch((error: unknown) => {
      // Better Auth throws for a signed-in non-member, rather than returning false.
      if (isAPIError(error) && [401, 403].includes(error.statusCode))
        return { success: false };
      throw error;
    });

  return permission.success
    ? {
        principal: {
          actorType: "user",
          actorId: session.user.id,
          reference: `user:${session.user.id}`,
          organizationId,
        },
      }
    : { statusCode: 403, error: "Forbidden" };
}

async function findWorkspaceOrganizationId(workspaceId: string) {
  const [record] = await db
    .select({ organizationId: workspace.organizationId })
    .from(workspace)
    .where(eq(workspace.id, workspaceId));
  return record?.organizationId;
}
