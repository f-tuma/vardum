import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import { AccountSettings } from "./account-settings";
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
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const organizations = useQuery({
    queryKey: ["organizations"],
    queryFn: async () => {
      const result = await authClient.organization.list();
      if (result.error) throw new Error(result.error.message);
      return result.data ?? [];
    },
  });
  const selected =
    organizations.data?.find(
      (organization) => organization.id === selectedId,
    ) ?? organizations.data?.[0];

  useEffect(() => {
    if (view !== "account" && !routeWorkspaceId && selected) {
      void navigate({
        to: "/workspaces/$workspaceId",
        params: { workspaceId: selected.id },
      });
    }
  }, [navigate, routeWorkspaceId, selected, view]);

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

  async function createWorkspace(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const result = await authClient.organization.create({
      name: String(form.get("name")),
      slug: String(form.get("slug")),
    });
    if (result.error) {
      setError(result.error.message ?? "Workspace creation failed");
      return;
    }
    setSelectedId(result.data.id);
    formElement.reset();
    await queryClient.invalidateQueries({ queryKey: ["organizations"] });
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

        {organizations.data?.length ? (
          <div className="workspace-control">
            <select
              id="workspace-select"
              aria-label="Workspace"
              value={selected?.id ?? ""}
              onChange={(event) => {
                const workspaceId = event.target.value;
                setSelectedId(workspaceId);
                setSearch("");
                void navigate({
                  to: "/workspaces/$workspaceId",
                  params: { workspaceId },
                });
              }}
            >
              {organizations.data.map((organization) => (
                <option key={organization.id} value={organization.id}>
                  {organization.name}
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
        ) : organizations.isPending ? (
          <div className="loading">Loading workspaces…</div>
        ) : organizations.isError ? (
          <div className="state-panel" role="alert">
            {organizations.error.message}
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
          <div className="empty-workspace">
            <h1>Create a workspace</h1>
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
              <button className="primary-button">Create</button>
            </form>
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
