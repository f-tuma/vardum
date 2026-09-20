import { useState } from "react";
import { acceptWorkspaceInvitation } from "./asset-api";
import { authClient } from "./auth-client";

export function AcceptInvitation({ invitationId }: { invitationId: string }) {
  const session = authClient.useSession();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function accept() {
    if (!invitationId) {
      setError("Invitation link is invalid");
      return;
    }
    setPending(true);
    setError("");
    try {
      const result = await acceptWorkspaceInvitation(invitationId);
      window.location.assign(`/workspaces/${result.workspaceId}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Invitation failed");
      setPending(false);
    }
  }

  async function switchAccount() {
    await authClient.signOut();
    window.location.assign(`/?invitation=${encodeURIComponent(invitationId)}`);
  }

  return (
    <main className="auth-shell">
      <section className="auth-panel">
        <div className="auth-brand">
          <span aria-hidden="true">╂</span> VARDUM
        </div>
        <h1>Workspace invitation</h1>
        {!invitationId ? (
          <>
            <p role="alert">
              This invitation link is incomplete. Ask the sender for a new link.
            </p>
            <a className="text-button auth-back-link" href="/app">
              Back to workspace
            </a>
          </>
        ) : session.isPending ? (
          <p className="muted">Checking your account…</p>
        ) : session.data ? (
          <>
            <p className="muted">
              Accept this invitation as {session.data.user.email}.
            </p>
            {error && <p role="alert">{error}</p>}
            <button
              className="primary-button invitation-accept-button"
              type="button"
              disabled={pending}
              onClick={() => void accept()}
            >
              {pending ? "Accepting…" : "Accept invitation"}
            </button>
            <button
              className="text-button"
              type="button"
              disabled={pending}
              onClick={() => void switchAccount()}
            >
              Use another account
            </button>
          </>
        ) : (
          <>
            <p className="muted">Sign in or create an account to continue.</p>
            <a
              className="primary-button invitation-sign-in-link"
              href={`/?invitation=${encodeURIComponent(invitationId)}`}
            >
              Continue to sign in
            </a>
          </>
        )}
      </section>
    </main>
  );
}
