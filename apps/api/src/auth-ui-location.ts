// Only completed Better Auth response redirects to our UI are migrated. Never
// rewrite request callback parameters, loopback grants, API or delivery URLs.
export function authUiLocation(location: string, webOrigin: string): string {
  const absolute = /^(https?:\/\/[^/?#]+)(\/[^?#]*)?([?#].*)?$/.exec(location);
  const relative = /^(\/(?!\/)[^?#]*)([?#].*)?$/.exec(location);
  if (!absolute && !relative) return location;
  const prefix = absolute?.[1] ?? "";
  const path = absolute ? absolute[2] || "/" : relative![1]!;
  const suffix = absolute ? absolute[3] ?? "" : relative![2] ?? "";
  try {
    const parsed = new URL(location, webOrigin);
    if (parsed.origin !== new URL(webOrigin).origin || parsed.username || parsed.password || parsed.pathname !== path)
      return location;
  } catch {
    return location;
  }
  if (path === "/" || path === "/app") return `${prefix}/app/${suffix}`;
  if (/^\/(?:account|organizations|workspaces|reset-password|accept-invitation|cli-login)(?:\/|$)/.test(path))
    return `${prefix}/app${path}${suffix}`;
  return location;
}
