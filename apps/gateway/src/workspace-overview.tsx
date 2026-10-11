import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowRightIcon, TriangleAlertIcon, UploadIcon } from "lucide-react";
import { cloneElement, type ReactElement, type ReactNode } from "react";
import { DeliveryChart } from "@/components/delivery-chart";
import { AppHeader, Page, PageHeader, PageSkeleton } from "@/components/page";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@/components/ui/item";
import { dateTime, formatBytes, timeAgo } from "@/lib/format";
import { getWorkspaceOverview, listVards, type WorkspaceOverview as Overview } from "./asset-api";
import type { WorkspaceRef } from "./workspace";

export const activityLabels: Record<string, string> = {
  "asset.created": "Asset created",
  "asset.visibility_updated": "Visibility changed",
  "asset.renamed": "Asset renamed",
  "asset.upload_expired": "Upload expired",
  "asset.deleted": "Asset deleted",
  "asset.version_created": "Version created",
  "asset.version_queued": "Version queued",
  "asset.version_retried": "Processing retried",
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
type ActivityEvent = Overview["activity"][number];

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
    return { subject: path.split("/").at(-1) ?? path, detail: prefix };
  }
  if (displayName || key)
    return {
      subject: `${displayName || key}${version ? ` · v${version}` : ""}`,
      detail: [key, filename].filter(Boolean).join(" · "),
    };
  if (email)
    return {
      subject: name || email,
      detail: [email, role].filter(Boolean).join(" · "),
    };
  const label = targetLabels[event.targetType] ?? event.targetType;
  const isPublic = event.metadata.isPublic;
  const itemCount = metadataText(event, "itemCount");
  const detail =
    typeof isPublic === "boolean"
      ? `${event.action === "asset.visibility_updated" ? "Now " : ""}${isPublic ? "public" : "private"}`
      : itemCount
        ? `${itemCount} ${itemCount === "1" ? "file" : "files"}`
        : "";
  if (name) return { subject: name, detail: detail || label };
  return { subject: label, detail };
}

const targetLabels: Record<string, string> = {
  asset: "Asset",
  asset_version: "Version",
  vard: "Vard",
  folder: "Folder",
  api_key: "API key",
  custom_domain: "Custom domain",
  invitation: "Invitation",
  member: "Member",
  workspace: "Workspace",
};

export function activityActor(event: ActivityEvent) {
  if (event.actor.email) return event.actor.name || event.actor.email;
  if (event.actor.name === "API key" && event.actor.id)
    return `API key ${event.actor.id.slice(0, 8)}`;
  return event.actor.name;
}

export function WorkspaceOverview({ workspace }: { workspace: WorkspaceRef }) {
  const overview = useQuery({
    queryKey: ["workspace-overview", workspace.id],
    queryFn: () => getWorkspaceOverview(workspace.id),
  });
  const assetsLink = (
    <Link
      to="/workspaces/$workspaceId/assets"
      params={{ workspaceId: workspace.id }}
      search={{ prefix: "" }}
    />
  );

  return (
    <>
      <AppHeader crumbs={[{ label: workspace.name }]} />
      <Page id="main">
        <PageHeader
          title={workspace.name}
          description={<span className="font-mono">{workspace.slug}</span>}
          actions={
            <Button variant="outline" nativeButton={false} render={assetsLink}>
              Browse assets
              <ArrowRightIcon data-icon="inline-end" />
            </Button>
          }
        />
        {overview.isPending ? (
          <PageSkeleton />
        ) : overview.isError ? (
          <Alert variant="destructive">
            <TriangleAlertIcon />
            <AlertTitle>Overview unavailable</AlertTitle>
            <AlertDescription>{overview.error.message}</AlertDescription>
          </Alert>
        ) : overview.data.assets === 0 ? (
          <Empty variant="outline">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <UploadIcon />
              </EmptyMedia>
              <EmptyTitle>Your workspace is ready</EmptyTitle>
              <EmptyDescription>
                Upload a file, then add it to a Vard to pull it into a project.
              </EmptyDescription>
            </EmptyHeader>
            {workspace.canEdit && (
              <EmptyContent>
                <Button nativeButton={false} render={assetsLink}>
                  Upload your first asset
                </Button>
              </EmptyContent>
            )}
          </Empty>
        ) : (
          <OverviewContent overview={overview.data} workspace={workspace} />
        )}
      </Page>
    </>
  );
}

