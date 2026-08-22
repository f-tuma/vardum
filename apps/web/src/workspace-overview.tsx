import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { formatBytes } from "./asset-dashboard";
import { getWorkspaceOverview, type WorkspaceOverview } from "./asset-api";

const activityLabels: Record<string, string> = {
  "asset.created": "Asset created",
  "asset.deleted": "Asset deleted",
  "asset.version_created": "Version created",
  "asset.version_queued": "Version queued",
  "asset.version_processed": "Version ready",
  "asset.version_failed": "Version failed",
  "folder.created": "Folder created",
  "folder.deleted": "Folder deleted",
  "workspace.updated": "Workspace updated",
  "workspace.member_role_updated": "Member role updated",
  "workspace.invitation_created": "Invitation sent",
  "workspace.invitation_resent": "Invitation resent",
  "workspace.invitation_revoked": "Invitation revoked",
  "workspace.invitation_accepted": "Invitation accepted",
  "workspace.api_key_created": "API key created",
  "workspace.api_key_deleted": "API key revoked",
};
const dateTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});
type ActivityEvent = WorkspaceOverview["activity"][number];

function metadataText(event: ActivityEvent, key: string) {
  const value = event.metadata[key];
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : "";
}

function activityTarget(event: ActivityEvent) {
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

function activityActor(event: ActivityEvent) {
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

  const stats = [
    ["ASSETS", overview.data.assets.toLocaleString(), "managed files"],
    ["VERSIONS", overview.data.versions.toLocaleString(), "stored revisions"],
    ["STORAGE", formatBytes(overview.data.storageBytes), "ready originals"],
  ] as const;

  return (
    <main className="dashboard-main overview" id="overview">
      <header className="overview-heading">
        <div>
          <p className="overview-kicker">WORKSPACE // OVERVIEW</p>
          <h1>{workspaceName}</h1>
          <p>{workspaceSlug}</p>
        </div>
        <Link
          className="overview-action"
          to="/workspaces/$workspaceId/assets"
          params={{ workspaceId }}
          search={{ prefix: "" }}
        >
          Browse assets →
        </Link>
      </header>

      <section className="overview-stats" aria-label="Workspace statistics">
        {stats.map(([label, value, note]) => (
          <article className="overview-stat" key={label}>
            <span>┌─ {label}</span>
            <strong>{value}</strong>
            <small>{note}</small>
          </article>
        ))}
      </section>

      <section className="activity-panel">
        <header>
          <h2>┌─ RECENT ACTIVITY</h2>
          <span>{overview.data.activity.length} events</span>
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
