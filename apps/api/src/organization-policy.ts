import { config } from "./config.js";

type OrganizationCreator = { email: string; emailVerified: boolean };

export function organizationCreationAccess(
  user: OrganizationCreator,
  mode = config.ORGANIZATION_CREATION,
  allowlist = config.ORGANIZATION_CREATOR_EMAILS,
) {
  // Open is an explicit policy allowing every account, without trusting its email.
  if (mode === "open") return "allowed" as const;
  if (mode === "disabled") return "not_allowed" as const;
  const allowed = new Set(
    allowlist
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
  if (!allowed.has(user.email.toLowerCase())) return "not_allowed" as const;
  return user.emailVerified === true
    ? ("allowed" as const)
    : ("email_verification_required" as const);
}

export function canCreateOrganization(
  user: OrganizationCreator,
  mode = config.ORGANIZATION_CREATION,
  allowlist = config.ORGANIZATION_CREATOR_EMAILS,
) {
  return organizationCreationAccess(user, mode, allowlist) === "allowed";
}
