import { fromNodeHeaders } from "better-auth/node";
import type { FastifyRequest } from "fastify";
import { auth } from "./auth.js";

export type AssetAction = "read" | "create" | "update" | "delete" | "publish";
export type Principal = {
  actorType: "user" | "api_key";
  actorId: string;
  reference: string;
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

  const permission = await auth.api.hasPermission({
    headers,
    body: {
      organizationId: workspaceId,
      permissions: { workspace: ["manage"] },
    },
  });

  return permission.success
    ? {
        principal: {
          actorType: "user",
          actorId: session.user.id,
          reference: `user:${session.user.id}`,
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

    return key?.referenceId === workspaceId
      ? {
          principal: {
            actorType: "api_key",
            actorId: key.id,
            reference: `api_key:${key.id}`,
          },
        }
      : { statusCode: 401, error: "Unauthorized" };
  }

  const headers = fromNodeHeaders(request.headers);
  const session = await auth.api.getSession({ headers });
  if (!session) return { statusCode: 401, error: "Unauthorized" };

  const permission = await auth.api.hasPermission({
    headers,
    body: { organizationId: workspaceId, permissions: { asset: actions } },
  });

  return permission.success
    ? {
        principal: {
          actorType: "user",
          actorId: session.user.id,
          reference: `user:${session.user.id}`,
        },
      }
    : { statusCode: 403, error: "Forbidden" };
}
