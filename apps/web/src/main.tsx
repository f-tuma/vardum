import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { AcceptInvitation } from "./accept-invitation";
import { App } from "./app";
import { ResetPassword } from "./reset-password";
import "./style.css";

const rootRoute = createRootRoute({ component: Outlet });
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
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
const accountRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/account",
  component: AccountPage,
});
const organizationSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/organizations/$organizationId/settings",
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
const workspaceSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/workspaces/$workspaceId/settings",
  component: WorkspaceSettingsPage,
});
const workspaceAssetsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/workspaces/$workspaceId/assets",
  validateSearch: (search: Record<string, unknown>) => ({
    prefix: typeof search.prefix === "string" ? search.prefix : "",
  }),
  component: WorkspaceAssetsPage,
});
const assetRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/workspaces/$workspaceId/assets/$assetId",
  validateSearch: (search: Record<string, unknown>) => ({
    from: typeof search.from === "string" ? search.from : "",
  }),
  component: AssetPage,
});
const router = createRouter({
  routeTree: rootRoute.addChildren([
    indexRoute,
    resetPasswordRoute,
    acceptInvitationRoute,
    accountRoute,
    organizationSettingsRoute,
    workspaceOverviewRoute,
    workspaceVardsRoute,
    vardEditorRoute,
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

function WorkspaceSettingsPage() {
  const { workspaceId } = workspaceSettingsRoute.useParams();
  return <App routeWorkspaceId={workspaceId} view="settings" />;
}

function WorkspaceAssetsPage() {
  const { workspaceId } = workspaceAssetsRoute.useParams();
  const { prefix } = workspaceAssetsRoute.useSearch();
  return <App routeWorkspaceId={workspaceId} prefix={prefix} view="assets" />;
}

function AssetPage() {
  const { workspaceId, assetId } = assetRoute.useParams();
  const { from } = assetRoute.useSearch();
  return (
    <App
      routeWorkspaceId={workspaceId}
      assetId={assetId}
      prefix={from}
      view="assets"
    />
  );
}

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      {DevAgentation && (
        <Suspense fallback={null}>
          <DevAgentation />
        </Suspense>
      )}
    </QueryClientProvider>
  </StrictMode>,
);
