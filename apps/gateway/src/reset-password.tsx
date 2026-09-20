import { useState, type SyntheticEvent } from "react";
import { authClient } from "./auth-client";

export function ResetPassword({
  token,
  callbackError,
}: {
  token: string;
  callbackError: string;
}) {
  const invalidLink = Boolean(callbackError || !token);
  const [error, setError] = useState(
    invalidLink ? "This reset link is invalid or has expired." : "",
  );
  const [pending, setPending] = useState(false);
  const [complete, setComplete] = useState(false);

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const newPassword = String(data.get("newPassword"));
    setError("");
    if (newPassword !== String(data.get("confirmPassword"))) {
      setError("New passwords do not match");
      return;
    }
    if (!token) {
      setError("This reset link is invalid or has expired.");
      return;
    }

    setPending(true);
    const result = await authClient.resetPassword({ newPassword, token });
    setPending(false);
    if (result.error) {
      setError(result.error.message ?? "Password reset failed");
      return;
    }
    setComplete(true);
  }

  return (
    <main className="auth-shell">
      <section className="auth-panel">
        <div className="auth-brand">
          <span aria-hidden="true">╂</span> VARDUM
        </div>
        <h1>
          {complete
            ? "Password updated"
            : invalidLink
              ? "Reset link unavailable"
              : "Choose a new password"}
        </h1>
        <p className="muted">
          {complete
            ? "You can now sign in with your new password."
            : invalidLink
              ? "Request a new link from the sign-in page."
              : "Use at least eight characters."}
        </p>
        {!complete && !invalidLink && (
          <form onSubmit={submit}>
            <label>
              New password
              <input
                name="newPassword"
                type="password"
                minLength={8}
                autoComplete="new-password"
                required
              />
            </label>
            <label>
              Confirm new password
              <input
                name="confirmPassword"
                type="password"
                minLength={8}
                autoComplete="new-password"
                required
              />
            </label>
            {error && <p role="alert">{error}</p>}
            <button className="primary-button" disabled={pending}>
              {pending ? "Updating…" : "Set new password"}
            </button>
          </form>
        )}
        {invalidLink && <p role="alert">{error}</p>}
        <a className="text-button auth-back-link" href="/app">
          Back to sign in
        </a>
      </section>
    </main>
  );
}
