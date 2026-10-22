/** Public UI base only. API, delivery and CLI server URLs stay at the origin. */
export const APP_BASE_PATH = "/app/";

export function appPath(path: `/${string}` = "/"): string {
  return `${APP_BASE_PATH}${path.slice(1)}`;
}

export function appUrl(path: `/${string}`, origin = window.location.origin): string {
  return new URL(appPath(path), origin).href;
}

/** Keep email verification in the active invitation or CLI authorization flow. */
export function appAuthCallback(location: Pick<Location, "origin" | "pathname" | "search" | "hash">): string {
  const invitation = new URLSearchParams(location.search).get("invitation");
  if (invitation)
    return appUrl(`/accept-invitation?id=${encodeURIComponent(invitation)}`, location.origin);
  const path = location.pathname.startsWith(APP_BASE_PATH)
    ? location.pathname
    : appPath();
  return new URL(`${path}${location.search}${location.hash}`, location.origin).href;
}
