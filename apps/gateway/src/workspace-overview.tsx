import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { formatBytes } from "./asset-dashboard";
import { getWorkspaceOverview, type WorkspaceOverview } from "./asset-api";

export const activityLabels: Record<string, string> = {
  "asset.created": "Asset created",
  "asset.visibility_changed": "Visibility changed",
  "asset.deleted": "Asset deleted",
  "asset.version_created": "Version created",
  "asset.version_queued": "Version queued",
  "asset.version_processed": "Version ready",
  "asset.version_restored": "Version restored",
  "asset.version_failed": "Version failed",
  "folder.created": "Folder created",
  "folder.deleted": "Folder deleted",
  "vard.created": "Vard created",
  "vard.updated": "Vard updated",
  "vard.items_updated": "Vard outputs updated",
  "vard.deleted": "Vard deleted",
  "workspace.created": "Workspace created",
  "workspace.updated": "Workspace updated",
  "workspace.member_role_updated": "Member role updated",
  "workspace.custom_domain_configured": "Custom domain configured",
  "workspace.custom_domain_verified": "Custom domain verified",
  "workspace.custom_domain_unverified": "Custom domain unverified",
  "workspace.custom_domain_removed": "Custom domain removed",
  "workspace.invitation_created": "Invitation sent",
  "workspace.invitation_resent": "Invitation resent",
  "workspace.invitation_revoked": "Invitation revoked",
  "workspace.invitation_accepted": "Invitation accepted",
  "workspace.api_key_created": "API key created",
  "workspace.api_key_deleted": "API key revoked",
};
export const dateTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});
const shortDate = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
type ActivityEvent = WorkspaceOverview["activity"][number];

function metadataText(event: ActivityEvent, key: string) {
  const value = event.metadata[key];
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : "";
}

export function activityTarget(event: ActivityEvent) {
  const prefix = metadataText(event, "prefix");
  const displayName = metadataText(event, "displayName");
  const key = metadataText(event, "key");
  const version = metadataText(event, "number");
  const filename = metadataText(event, "filename");
  const name = metadataText(event, "name");
  const email = metadataText(event, "email");
  const role = metadataText(event, "role");

  if (prefix) {
    const path = prefix.replace(/\/$/, "");
    return {
      subject: path.split("/").at(-1) ?? path,
      detail: `path: ${prefix}`,
    };
  }
  if (displayName || key)
    return {
      subject: `${displayName || key}${version ? ` · v${version}` : ""}`,
      detail: [key, filename].filter(Boolean).join(" // "),
    };
  if (email)
    return {
      subject: name || email,
      detail: [email, role && `role: ${role}`].filter(Boolean).join(" // "),
    };
  if (name) return { subject: name, detail: event.targetType };
  return {
    subject: event.targetType,
    detail: event.targetId.slice(0, 8),
  };
}

export function activityActor(event: ActivityEvent) {
  if (event.actor.email) return `${event.actor.name} <${event.actor.email}>`;
  if (event.actor.name === "API key" && event.actor.id)
    return `API key ${event.actor.id.slice(0, 8)}`;
  return event.actor.name;
}

export function WorkspaceOverview({
  workspaceId,
  workspaceName,
  workspaceSlug,
}: {
  workspaceId: string;
  workspaceName: string;
  workspaceSlug: string;
}) {
  const overview = useQuery({
    queryKey: ["workspace-overview", workspaceId],
    queryFn: () => getWorkspaceOverview(workspaceId),
  });

  if (overview.isPending)
    return <div className="state-panel">Loading overview…</div>;
  if (overview.isError)
    return (
      <div className="state-panel" role="alert">
        {overview.error.message}
      </div>
    );

  const delivery = overview.data.delivery;
  const maximumRequests = Math.max(
    1,
    ...delivery.days.map(({ requests }) => requests),
  );
  const stats = [
    ["ASSETS", overview.data.assets.toLocaleString(), "managed files"],
    ["VERSIONS", overview.data.versions.toLocaleString(), "stored revisions"],
    ["STORAGE", formatBytes(overview.data.storageBytes), "ready originals"],
    [
      "REQUESTS",
      delivery.requests30d.toLocaleString(),
      "delivery responses // 30 days",
    ],
  ] as const;

  return (
    <main className="dashboard-main overview" id="overview">
      <header className="overview-heading">
        <div>
          <h1>{workspaceName}</h1>
          <p>{workspaceSlug}</p>
        </div>
        <Link
          className="button-link"
          to="/workspaces/$workspaceId/assets"
          params={{ workspaceId }}
          search={{ prefix: "" }}
        >
          Browse assets
        </Link>
      </header>

      {overview.data.assets === 0 && (
        <div className="getting-started">
          <div>
            <strong>Your workspace is ready</strong>
            <p>Upload a file, then add it to a Vard.</p>
          </div>
          <Link
            className="button-link primary-button"
            to="/workspaces/$workspaceId/assets"
            params={{ workspaceId }}
            search={{ prefix: "" }}
          >
            Add your first asset →
          </Link>
        </div>
      )}
      <section className="overview-stats" aria-label="Workspace statistics">
        {stats.map(([label, value, note]) => (
          <article className="overview-stat" key={label}>
            <span>┌─ {label}</span>
            <strong>{value}</strong>
            <small>{note}</small>
          </article>
        ))}
      </section>

      <section className="delivery-panel" aria-labelledby="delivery-heading">
        <header>
          <h2 id="delivery-heading">┌─ DELIVERY // LAST 30 DAYS</h2>
          <span>
            {delivery.transformed30d.toLocaleString()} transformed //{" "}
            {formatBytes(delivery.bytes30d)} response bytes
            {delivery.cacheHitRatio !== null &&
              ` // ${Math.round(delivery.cacheHitRatio * 100)}% transform cache`}
          </span>
        </header>
        <ol aria-label="Daily successful delivery responses">
          {delivery.days.map((day, index) => {
            const label = shortDate.format(new Date(`${day.date}T00:00:00Z`));
            return (
              <li key={day.date}>
                <span
                  data-empty={day.requests === 0 || undefined}
                  aria-label={`${label}: ${day.requests} delivery responses`}
                  title={`${label} // ${day.requests} responses // ${formatBytes(day.bytes)}`}
                  style={{
                    height: day.requests
                      ? `${Math.max(4, (day.requests / maximumRequests) * 100)}%`
                      : "1px",
                  }}
                />
                <small>
                  {((index % 7 === 0 && index < delivery.days.length - 2) ||
                    index === delivery.days.length - 1) &&
                    label}
                </small>
              </li>
            );
          })}
        </ol>
      </section>

      <section className="activity-panel">
        <header>
          <h2>┌─ RECENT ACTIVITY</h2>
          <Link
            className="button-link"
            to="/workspaces/$workspaceId/settings"
            params={{ workspaceId }}
            search={{ tab: "activity" }}
          >
            View all activity
          </Link>
        </header>
        {overview.data.activity.length ? (
          <ol>
            {overview.data.activity.map((event, index) => {
              const target = activityTarget(event);
              return (
                <li key={event.id}>
                  <span aria-hidden="true">
                    {index === overview.data.activity.length - 1 ? "└" : "├"}─
                  </span>
                  <div>
                    <strong>
                      {activityLabels[event.action] ?? event.action}
                      <b> // {target.subject}</b>
                    </strong>
                    {target.detail && <small>{target.detail}</small>}
                    <small>
                      by {activityActor(event)} //{" "}
                      {dateTime.format(new Date(event.createdAt))}
                    </small>
                  </div>
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="activity-empty">└─ No activity yet</p>
        )}
      </section>
    </main>
  );
}
