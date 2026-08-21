import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { formatBytes } from "./asset-dashboard";
import { getWorkspaceOverview } from "./asset-api";

const activityLabels: Record<string, string> = {
  "asset.created": "Asset created",
  "asset.deleted": "Asset deleted",
  "asset.version_created": "Version created",
  "asset.version_queued": "Version queued",
  "asset.version_processed": "Version ready",
  "asset.version_failed": "Version failed",
  "folder.created": "Folder created",
  "workspace.updated": "Workspace updated",
  "workspace.member_role_updated": "Member role updated",
  "workspace.api_key_created": "API key created",
  "workspace.api_key_deleted": "API key revoked",
};
const dateTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

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
            {overview.data.activity.map((event, index) => (
              <li key={event.id}>
                <span aria-hidden="true">
                  {index === overview.data.activity.length - 1 ? "└" : "├"}─
                </span>
                <div>
                  <strong>
                    {activityLabels[event.action] ?? event.action}
                  </strong>
                  <small>
                    {event.targetType} //{" "}
                    {dateTime.format(new Date(event.createdAt))}
                  </small>
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <p className="activity-empty">└─ No activity yet</p>
        )}
      </section>
    </main>
  );
}
