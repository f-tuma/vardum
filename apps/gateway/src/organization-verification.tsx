import { useQueryClient } from "@tanstack/react-query";
import { MailIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { errorMessage } from "@/lib/format";
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
  const [linkError] = useState(() => {
    const reason = new URLSearchParams(window.location.search)
      .get("error")
      ?.toLowerCase();
    return reason === "token_expired" || reason === "invalid_token";
  });

  async function resend() {
    if (!session.data || pending) return;
    setPending(true);
    try {
      const callback = new URL(window.location.href);
      callback.searchParams.delete("error");
      const result = await authClient.sendVerificationEmail({
        email: session.data.user.email,
        callbackURL: callback.toString(),
      });
      if (result.error)
        throw new Error(result.error.message ?? "Could not send verification email");
      toast.success("Verification email sent");
    } catch (cause) {
      toast.error(errorMessage(cause, "Could not send verification email"));
    } finally {
      setPending(false);
    }
  }

  async function refresh() {
    if (pending) return;
    setPending(true);
    try {
      const directory = await queryClient.fetchQuery({
        queryKey: ["organizations"],
        queryFn: getOrganizationDirectory,
        staleTime: 0,
      });
      if (directory.organizationCreation.status === "email_verification_required")
        toast.info(
          emailEnabled
            ? "Not verified yet — open the link in your inbox first."
            : "Still waiting for the administrator to set up email.",
        );
    } catch (cause) {
      toast.error(errorMessage(cause, "Could not check verification"));
    } finally {
      setPending(false);
    }
  }

  return (
    <Empty variant="outline">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <MailIcon />
        </EmptyMedia>
        <EmptyTitle>Verify your email</EmptyTitle>
        <EmptyDescription>
          {linkError
            ? "That verification link is invalid or expired. Request a new one."
            : emailEnabled
              ? `Open the link we sent to ${session.data?.user.email ?? "your inbox"} to create an organization.`
              : "Email is not configured on this server. Ask the administrator to set it up."}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <div className="flex gap-2">
          {emailEnabled && (
            <Button disabled={pending} onClick={() => void resend()}>
              Resend email
            </Button>
          )}
          <Button variant="outline" disabled={pending} onClick={() => void refresh()}>
            I've verified
          </Button>
        </div>
      </EmptyContent>
    </Empty>
  );
}
