import { useState, type SyntheticEvent } from "react";
import { authClient } from "./auth-client";

/**
 * The sign-in / sign-up / forgot-password form, shared by the app's auth screen
 * and the CLI login page. better-auth's useSession is reactive, so a parent
 * that renders this when there is no session re-renders into its authenticated
 * state on its own once the form succeeds.
 */
export function AuthForm() {
  const [mode, setMode] = useState<"sign-in" | "sign-up" | "forgot">("sign-in");
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [pending, setPending] = useState(false);

  function switchMode(next: typeof mode) {
    setMode(next);
    setError("");
    setStatus("");
  }

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
                minLength={mode === "sign-up" ? 8 : undefined}
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
                disabled={pending}
                onClick={() => switchMode("sign-up")}
              >
                Create an account
              </button>
              <button
                className="text-button"
                type="button"
                disabled={pending}
                onClick={() => switchMode("forgot")}
              >
                Forgot password?
              </button>
            </>
          ) : (
            <button
              className="text-button"
              type="button"
              disabled={pending}
              onClick={() => switchMode("sign-in")}
            >
              Back to sign in
            </button>
          )}
        </div>
      </section>
    </main>
  );
}
