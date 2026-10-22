import { useId, useState, type SyntheticEvent } from "react";
import { AuthLayout } from "@/components/auth-layout";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { authClient } from "./auth-client";
import { appAuthCallback, appPath, appUrl } from "./app-path";
import { CapabilityNotice, useDeploymentCapabilities } from "./capabilities";

const copy = {
  "sign-in": { title: "Sign in", submit: "Sign in" },
  "sign-up": { title: "Create account", submit: "Create account" },
  forgot: { title: "Reset password", submit: "Send reset link" },
} as const;

/**
 * The sign-in / sign-up / forgot-password form, shared by the app's auth screen
 * and the CLI login page. better-auth's useSession is reactive, so a parent
 * that renders this when there is no session re-renders into its authenticated
 * state on its own once the form succeeds.
 */
export function AuthForm() {
  const id = useId();
  const capabilities = useDeploymentCapabilities();
  const canRecover = capabilities.isSuccess && capabilities.data.passwordRecovery;
  const [mode, setMode] = useState<keyof typeof copy>("sign-in");
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [pending, setPending] = useState(false);

  function switchMode(next: typeof mode) {
    if (next === "forgot" && !canRecover) return;
    setMode(next);
    setError("");
    setStatus("");
  }

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || (mode === "forgot" && !canRecover)) return;
    setPending(true);
    setError("");
    setStatus("");
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email"));
    if (mode === "forgot") {
      const result = await authClient.requestPasswordReset({
        email,
        redirectTo: appUrl("/reset-password"),
      });
      if (result.error)
        setError(result.error.message ?? "Password reset request failed");
      else setStatus("If this email has an account, a reset link is on its way.");
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
            callbackURL: appAuthCallback(window.location),
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
        appPath(`/accept-invitation?id=${encodeURIComponent(invitation)}`),
      );
      return;
    }
    setPending(false);
  }

  return (
    <AuthLayout title={copy[mode].title}>
      <form onSubmit={submit}>
        <FieldGroup>
          {mode === "sign-up" && (
            <Field>
              <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
              <Input id={`${id}-name`} name="name" required autoComplete="name" />
            </Field>
          )}
          <Field>
            <FieldLabel htmlFor={`${id}-email`}>Email</FieldLabel>
            <Input
              id={`${id}-email`}
              name="email"
              type="email"
              required
              autoComplete="email"
            />
          </Field>
          {mode !== "forgot" && (
            <Field>
              <div className="flex items-center justify-between">
                <FieldLabel htmlFor={`${id}-password`}>Password</FieldLabel>
                {mode === "sign-in" && (
                  <Button
                    type="button"
                    variant="link"
                    size="xs"
                    disabled={pending || !canRecover}
                    aria-describedby={!canRecover ? `${id}-recovery` : undefined}
                    onClick={() => switchMode("forgot")}
                  >
                    Forgot password?
                  </Button>
                )}
              </div>
              <Input
                id={`${id}-password`}
                name="password"
                type="password"
                minLength={mode === "sign-up" ? 8 : undefined}
                required
                autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
              />
              {mode === "sign-up" && (
                <FieldDescription>At least 8 characters.</FieldDescription>
              )}
            </Field>
          )}
          {mode !== "sign-up" && (
            <CapabilityNotice
              id={`${id}-recovery`}
              capabilities={capabilities}
              available={canRecover}
              unavailable="Password recovery is unavailable because email delivery is not configured. Contact the server administrator."
            />
          )}
          {error && <FieldError>{error}</FieldError>}
          {status && (
            <Alert>
              <AlertDescription>{status}</AlertDescription>
            </Alert>
          )}
          <Button type="submit" disabled={pending || (mode === "forgot" && !canRecover)}>
            {pending && <Spinner data-icon="inline-start" />}
            {copy[mode].submit}
          </Button>
          <p className="text-center text-sm text-muted-foreground">
            {mode === "sign-in" ? "No account yet?" : "Have an account?"}{" "}
            <Button
              type="button"
              variant="link"
              size="xs"
              disabled={pending}
              onClick={() => switchMode(mode === "sign-in" ? "sign-up" : "sign-in")}
            >
              {mode === "sign-in" ? "Create one" : "Sign in"}
            </Button>
          </p>
        </FieldGroup>
      </form>
    </AuthLayout>
  );
}
