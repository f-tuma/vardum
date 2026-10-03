import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
} from "@tanstack/react-router";
import { lazy, StrictMode, Suspense } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AcceptInvitation } from "./accept-invitation";
import { App } from "./app";
import { CliLogin } from "./cli-login";
import { ResetPassword } from "./reset-password";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "next-themes";
import "./index.css";

const rootRoute = createRootRoute({ component: Outlet });
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: App,
});
// The client's home when the apex belongs to a marketing site. `/` renders the
// same thing on a self-host, where nothing else claims it.
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/app",
  component: App,
});
const resetPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/reset-password",
  validateSearch: (search: Record<string, unknown>) => ({
    token: typeof search.token === "string" ? search.token : "",
    error: typeof search.error === "string" ? search.error : "",
  }),
  component: ResetPasswordPage,
});
const acceptInvitationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/accept-invitation",
  validateSearch: (search: Record<string, unknown>) => ({
    id: typeof search.id === "string" ? search.id : "",
  }),
  component: AcceptInvitationPage,
});
const cliLoginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/cli-login",
  validateSearch: (search: Record<string, unknown>) => ({
    callback: typeof search.callback === "string" ? search.callback : "",
    state: typeof search.state === "string" ? search.state : "",
    label: typeof search.label === "string" ? search.label : "cli",
    workspace: typeof search.workspace === "string" ? search.workspace : "",
  }),
  component: CliLoginPage,
});
const accountRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/account",
  component: AccountPage,
});
const organizationSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/organizations/$organizationId/settings",
  validateSearch: (
    search: Record<string, unknown>,
  ): { tab?: string; create?: boolean } => ({
    ...(typeof search.tab === "string" && search.tab
      ? { tab: search.tab }
      : {}),
    ...(search.create === true ? { create: true } : {}),
  }),
  component: OrganizationSettingsPage,
});
const workspaceOverviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/workspaces/$workspaceId",
  component: WorkspaceOverviewPage,
});
const workspaceVardsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/workspaces/$workspaceId/vards",
  component: WorkspaceVardsPage,
});
const vardEditorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/workspaces/$workspaceId/vards/$vardId",
  component: VardEditorPage,
});
const workspaceActivityRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/workspaces/$workspaceId/activity",
  component: WorkspaceActivityPage,
});
const workspaceAuditRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/workspaces/$workspaceId/audit",
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/workspaces/$workspaceId/activity",
      params: { workspaceId: params.workspaceId },
      replace: true,
    });
  },
});
const workspaceSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/workspaces/$workspaceId/settings",
  validateSearch: (search: Record<string, unknown>): { tab?: string } =>
    typeof search.tab === "string" && search.tab ? { tab: search.tab } : {},
  // Activity used to be a settings tab; old links still land on it.
  beforeLoad: ({ params, search }) => {
    if (search.tab === "activity")
      throw redirect({
        to: "/workspaces/$workspaceId/activity",
        params: { workspaceId: params.workspaceId },
        replace: true,
      });
  },
  component: WorkspaceSettingsPage,
});
const workspaceAssetsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/workspaces/$workspaceId/assets",
  validateSearch: (
    search: Record<string, unknown>,
  ): { prefix: string; q?: string } => ({
    ...(typeof search.q === "string" && search.q ? { q: search.q } : {}),
    prefix: typeof search.prefix === "string" ? search.prefix : "",
  }),
  component: WorkspaceAssetsPage,
});
const assetRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/workspaces/$workspaceId/assets/$assetId",
  validateSearch: (
    search: Record<string, unknown>,
  ): { from: string; q?: string } => ({
    ...(typeof search.q === "string" && search.q ? { q: search.q } : {}),
    from: typeof search.from === "string" ? search.from : "",
  }),
  component: AssetPage,
});
const router = createRouter({
  routeTree: rootRoute.addChildren([
    indexRoute,
    appRoute,
    resetPasswordRoute,
    acceptInvitationRoute,
    cliLoginRoute,
    accountRoute,
    organizationSettingsRoute,
    workspaceOverviewRoute,
    workspaceVardsRoute,
    vardEditorRoute,
    workspaceActivityRoute,
    workspaceAuditRoute,
    workspaceSettingsRoute,
    workspaceAssetsRoute,
    assetRoute,
  ]),
});
const queryClient = new QueryClient();
const DevAgentation = import.meta.env.DEV
  ? lazy(() =>
      import("agentation").then(({ Agentation }) => ({ default: Agentation })),
    )
  : null;

function ResetPasswordPage() {
  const { token, error } = resetPasswordRoute.useSearch();
  return <ResetPassword token={token} callbackError={error} />;
}

function AcceptInvitationPage() {
  const { id } = acceptInvitationRoute.useSearch();
  return <AcceptInvitation invitationId={id} />;
}

function CliLoginPage() {
  const { callback, state, label, workspace } = cliLoginRoute.useSearch();
  return <CliLogin callback={callback} state={state} label={label} requestedWorkspace={workspace} />;
}

function AccountPage() {
  return <App view="account" />;
}

function OrganizationSettingsPage() {
  const { organizationId } = organizationSettingsRoute.useParams();
  return <App routeOrganizationId={organizationId} view="organization" />;
}

function WorkspaceOverviewPage() {
  const { workspaceId } = workspaceOverviewRoute.useParams();
  return <App routeWorkspaceId={workspaceId} view="overview" />;
}

function WorkspaceVardsPage() {
  const { workspaceId } = workspaceVardsRoute.useParams();
  return <App routeWorkspaceId={workspaceId} view="vards" />;
}

function VardEditorPage() {
  const { workspaceId, vardId } = vardEditorRoute.useParams();
  return <App routeWorkspaceId={workspaceId} vardId={vardId} view="vards" />;
}

function WorkspaceActivityPage() {
  const { workspaceId } = workspaceActivityRoute.useParams();
  return <App routeWorkspaceId={workspaceId} view="activity" />;
}

function WorkspaceSettingsPage() {
  const { workspaceId } = workspaceSettingsRoute.useParams();
  return <App routeWorkspaceId={workspaceId} view="settings" />;
}

function WorkspaceAssetsPage() {
  const { workspaceId } = workspaceAssetsRoute.useParams();
  const { prefix, q } = workspaceAssetsRoute.useSearch();
  return (
    <App
      routeWorkspaceId={workspaceId}
      prefix={prefix}
      searchQuery={q}
      view="assets"
    />
  );
}

function AssetPage() {
  const { workspaceId, assetId } = assetRoute.useParams();
  const { from, q } = assetRoute.useSearch();
  return (
    <App
      routeWorkspaceId={workspaceId}
      assetId={assetId}
      prefix={from}
      searchQuery={q}
      view="assets"
    />
  );
}

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

// Route edits can reload this entry module during development. Reuse the root
// so hot reload does not mount competing React trees into the same container.
const reactRoot =
  (import.meta.hot?.data.reactRoot as Root | undefined) ??
  createRoot(document.getElementById("root")!);
if (import.meta.hot) import.meta.hot.data.reactRoot = reactRoot;

reactRoot.render(
  <StrictMode>
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <RouterProvider router={router} />
          <Toaster richColors closeButton />
        </TooltipProvider>
        {DevAgentation && (
          <Suspense fallback={null}>
            <DevAgentation />
          </Suspense>
        )}
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
