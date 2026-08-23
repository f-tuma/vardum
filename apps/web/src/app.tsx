import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import { AccountSettings } from "./account-settings";
import { getOrganizationDirectory } from "./asset-api";
import { AssetDashboard } from "./asset-dashboard";
import { AuditLog } from "./audit-log";
import { authClient } from "./auth-client";
import { OrganizationSettings } from "./organization-settings";
import { VardEditor, VardsPage } from "./vards";
import { WorkspaceOverview } from "./workspace-overview";
import { WorkspaceSettings } from "./workspace-settings";

type View =
  | "overview"
  | "assets"
  | "vards"
  | "audit"
  | "settings"
  | "organization"
  | "account";

export function App({
  routeWorkspaceId,
  routeOrganizationId,
  assetId,
  vardId,
  prefix = "",
  view = "overview",
}: {
  routeWorkspaceId?: string;
  routeOrganizationId?: string;
  assetId?: string;
  vardId?: string;
  prefix?: string;
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
  view,
}: {
  email: string;
  name: string;
  routeWorkspaceId?: string;
  routeOrganizationId?: string;
  assetId?: string;
  vardId?: string;
  prefix: string;
  view: View;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const searchRef = useRef<HTMLInputElement>(null);
  const [selectedId, setSelectedId] = useState(routeWorkspaceId ?? "");
  const [selectedOrganizationId, setSelectedOrganizationId] = useState("");
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
      organizationRole: organization.role,
    })),
  );
  const routeWorkspace = allWorkspaces.find(
    (workspace) => workspace.id === routeWorkspaceId,
  );
  const preferredOrganizationId =
    routeOrganizationId ||
    selectedOrganizationId ||
    routeWorkspace?.organizationId;
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
    formElement.reset();
    await queryClient.invalidateQueries({ queryKey: ["organizations"] });
    await navigate({
      to: "/organizations/$organizationId/settings",
      params: { organizationId: result.data.id },
    });
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
                : view === "audit"
                  ? "#audit"
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
                setSearch("");
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
          {view === "assets" && (
            <label className="command-search">
              <span aria-hidden="true">⌕</span>
              <input
                ref={searchRef}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search the whole workspace"
                aria-label="Search assets"
                disabled={!selected}
              />
              <kbd>⌘K</kbd>
            </label>
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
        ) : !organizations.length && directory.data?.canCreateOrganization ? (
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
        ) : view === "organization" && selectedOrganization ? (
          <OrganizationSettings organizationId={selectedOrganization.id} />
        ) : selected ? (
          view === "overview" ? (
            <WorkspaceOverview
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
                workspaceId={selected.id}
                workspaceName={selected.name}
                canEdit={selected.organizationRole !== "viewer"}
              />
            )
          ) : view === "audit" ? (
            <AuditLog workspaceId={selected.id} workspaceName={selected.name} />
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
