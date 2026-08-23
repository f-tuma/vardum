import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { createCliKey, getOrganizationDirectory } from "./asset-api";
import { AuthForm } from "./auth-form";
import { authClient } from "./auth-client";
import { loopbackCallback } from "./loopback";

export function CliLogin({
  callback,
  state,
  label,
}: {
  callback: string;
  state: string;
  label: string;
}) {
  const session = authClient.useSession();
  const target = loopbackCallback(callback);
  const [workspaceId, setWorkspaceId] = useState("");
  const [access, setAccess] = useState<"read" | "write">("write");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const directory = useQuery({
    queryKey: ["organizations"],
    queryFn: getOrganizationDirectory,
    enabled: Boolean(session.data),
  });
  const workspaces =
    directory.data?.organizations.flatMap((organization) =>
      organization.workspaces.map((workspace) => ({
        ...workspace,
        organizationName: organization.name,
      })),
    ) ?? [];
  const selected = workspaceId || workspaces[0]?.id || "";

  async function authorize() {
    if (!target || !selected) return;
    setPending(true);
    setError("");
    try {
      const created = await createCliKey(selected, { label, access });
      const response = await fetch(target, {
        method: "POST",
        // text/plain keeps this a simple request: no preflight to the CLI's
        // throwaway listener, which only knows how to answer one POST.
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ state, key: created.key, workspace: selected }),
      });
      if (!response.ok) throw new Error("The CLI refused the key");
      setStatus("Authorized. You can close this tab and return to the CLI.");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? `${cause.message}. Is vardum login still running?`
          : "Authorization failed",
      );
      setPending(false);
    }
  }

  if (!target)
    return (
      <main className="auth-shell">
        <section className="auth-panel">
          <div className="auth-brand">
            <span aria-hidden="true">╂</span> VARDUM
          </div>
          <h1>Authorize the CLI</h1>
          <p role="alert">
            This link does not come from a CLI running on your machine, so it
            cannot be authorized. Start over with <code>vardum login</code>.
          </p>
        </section>
      </main>
    );
  // No session yet: let the user sign in right here. better-auth's useSession
  // is reactive, so this component re-renders into the authorize form below
  // the moment the sign-in succeeds — same tab, same callback/state.
  if (session.isPending)
    return (
      <main className="auth-shell">
        <section className="auth-panel">
          <div className="auth-brand">
            <span aria-hidden="true">╂</span> VARDUM
          </div>
          <h1>Authorize the CLI</h1>
          <p className="muted">Checking your account…</p>
        </section>
      </main>
    );
  if (!session.data) return <AuthForm />;

  return (
    <main className="auth-shell">
      <section className="auth-panel">
        <div className="auth-brand">
          <span aria-hidden="true">╂</span> VARDUM
        </div>
        <h1>Authorize the CLI</h1>
        {status ? (
          <p className="auth-status" role="status">
            {status}
          </p>
        ) : (
          <>
            <p className="muted">
              <code>{label}</code> is asking for a key as{" "}
              {session.data.user.email}. It will be able to do what your role
              allows, and nothing more.
            </p>
            <form onSubmit={(event) => event.preventDefault()}>
              <label>
                Workspace
                <select
                  value={selected}
                  onChange={(event) => setWorkspaceId(event.target.value)}
                >
                  {workspaces.map((workspace) => (
                    <option key={workspace.id} value={workspace.id}>
                      {workspace.organizationName} / {workspace.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Access
                <select
                  value={access}
                  onChange={(event) =>
                    setAccess(event.target.value as "read" | "write")
                  }
                >
                  <option value="write">Pull and push</option>
                  <option value="read">Pull only</option>
                </select>
              </label>
              <div className="auth-url">
                <code>{target.origin}</code> will receive the key
              </div>
              {error && (
                <p className="error-strip" role="alert">
                  {error}
                </p>
              )}
              <button
                className="primary-button"
                type="button"
                disabled={pending || !selected}
                onClick={() => void authorize()}
              >
                {pending ? "Authorizing…" : "Authorize"}
              </button>
            </form>
          </>
        )}
      </section>
    </main>
  );
}
