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
import { App } from "./app";
import "./style.css";

const rootRoute = createRootRoute({ component: Outlet });
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: App,
});
const workspaceOverviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/workspaces/$workspaceId",
  component: WorkspaceOverviewPage,
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
    workspaceOverviewRoute,
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

function WorkspaceOverviewPage() {
  const { workspaceId } = workspaceOverviewRoute.useParams();
  return <App routeWorkspaceId={workspaceId} view="overview" />;
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
