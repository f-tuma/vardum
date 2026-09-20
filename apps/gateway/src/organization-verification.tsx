import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { getOrganizationDirectory } from "./asset-api";
import { authClient } from "./auth-client";

export function OrganizationVerification({
  emailEnabled,
}: {
  emailEnabled: boolean;
}) {
  const session = authClient.useSession();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState(() => {
    const reason = new URLSearchParams(window.location.search)
      .get("error")
      ?.toLowerCase();
    return reason === "token_expired" || reason === "invalid_token"
      ? "This verification link is invalid or expired. Request a new link."
      : "";
  });

  async function resend() {
    if (!session.data || pending) return;
    setPending(true);
    setError("");
    setMessage("");
    try {
      const callback = new URL(window.location.href);
      callback.searchParams.delete("error");
      const result = await authClient.sendVerificationEmail({
        email: session.data.user.email,
        callbackURL: callback.toString(),
      });
      if (result.error)
        throw new Error(
          result.error.message ?? "Could not send verification email",
        );
      setMessage(
        "Verification email sent. Open the link in your inbox, then return here.",
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not send verification email",
      );
    } finally {
      setPending(false);
    }
  }

  async function refresh() {
    if (pending) return;
    setPending(true);
    setError("");
    setMessage("");
    try {
      const directory = await queryClient.fetchQuery({
        queryKey: ["organizations"],
        queryFn: getOrganizationDirectory,
        staleTime: 0,
      });
      if (
        directory.organizationCreation?.status === "email_verification_required"
      ) {
        setMessage(
          emailEnabled
            ? "Your email is not verified yet. Follow the link in your inbox first."
            : "Email verification is still required. Ask the administrator to configure outgoing email.",
        );
      }
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not check verification",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <section
      className="organization-verification"
      aria-label="Email verification"
    >
      <h2>Verify your email to create an organization</h2>
      {emailEnabled ? (
        <p>
          Confirm ownership of <strong>{session.data?.user.email}</strong> using
          the link in your inbox.
        </p>
      ) : (
        <p>
          Email verification is unavailable on this instance. Ask the
          administrator to configure outgoing email before creating an
          organization.
        </p>
      )}
      {error && (
        <p className="error-strip" role="alert">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      <div className="verification-actions">
        {emailEnabled && (
          <button
            type="button"
            disabled={pending}
            onClick={() => void resend()}
          >
            Send verification email
          </button>
        )}
        <button type="button" disabled={pending} onClick={() => void refresh()}>
          Check verification
        </button>
      </div>
    </section>
  );
}
