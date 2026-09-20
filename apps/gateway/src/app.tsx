import { NameSlugFields } from "./name-slug-fields";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import { AccountSettings } from "./account-settings";
import { getOrganizationDirectory } from "./asset-api";
import { AssetDashboard } from "./asset-dashboard";
import { AuthForm } from "./auth-form";
import { authClient } from "./auth-client";
import { OrganizationSettings } from "./organization-settings";
import { OrganizationVerification } from "./organization-verification";
import { VardEditor, VardsPage } from "./vards";
import { WorkspaceOverview } from "./workspace-overview";
import { WorkspaceSettings } from "./workspace-settings";

type View =
  "overview" | "assets" | "vards" | "settings" | "organization" | "account";

export function App({
  routeWorkspaceId,
  routeOrganizationId,
  assetId,
  vardId,
  prefix = "",
  searchQuery = "",
  view = "overview",
}: {
  routeWorkspaceId?: string;
  routeOrganizationId?: string;
  assetId?: string;
  vardId?: string;
  prefix?: string;
  searchQuery?: string;
  view?: View;
}) {
  const session = authClient.useSession();
  if (session.isPending) return <div className="loading">Loading…</div>;
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
  searchQuery: string;
  view: View;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const searchRef = useRef<HTMLInputElement>(null);
  const [selectedId, setSelectedId] = useState(routeWorkspaceId ?? "");
  const [selectedOrganizationId, setSelectedOrganizationId] = useState("");
  const search = searchQuery;
  function setSearch(value: string) {
    if (!routeWorkspaceId || view !== "assets" || assetId) return;
    void navigate({
      to: "/workspaces/$workspaceId/assets",
      params: { workspaceId: routeWorkspaceId },
      search: { prefix, ...(value ? { q: value } : {}) },
      replace: true,
    });
  }
  const [error, setError] = useState("");
  const [organizationPending, setOrganizationPending] = useState(false);
  const directory = useQuery({
    queryKey: ["organizations"],
    queryFn: getOrganizationDirectory,
  });
  const organizations = directory.data?.organizations ?? [];
  const allWorkspaces = organizations.flatMap((organization) =>
    organization.workspaces.map((workspace) => ({
      ...workspace,
      organizationId: organization.id,
      organizationRole: organization.role,
    })),
  );
  const routeWorkspace = allWorkspaces.find(
    (workspace) => workspace.id === routeWorkspaceId,
  );
  const preferredOrganizationId =
    routeOrganizationId ||
    routeWorkspace?.organizationId ||
    selectedOrganizationId;
  const selected =
    routeWorkspace ??
    allWorkspaces.find(
      (workspace) =>
        workspace.id === selectedId &&
        workspace.organizationId === preferredOrganizationId,
    ) ??
    allWorkspaces.find(
      (workspace) => workspace.organizationId === preferredOrganizationId,
    ) ??
    (preferredOrganizationId ? undefined : allWorkspaces[0]);
  const selectedOrganization =
    organizations.find(
      (organization) => organization.id === preferredOrganizationId,
    ) ?? organizations[0];

  useEffect(() => {
    if (selected) {
      setSelectedId(selected.id);
      setSelectedOrganizationId(selected.organizationId);
    }
    if (
      view !== "account" &&
      view !== "organization" &&
      !routeWorkspaceId &&
      selected
    ) {
      void navigate({
        to: "/workspaces/$workspaceId",
        params: { workspaceId: selected.id },
      });
    }
  }, [
    navigate,
    routeWorkspaceId,
    routeOrganizationId,
    selected?.id,
    selected?.organizationId,
    view,
  ]);

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "k" &&
        selected
      ) {
        event.preventDefault();
        if (view === "assets" && !assetId) searchRef.current?.focus();
        else {
          void navigate({
            to: "/workspaces/$workspaceId/assets",
            params: { workspaceId: selected.id },
            search: { prefix: "" },
          }).then(() => {
            requestAnimationFrame(() =>
              document.getElementById("asset-search")?.focus(),
            );
          });
        }
      }
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, [selected?.id, view, assetId, navigate]);

  async function signOut() {
    await authClient.signOut();
    queryClient.clear();
  }

  async function createOrganization(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (organizationPending) return;
    setOrganizationPending(true);
    try {
      const formElement = event.currentTarget;
      const form = new FormData(formElement);
      const result = await authClient.organization.create({
        name: String(form.get("name")),
        slug: String(form.get("slug")),
      });
      if (result.error) {
        setError(result.error.message ?? "Organization creation failed");
        return;
      }
      setSelectedOrganizationId(result.data.id);
      formElement.reset();
      await queryClient.invalidateQueries({ queryKey: ["organizations"] });
      await navigate({
        to: "/organizations/$organizationId/settings",
        params: { organizationId: result.data.id },
      });
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Organization creation failed",
      );
    } finally {
      setOrganizationPending(false);
    }
  }

  return (
    <div className="app-shell">
      <a
        className="skip-link"
        href={
          view === "assets"
            ? "#assets"
            : view === "vards"
              ? vardId
                ? "#vard-editor"
                : "#vards"
              : view === "settings"
                ? "#settings"
                : view === "organization"
                  ? "#organization-settings"
                  : view === "account"
                    ? "#account"
                    : "#overview"
        }
      >
        Skip to content
      </a>
      <aside className="sidebar">
        <a
          className="brand"
          href={
            selected ? `/workspaces/${encodeURIComponent(selected.id)}` : "/"
          }
        >
          <span aria-hidden="true">╂</span> VARDUM
        </a>

        {allWorkspaces.length ? (
          <div className="workspace-control">
            <small>WORKSPACE</small>
            <select
              id="workspace-select"
              aria-label="Workspace"
              value={selected?.id ?? ""}
              onChange={(event) => {
                const workspace = allWorkspaces.find(
                  ({ id }) => id === event.target.value,
                );
                if (!workspace) return;
                setSelectedId(workspace.id);
                setSelectedOrganizationId(workspace.organizationId);
                void navigate({
                  to: "/workspaces/$workspaceId",
                  params: { workspaceId: workspace.id },
                });
              }}
            >
              {allWorkspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {organizations.length > 1
                    ? `${organizations.find(({ id }) => id === workspace.organizationId)?.name} / ${workspace.name}`
                    : workspace.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        {selected && (
          <nav className="sidebar-nav" aria-label="Workspace">
            <Link
              to="/workspaces/$workspaceId"
              params={{ workspaceId: selected.id }}
              activeOptions={{ exact: true }}
              activeProps={{ className: "active" }}
            >
              <span>01</span> Overview
            </Link>
            <Link
              to="/workspaces/$workspaceId/assets"
              params={{ workspaceId: selected.id }}
              search={{ prefix: "" }}
              activeOptions={{ includeSearch: false }}
              activeProps={{ className: "active" }}
            >
              <span>02</span> Assets
            </Link>
            <Link
              to="/workspaces/$workspaceId/vards"
              params={{ workspaceId: selected.id }}
              activeProps={{ className: "active" }}
            >
              <span>03</span> Vards
            </Link>
            <Link
              to="/workspaces/$workspaceId/settings"
              params={{ workspaceId: selected.id }}
              activeProps={{ className: "active" }}
            >
              <span>04</span> Settings
            </Link>
            {selectedOrganization && (
              <Link
                to="/organizations/$organizationId/settings"
                params={{ organizationId: selectedOrganization.id }}
                activeProps={{ className: "active" }}
              >
                <span>05</span> Organization
              </Link>
            )}
          </nav>
        )}

        <div className="sidebar-spacer" />
        <div className="user-card">
          <Link
            className="user-account-link"
            to="/account"
            activeProps={{ className: "active" }}
          >
            <span className="avatar">{name.slice(0, 2).toUpperCase()}</span>
            <span>
              <strong>{name}</strong>
              <small>{email}</small>
            </span>
          </Link>
          <button className="icon-button" type="button" onClick={signOut}>
            Sign out
          </button>
        </div>
      </aside>

      <div className="workspace-view">
        <header className="topbar">
          <p className="topbar-context">
            {view === "account"
              ? "account :: settings"
              : view === "organization"
                ? `${selectedOrganization?.slug ?? "organization"} :: organization`
                : selected
                  ? `${selected.slug} :: ${view}`
                  : `workspace :: ${view}`}
          </p>
          {view === "assets" && !assetId && (
            <label className="command-search">
              <span aria-hidden="true">⌕</span>
              <input
                ref={searchRef}
                id="asset-search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setSearch("");
                }}
                placeholder="Search the whole workspace"
                aria-label="Search assets"
                disabled={!selected}
              />
              {search ? (
                <button
                  type="button"
                  className="search-clear"
                  aria-label="Clear asset search"
                  onClick={() => {
                    setSearch("");
                    searchRef.current?.focus();
                  }}
                >
                  ×
                </button>
              ) : (
                <kbd>Ctrl / ⌘ K</kbd>
              )}
            </label>
          )}
          {selected && (view !== "assets" || assetId) && (
            <Link
              className="global-search-link"
              to="/workspaces/$workspaceId/assets"
              params={{ workspaceId: selected.id }}
              search={{ prefix: "" }}
              onClick={(event) => {
                event.preventDefault();
                void navigate({
                  to: "/workspaces/$workspaceId/assets",
                  params: { workspaceId: selected.id },
                  search: { prefix: "" },
                }).then(() => {
                  requestAnimationFrame(() =>
                    document.getElementById("asset-search")?.focus(),
                  );
                });
              }}
            >
              ⌕ Find assets <kbd>Ctrl / ⌘ K</kbd>
            </Link>
          )}
        </header>

        {view === "account" ? (
          <AccountSettings />
        ) : directory.isPending ? (
          <div className="loading">Loading workspaces…</div>
        ) : directory.isError ? (
          <div className="state-panel" role="alert">
            {directory.error.message}
          </div>
        ) : (routeWorkspaceId && !routeWorkspace) ||
          (routeOrganizationId &&
            !organizations.some(({ id }) => id === routeOrganizationId)) ? (
          <div className="state-panel" role="alert">
            This workspace or organization is unavailable.{" "}
            <Link to="/app">Back to your workspaces</Link>
          </div>
        ) : !organizations.length &&
          directory.data?.organizationCreation?.status ===
            "email_verification_required" ? (
          <div className="empty-workspace">
            <OrganizationVerification
              emailEnabled={
                directory.data.organizationCreation.verificationEmailEnabled
              }
            />
          </div>
        ) : !organizations.length && directory.data?.canCreateOrganization ? (
          <div className="empty-workspace">
            <h1>Create an organization</h1>
            <p>Organizations own members, roles, and workspaces.</p>
            <form onSubmit={createOrganization}>
              <NameSlugFields />
              {error && <p role="alert">{error}</p>}
              <button className="primary-button" disabled={organizationPending}>
                {organizationPending ? "Creating…" : "Create organization"}
              </button>
            </form>
          </div>
        ) : view === "organization" && selectedOrganization ? (
          <OrganizationSettings
            key={selectedOrganization.id}
            organizationId={selectedOrganization.id}
          />
        ) : selected ? (
          view === "overview" ? (
            <WorkspaceOverview
              key={selected.id}
              workspaceId={selected.id}
              workspaceSlug={selected.slug}
              workspaceName={selected.name}
            />
          ) : view === "vards" ? (
            vardId ? (
              <VardEditor
                workspaceId={selected.id}
                workspaceName={selected.name}
                vardId={vardId}
                canEdit={selected.organizationRole !== "viewer"}
              />
            ) : (
              <VardsPage
                key={selected.id}
                workspaceId={selected.id}
                workspaceName={selected.name}
                canEdit={selected.organizationRole !== "viewer"}
              />
            )
          ) : view === "settings" ? (
            <WorkspaceSettings
              key={selected.id}
              workspaceId={selected.id}
              workspaceSlug={selected.slug}
              workspaceName={selected.name}
            />
          ) : (
            <AssetDashboard
              key={selected.id}
              canPublish={selected.organizationRole !== "viewer"}
              workspaceId={selected.id}
              workspaceSlug={selected.slug}
              workspaceName={selected.name}
              search={search}
              onClearSearch={() => setSearch("")}
              assetId={routeWorkspaceId === selected.id ? assetId : undefined}
              prefix={prefix}
            />
          )
        ) : selectedOrganization ? (
          <div className="state-panel">
            This organization has no workspaces.{" "}
            <Link
              to="/organizations/$organizationId/settings"
              params={{ organizationId: selectedOrganization.id }}
            >
              Open organization settings
            </Link>
            .
          </div>
        ) : (
          <div className="state-panel">
            You do not belong to an organization. Ask an owner for an
            invitation.
          </div>
        )}
      </div>
    </div>
  );
}