function OverviewContent({
  overview,
  workspace,
}: {
  overview: Overview;
  workspace: WorkspaceRef;
}) {
  const vards = useQuery({
    queryKey: ["vards", workspace.id],
    queryFn: () => listVards(workspace.id),
  });
  const stats: Array<{ label: string; value: string; link?: ReactElement<{ className?: string }> }> = [
    {
      label: "Assets",
      value: overview.assets.toLocaleString(),
      link: (
        <Link
          to="/workspaces/$workspaceId/assets"
          params={{ workspaceId: workspace.id }}
          search={{ prefix: "" }}
        />
      ),
    },
    { label: "Versions", value: overview.versions.toLocaleString() },
    { label: "Storage", value: formatBytes(overview.storageBytes) },
    {
      label: "Vards",
      value: vards.data ? vards.data.vards.length.toLocaleString() : "—",
      link: <Link to="/workspaces/$workspaceId/vards" params={{ workspaceId: workspace.id }} />,
    },
  ];

  return (
    <>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {stats.map((stat) => {
          const card = (
            <Card size="sm">
              <CardHeader>
                <CardDescription>
                  <span className="font-mono text-xs lowercase">{stat.label}</span>
                </CardDescription>
                <CardTitle>
                  <span className="font-mono text-2xl font-medium tabular-nums">{stat.value}</span>
                </CardTitle>
                {stat.link && (
                  <CardAction>
                    <ArrowRightIcon
                      aria-hidden="true"
                      className="size-4 text-muted-foreground opacity-0 transition-opacity group-hover/stat:opacity-100 group-focus-visible/stat:opacity-100"
                    />
                  </CardAction>
                )}
              </CardHeader>
            </Card>
          );
          return stat.link ? (
            <StatLink key={stat.label} link={stat.link}>
              {card}
            </StatLink>
          ) : (
            <div key={stat.label}>{card}</div>
          );
        })}
      </div>

      <div className="grid gap-4 xl:grid-cols-5">
        <div className="min-w-0 xl:col-span-3">
          <Card>
            <CardHeader>
              <CardTitle>Delivery</CardTitle>
              <CardDescription>Successful responses from this workspace</CardDescription>
            </CardHeader>
            <CardContent>
              <DeliveryChart summary={overview.delivery} />
            </CardContent>
          </Card>
        </div>
        <div className="min-w-0 xl:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Recent activity</CardTitle>
              <CardAction>
                <Button
                  variant="ghost"
                  size="sm"
                  nativeButton={false}
                  render={
                    <Link
                      to="/workspaces/$workspaceId/activity"
                      params={{ workspaceId: workspace.id }}
                    />
                  }
                >
                  View all
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent>
              {overview.activity.length ? (
                <ItemGroup>
                  {overview.activity.map((event) => {
                    const target = activityTarget(event);
                    const link = activityLink(event, workspace.id);
                    return (
                      <Item key={event.id} size="xs" render={link ?? undefined}>
                        <ItemContent>
                          <ItemTitle>
                            {activityLabels[event.action] ?? event.action}
                            <span className="truncate font-normal text-muted-foreground">
                              {target.subject}
                            </span>
                          </ItemTitle>
                          <ItemDescription>
                            {activityActor(event)} ·{" "}
                            <time dateTime={event.createdAt} title={dateTime.format(new Date(event.createdAt))}>
                              {timeAgo(event.createdAt)}
                            </time>
                          </ItemDescription>
                        </ItemContent>
                      </Item>
                    );
                  })}
                </ItemGroup>
              ) : (
                <p className="text-sm text-muted-foreground">No activity yet.</p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}

/** A stat card that opens the page behind the number. */
function StatLink({ link, children }: { link: ReactElement<{ className?: string }>; children: ReactNode }) {
  return cloneElement(
    link,
    {
      className:
        "group/stat block rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
    },
    children,
  );
}

/** Where an event's target lives now, or null once it is gone. */
export function activityLink(
  event: ActivityEvent,
  workspaceId: string,
): ReactElement<{ className?: string }> | null {
  if (event.action.endsWith(".deleted")) return null;
  const assetId =
    event.targetType === "asset"
      ? event.targetId
      : event.targetType === "asset_version"
        ? metadataText(event, "assetId")
        : "";
  if (assetId)
    return (
      <Link
        to="/workspaces/$workspaceId/assets/$assetId"
        params={{ workspaceId, assetId }}
        search={{ from: "" }}
      />
    );
  if (event.targetType === "vard")
    return (
      <Link
        to="/workspaces/$workspaceId/vards/$vardId"
        params={{ workspaceId, vardId: event.targetId }}
      />
    );
  const prefix = metadataText(event, "prefix");
  if (event.targetType === "folder" && prefix)
    return <Link to="/workspaces/$workspaceId/assets" params={{ workspaceId }} search={{ prefix }} />;
  if (event.targetType === "api_key" || event.targetType === "custom_domain")
    return (
      <Link
        to="/workspaces/$workspaceId/settings"
        params={{ workspaceId }}
        search={{ tab: event.targetType === "api_key" ? "api-keys" : "custom-domain" }}
      />
    );
  return null;
}
