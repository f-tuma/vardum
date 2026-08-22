import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import { AccountSettings } from "./account-settings";
import {
  createOrganizationWorkspace,
  getOrganizationDirectory,
} from "./asset-api";
import { AssetDashboard } from "./asset-dashboard";
import { authClient } from "./auth-client";
import { WorkspaceOverview } from "./workspace-overview";
import { WorkspaceSettings } from "./workspace-settings";

export function App({
  routeWorkspaceId,
  assetId,
  prefix = "",
  view = "overview",
}: {
  routeWorkspaceId?: string;
  assetId?: string;
  prefix?: string;
  view?: "overview" | "assets" | "settings" | "account";
}) {
  const session = authClient.useSession();
  if (session.isPending) return <div className="loading">Loading…</div>;
  if (!session.data) return <AuthForm />;
  return (
    <WorkspaceApp
      email={session.data.user.email}
      name={session.data.user.name}
      routeWorkspaceId={routeWorkspaceId}
      assetId={assetId}
      prefix={prefix}
      view={view}
    />
  );
}

function WorkspaceApp({
  email,
  name,
  routeWorkspaceId,
  assetId,
  prefix,
  view,
}: {
  email: string;
  name: string;
  routeWorkspaceId?: string;
  assetId?: string;
  prefix: string;
  view: "overview" | "assets" | "settings" | "account";
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const searchRef = useRef<HTMLInputElement>(null);
  const [selectedId, setSelectedId] = useState(routeWorkspaceId ?? "");
  const [selectedOrganizationId, setSelectedOrganizationId] = useState("");
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);
  const [creatingOrganization, setCreatingOrganization] = useState(false);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const directory = useQuery({
    queryKey: ["organizations"],
    queryFn: getOrganizationDirectory,
  });
  const organizations = directory.data?.organizations ?? [];
  const allWorkspaces = organizations.flatMap((organization) =>
    organization.workspaces.map((workspace) => ({
      ...workspace,
      organizationId: organization.id,
    })),
  );
  const routeWorkspace = allWorkspaces.find(
    (workspace) => workspace.id === routeWorkspaceId,
  );
  const preferredOrganizationId =
    selectedOrganizationId || routeWorkspace?.organizationId;
  const selected =
    allWorkspaces.find(
      (workspace) =>
        workspace.id === selectedId &&
        workspace.organizationId === preferredOrganizationId,
    ) ??
    (routeWorkspace?.organizationId === preferredOrganizationId
      ? routeWorkspace
      : undefined) ??
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
    if (view !== "account" && !routeWorkspaceId && selected) {
      void navigate({
        to: "/workspaces/$workspaceId",
        params: { workspaceId: selected.id },
      });
    }
  }, [
    navigate,
    routeWorkspaceId,
    selected?.id,
    selected?.organizationId,
    view,
  ]);

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

  async function signOut() {
    await authClient.signOut();
    queryClient.clear();
  }

  async function createOrganization(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
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
    setCreatingOrganization(false);
    setCreatingWorkspace(true);
    formElement.reset();
    await queryClient.invalidateQueries({ queryKey: ["organizations"] });
  }

  async function createWorkspace(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedOrganization) return;
    setError("");
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    try {
      const workspace = await createOrganizationWorkspace(
        selectedOrganization.id,
        {
          name: String(form.get("name")),
          slug: String(form.get("slug")),
        },
      );
      setSelectedId(workspace.id);
      setCreatingWorkspace(false);
      formElement.reset();
      await queryClient.invalidateQueries({ queryKey: ["organizations"] });
      await navigate({
        to: "/workspaces/$workspaceId",
        params: { workspaceId: workspace.id },
      });
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Workspace creation failed",
      );
    }
  }

  return (
    <div className="app-shell">
      <a
        className="skip-link"
        href={
          view === "assets"
            ? "#assets"
            : view === "settings"
              ? "#settings"
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

        {organizations.length ? (
          <div className="workspace-control">
            <small>ORGANIZATION</small>
            <select
              aria-label="Organization"
              value={selectedOrganization?.id ?? ""}
              onChange={(event) => {
                const organization = organizations.find(
                  ({ id }) => id === event.target.value,
                );
                if (!organization) return;
                setSelectedOrganizationId(organization.id);
                const workspace = organization.workspaces[0];
                if (workspace) {
                  setSelectedId(workspace.id);
                  setCreatingWorkspace(false);
                  void navigate({
                    to: "/workspaces/$workspaceId",
                    params: { workspaceId: workspace.id },
                  });
                } else {
                  setSelectedId("");
                  setCreatingWorkspace(true);
                }
              }}
            >
              {organizations.map((organization) => (
                <option key={organization.id} value={organization.id}>
                  {organization.name}
                </option>
              ))}
            </select>
            <small>WORKSPACE</small>
            <select
              id="workspace-select"
              aria-label="Workspace"
              value={selected?.id ?? ""}
              disabled={!selectedOrganization?.workspaces.length}
              onChange={(event) => {
                const workspaceId = event.target.value;
                setSelectedId(workspaceId);
                setCreatingWorkspace(false);
                setSearch("");
                void navigate({
                  to: "/workspaces/$workspaceId",
                  params: { workspaceId },
                });
              }}
            >
              {!selectedOrganization?.workspaces.length && (
                <option value="">No workspaces</option>
              )}
              {selectedOrganization?.workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </select>
            {selectedOrganization?.canCreateWorkspace && (
              <button
                className="workspace-create-button"
                type="button"
                onClick={() => {
                  setError("");
                  setCreatingOrganization(false);
                  setCreatingWorkspace(true);
                }}
              >
                + New workspace
              </button>
            )}
            {directory.data?.canCreateOrganization && (
              <button
                className="workspace-create-button"
                type="button"
                onClick={() => {
                  setError("");
                  setCreatingWorkspace(false);
                  setCreatingOrganization(true);
                }}
              >
                + New organization
              </button>
            )}
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
              to="/workspaces/$workspaceId/settings"
              params={{ workspaceId: selected.id }}
              activeProps={{ className: "active" }}
            >
              <span>03</span> Settings
            </Link>
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
          {view === "assets" ? (
            <label className="command-search">
              <span aria-hidden="true">⌕</span>
              <input
                ref={searchRef}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search assets by name or key"
                aria-label="Search assets"
                disabled={!selected}
              />
              <kbd>⌘K</kbd>
            </label>
          ) : (
            <p className="topbar-context">
              {view === "account"
                ? "account :: settings"
                : selected
                  ? `${selected.slug} :: ${view}`
                  : `workspace :: ${view}`}
            </p>
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
        ) : (creatingOrganization || !organizations.length) &&
          directory.data?.canCreateOrganization ? (
          <div className="empty-workspace">
            <h1>Create an organization</h1>
            <p>Organizations own members, roles, and workspaces.</p>
            <form onSubmit={createOrganization}>
              <label>
                Name
                <input name="name" required />
              </label>
              <label>
                Slug
                <input name="slug" pattern="[a-z0-9-]+" required />
              </label>
              {error && <p role="alert">{error}</p>}
              <button className="primary-button">Create organization</button>
            </form>
          </div>
        ) : organizations.length ? (creatingWorkspace || !selected) &&
          selectedOrganization?.canCreateWorkspace ? (
          <div className="empty-workspace">
            <h1>Create a workspace</h1>
            <p>Organization: {selectedOrganization.name}</p>
            <form onSubmit={createWorkspace}>
              <label>
                Name
                <input name="name" required />
              </label>
              <label>
                Slug
                <input name="slug" pattern="[a-z0-9-]+" required />
              </label>
              {error && <p role="alert">{error}</p>}
              <button className="primary-button">Create workspace</button>
            </form>
          </div>
        ) : selected ? (
          view === "overview" ? (
            <WorkspaceOverview
              workspaceId={selected.id}
              workspaceSlug={selected.slug}
              workspaceName={selected.name}
            />
          ) : view === "settings" ? (
            <WorkspaceSettings
              workspaceId={selected.id}
              workspaceSlug={selected.slug}
              workspaceName={selected.name}
            />
          ) : (
            <AssetDashboard
              workspaceId={selected.id}
              workspaceSlug={selected.slug}
              workspaceName={selected.name}
              search={search}
              assetId={routeWorkspaceId === selected.id ? assetId : undefined}
              prefix={prefix}
            />
          )
        ) : (
          <div className="state-panel">This organization has no workspaces.</div>
        ) : (
          <div className="state-panel">
            You do not belong to an organization. Ask an owner for an invitation.
          </div>
        )}
      </div>
    </div>
  );
}

function AuthForm() {
  const [mode, setMode] = useState<"sign-in" | "sign-up" | "forgot">("sign-in");
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    setStatus("");
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email"));
    if (mode === "forgot") {
      const result = await authClient.requestPasswordReset({
        email,
        redirectTo: `${window.location.origin}/reset-password`,
      });
      if (result.error)
        setError(result.error.message ?? "Password reset request failed");
      else
        setStatus("If this email exists, a password reset link has been sent.");
      setPending(false);
      return;
    }

    const password = String(form.get("password"));
    const result =
      mode === "sign-in"
        ? await authClient.signIn.email({ email, password })
        : await authClient.signUp.email({
            email,
            password,
            name: String(form.get("name")),
          });
    if (result.error) {
      setError(result.error.message ?? "Authentication failed");
      setPending(false);
      return;
    }
    const invitation = new URLSearchParams(window.location.search).get(
      "invitation",
    );
    if (invitation) {
      window.location.assign(
        `/accept-invitation?id=${encodeURIComponent(invitation)}`,
      );
      return;
    }
    setPending(false);
  }

  return (
    <main className="auth-shell">
      <section className="auth-panel">
        <div className="auth-brand">
          <span aria-hidden="true">╂</span> VARDUM
        </div>
        <h1>
          {mode === "sign-in"
            ? "Sign in"
            : mode === "sign-up"
              ? "Create account"
              : "Reset password"}
        </h1>
        <p className="muted">
          {mode === "forgot"
            ? "We will send a secure reset link."
            : "Digital assets, one canonical source."}
        </p>
        <form onSubmit={submit}>
          {mode === "sign-up" && (
            <label>
              Name
              <input name="name" required autoComplete="name" />
            </label>
          )}
          <label>
            Email
            <input name="email" type="email" required autoComplete="email" />
          </label>
          {mode !== "forgot" && (
            <label>
              Password
              <input
                name="password"
                type="password"
                minLength={8}
                required
                autoComplete={
                  mode === "sign-in" ? "current-password" : "new-password"
                }
              />
            </label>
          )}
          {error && <p role="alert">{error}</p>}
          {status && (
            <p className="auth-status" role="status">
              {status}
            </p>
          )}
          <button className="primary-button" disabled={pending}>
            {pending
              ? "Please wait…"
              : mode === "sign-in"
                ? "Sign in"
                : mode === "sign-up"
                  ? "Create account"
                  : "Send reset link"}
          </button>
        </form>
        <div className="auth-links">
          {mode === "sign-in" ? (
            <>
              <button
                className="text-button"
                type="button"
                onClick={() => setMode("sign-up")}
              >
                Create an account
              </button>
              <button
                className="text-button"
                type="button"
                onClick={() => setMode("forgot")}
              >
                Forgot password?
              </button>
            </>
          ) : (
            <button
              className="text-button"
              type="button"
              onClick={() => setMode("sign-in")}
            >
              Back to sign in
            </button>
          )}
        </div>
      </section>
    </main>
  );
}
