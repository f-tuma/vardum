import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { createCliKey, getOrganizationDirectory } from "./asset-api";
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

  return (
    <main className="auth-shell">
      <section className="auth-panel">
        <div className="auth-brand">
          <span aria-hidden="true">╂</span> VARDUM
        </div>
        <h1>Authorize the CLI</h1>
        {!target ? (
          <p role="alert">
            This link does not come from a CLI running on your machine, so it
            cannot be authorized. Start over with <code>vardum login</code>.
          </p>
        ) : session.isPending ? (
          <p className="muted">Checking your account…</p>
        ) : !session.data ? (
          <p className="muted">
            Sign in first, then run <code>vardum login</code> again.
          </p>
        ) : status ? (
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
              <div className="settings-url">
                <span>SENDS THE KEY TO</span>
                <code>{target.origin}</code>
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
