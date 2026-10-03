import { useId, useState, type SyntheticEvent } from "react";
import { AuthLayout } from "@/components/auth-layout";
import { Button, buttonVariants } from "@/components/ui/button";
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

export function ResetPassword({
  token,
  callbackError,
}: {
  token: string;
  callbackError: string;
}) {
  const id = useId();
  const invalidLink = Boolean(callbackError || !token);
  const [error, setError] = useState("");
  const [passwordMismatch, setPasswordMismatch] = useState(false);
  const [pending, setPending] = useState(false);
  const [complete, setComplete] = useState(false);

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const newPassword = String(data.get("newPassword"));
    setError("");
    setPasswordMismatch(false);
    if (newPassword !== String(data.get("confirmPassword"))) {
      setPasswordMismatch(true);
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

  const backToSignIn = (
    <a href="/app" className={buttonVariants({ variant: "outline" })}>
      Back to sign in
    </a>
  );

  if (complete)
    return (
      <AuthLayout title="Password updated" description="Sign in with your new password.">
        <div className="flex flex-col">{backToSignIn}</div>
      </AuthLayout>
    );

  if (invalidLink)
    return (
      <AuthLayout
        title="Link expired"
        description="This reset link is invalid or has expired. Request a new one from the sign-in page."
      >
        <div className="flex flex-col">{backToSignIn}</div>
      </AuthLayout>
    );

  return (
    <AuthLayout title="Choose a new password">
      <form onSubmit={submit}>
        <FieldGroup>
          <Field data-invalid={passwordMismatch}>
            <FieldLabel htmlFor={`${id}-new`}>New password</FieldLabel>
            <Input
              id={`${id}-new`}
              name="newPassword"
              type="password"
              minLength={8}
              autoComplete="new-password"
              aria-invalid={passwordMismatch}
              aria-describedby={passwordMismatch ? `${id}-new-description ${id}-mismatch` : `${id}-new-description`}
              onChange={() => setPasswordMismatch(false)}
              required
            />
            <FieldDescription id={`${id}-new-description`}>At least 8 characters.</FieldDescription>
          </Field>
          <Field data-invalid={passwordMismatch}>
            <FieldLabel htmlFor={`${id}-confirm`}>Confirm password</FieldLabel>
            <Input
              id={`${id}-confirm`}
              name="confirmPassword"
              type="password"
              minLength={8}
              autoComplete="new-password"
              aria-invalid={passwordMismatch}
              aria-describedby={passwordMismatch ? `${id}-mismatch` : undefined}
              onChange={() => setPasswordMismatch(false)}
              required
            />
            {passwordMismatch && <FieldError id={`${id}-mismatch`}>Passwords do not match</FieldError>}
          </Field>
          {error && <FieldError>{error}</FieldError>}
          <Button type="submit" disabled={pending}>
            {pending && <Spinner data-icon="inline-start" />}
            Set new password
          </Button>
        </FieldGroup>
      </form>
    </AuthLayout>
  );
}
