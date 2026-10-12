import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Building2Icon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useState, type ReactNode, type SyntheticEvent } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { CommandMenuProvider } from "@/components/command-menu";
import { AppHeader, Page, PageSkeleton } from "@/components/page";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
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
import { FieldError, FieldGroup } from "@/components/ui/field";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage } from "@/lib/format";
import { AccountSettings } from "./account-settings";
import { getOrganizationDirectory } from "./asset-api";
import { AssetDashboard } from "./asset-dashboard";
import { AuditLog } from "./audit-log";
import { AuthForm } from "./auth-form";
import { authClient } from "./auth-client";
import { NameSlugFields } from "./name-slug-fields";
import { OrganizationSettings } from "./organization-settings";
import { OrganizationVerification } from "./organization-verification";
import { VardEditor, VardsPage } from "./vards";
import { UsagePage } from "./usage";
import { WorkspaceOverview } from "./workspace-overview";
import { WorkspaceSettings } from "./workspace-settings";

type View =
  | "overview"
  | "assets"
  | "vards"
  | "activity"
  | "usage"
  | "settings"
  | "organization"
  | "account";

export function App({
  routeWorkspaceId,
  routeOrganizationId,
  assetId,
  vardId,
  prefix = "",
  fromPrefix,
  searchQuery = "",
  view = "overview",
}: {
  routeWorkspaceId?: string;
  routeOrganizationId?: string;
  assetId?: string;
  vardId?: string;
  prefix?: string;
  fromPrefix?: string;
  searchQuery?: string;
  view?: View;
}) {
  const session = authClient.useSession();
  if (session.isPending)
    return (
      <div className="flex min-h-svh items-center justify-center">
        <Spinner />
      </div>
    );
  if (!session.data) return <AuthForm />;
  return (
    <WorkspaceApp
      email={session.data.user.email}
      name={session.data.user.name}
      routeWorkspaceId={routeWorkspaceId}
      routeOrganizationId={routeOrganizationId}
      assetId={assetId}
      vardId={vardId}
      prefix={prefix}
      fromPrefix={fromPrefix}
      searchQuery={searchQuery}
      view={view}
    />
  );
}

