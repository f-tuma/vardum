import { config } from "./config.js";

export function canCreateOrganization(
  email: string,
  mode = config.ORGANIZATION_CREATION,
  allowlist = config.ORGANIZATION_CREATOR_EMAILS,
) {
  if (mode === "open") return true;
  if (mode === "disabled") return false;
  const allowed = new Set(
    allowlist
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
  return allowed.has(email.toLowerCase());
}