function WorkspaceApp({
  email,
  name,
  routeWorkspaceId,
  routeOrganizationId,
  assetId,
  vardId,
  prefix,
  fromPrefix,
  searchQuery,
  view,
}: {
  email: string;
  name: string;
  routeWorkspaceId?: string;
  routeOrganizationId?: string;
  assetId?: string;
  vardId?: string;
  prefix: string;
  fromPrefix?: string;
  searchQuery: string;
  view: View;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [selectedId, setSelectedId] = useState(routeWorkspaceId ?? "");
  const directory = useQuery({
    queryKey: ["organizations"],
    queryFn: getOrganizationDirectory,
  });
  const organizations = directory.data?.organizations ?? [];
  const allWorkspaces = organizations.flatMap((organization) =>
    organization.workspaces.map((workspace) => ({
      ...workspace,
      organizationId: organization.id,
      organizationName: organization.name,
      organizationRole: organization.role,
    })),
  );
  const routeWorkspace = allWorkspaces.find(({ id }) => id === routeWorkspaceId);
  const routeOrganization = organizations.find(
    ({ id }) => id === routeOrganizationId,
  );
  // Outside a workspace route, keep showing the last workspace the user was in.
  const selected =
    routeWorkspace ??
    (routeOrganizationId
      ? (allWorkspaces.find(
          (workspace) =>
            workspace.id === selectedId &&
            workspace.organizationId === routeOrganizationId,
        ) ??
        allWorkspaces.find(
          (workspace) => workspace.organizationId === routeOrganizationId,
        ))
      : (allWorkspaces.find(({ id }) => id === selectedId) ?? allWorkspaces[0]));
  const selectedOrganization =
    routeOrganization ??
    organizations.find(({ id }) => id === selected?.organizationId) ??
    organizations[0];

  // Remember the workspace while rendering, so organization and account pages
  // keep the sidebar on it.
  if (selected && selected.id !== selectedId) setSelectedId(selected.id);

  const landingWorkspaceId =
    view === "overview" && !routeWorkspaceId ? selected?.id : undefined;
  useEffect(() => {
    if (landingWorkspaceId)
      void navigate({
        to: "/workspaces/$workspaceId",
        params: { workspaceId: landingWorkspaceId },
        replace: true,
      });
  }, [navigate, landingWorkspaceId]);

  async function signOut() {
    await authClient.signOut();
    queryClient.clear();
  }

  const unavailable =
    (routeWorkspaceId && !routeWorkspace) ||
    (routeOrganizationId && !routeOrganization);

  let content: ReactNode;
  if (view === "account") content = <AccountSettings />;
  else if (directory.isPending)
    content = (
      <Shell crumbs={[{ label: "Loading" }]}>
        <PageSkeleton />
      </Shell>
    );
  else if (directory.isError)
    content = (
      <Shell crumbs={[{ label: "Error" }]}>
        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>Workspaces could not load</AlertTitle>
          <AlertDescription>{directory.error.message}</AlertDescription>
        </Alert>
      </Shell>
    );
  else if (unavailable)
    content = (
      <Shell crumbs={[{ label: "Not found" }]}>
        <Empty variant="outline">
          <EmptyHeader>
            <EmptyTitle>Not available</EmptyTitle>
            <EmptyDescription>
              This workspace or organization does not exist, or you are not a
              member.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button render={<Link to="/app" />} nativeButton={false}>
              Back to your workspaces
            </Button>
          </EmptyContent>
        </Empty>
      </Shell>
    );
  else if (
    !organizations.length &&
    directory.data.organizationCreation.status === "email_verification_required"
  )
    content = (
      <Shell crumbs={[{ label: "Get started" }]}>
        <OrganizationVerification
          emailEnabled={directory.data.organizationCreation.verificationEmailEnabled}
        />
      </Shell>
    );
  else if (!organizations.length && directory.data.canCreateOrganization)
    content = (
      <Shell crumbs={[{ label: "Get started" }]}>
        <CreateFirstOrganization />
      </Shell>
    );
  else if (view === "organization" && selectedOrganization)
    content = (
      <OrganizationSettings
        key={selectedOrganization.id}
        organizationId={selectedOrganization.id}
      />
    );
  else if (selected) {
    const workspace = {
      id: selected.id,
      name: selected.name,
      slug: selected.slug,
      canEdit: selected.organizationRole !== "viewer",
      canManage: selected.organizationRole === "owner",
    };
    content =
      view === "assets" ? (
        <AssetDashboard
          key={selected.id}
          workspace={workspace}
          search={searchQuery}
          assetId={assetId}
          prefix={prefix}
          fromPrefix={fromPrefix}
        />
      ) : view === "vards" ? (
        vardId ? (
          <VardEditor key={vardId} workspace={workspace} vardId={vardId} />
        ) : (
          <VardsPage key={selected.id} workspace={workspace} />
        )
      ) : view === "usage" ? (
        <UsagePage key={selected.id} workspace={workspace} />
      ) : view === "activity" ? (
        <AuditLog key={selected.id} workspace={workspace} />
      ) : view === "settings" ? (
        <WorkspaceSettings key={selected.id} workspace={workspace} />
      ) : (
        <WorkspaceOverview key={selected.id} workspace={workspace} />
      );
  } else
    content = (
      <Shell crumbs={[{ label: "Workspaces" }]}>
        <Empty variant="outline">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Building2Icon />
            </EmptyMedia>
            <EmptyTitle>No workspaces yet</EmptyTitle>
            <EmptyDescription>
              {selectedOrganization?.canCreateWorkspace
                ? "Create a workspace to start uploading assets."
                : selectedOrganization
                  ? "Ask an organization owner to create a workspace."
                  : "Ask an organization owner for an invitation."}
            </EmptyDescription>
          </EmptyHeader>
          {selectedOrganization?.canCreateWorkspace && (
            <EmptyContent>
              <Button
                nativeButton={false}
                render={
                  <Link
                    to="/organizations/$organizationId/settings"
                    params={{ organizationId: selectedOrganization.id }}
                    search={{ tab: "workspaces", create: true }}
                  />
                }
              >
                New workspace
              </Button>
            </EmptyContent>
          )}
        </Empty>
      </Shell>
    );

  return (
    <SidebarProvider>
      <CommandMenuProvider
        workspaceId={selected?.id}
        organizationId={selectedOrganization?.id}
        workspaces={allWorkspaces.map((workspace) => ({
          id: workspace.id,
          name: workspace.name,
          organizationName: workspace.organizationName,
        }))}
      >
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-primary-foreground"
        >
          Skip to content
        </a>
        <AppSidebar
          organizations={organizations}
          workspace={selected}
          organization={selectedOrganization}
          user={{ name, email }}
          onSignOut={() => void signOut()}
        />
        <SidebarInset>{content}</SidebarInset>
      </CommandMenuProvider>
    </SidebarProvider>
  );
}

function Shell({
  crumbs,
  children,
}: {
  crumbs: Array<{ label: string }>;
  children: ReactNode;
}) {
  return (
    <>
      <AppHeader crumbs={crumbs} />
      <Page id="main">
        {children}
      </Page>
    </>
  );
}

function CreateFirstOrganization() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setError("");
    setPending(true);
    try {
      const form = new FormData(event.currentTarget);
      const result = await authClient.organization.create({
        name: String(form.get("name")),
        slug: String(form.get("slug")),
      });
      if (result.error) {
        setError(result.error.message ?? "Organization creation failed");
        return;
      }
      await queryClient.invalidateQueries({ queryKey: ["organizations"] });
      await navigate({
        to: "/organizations/$organizationId/settings",
        params: { organizationId: result.data.id },
        search: { tab: "workspaces", create: true },
      });
    } catch (cause) {
      setError(errorMessage(cause, "Organization creation failed"));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-md">
      <Card>
        <CardHeader>
          <CardTitle>Create an organization</CardTitle>
          <CardDescription>
            Organizations hold your workspaces and team.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit}>
            <FieldGroup>
              <NameSlugFields autoFocus />
              {error && <FieldError>{error}</FieldError>}
              <Button type="submit" disabled={pending}>
                {pending && <Spinner data-icon="inline-start" />}
                Create organization
              </Button>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
