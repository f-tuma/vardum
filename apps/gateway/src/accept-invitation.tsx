import { useState } from "react";
import { AuthLayout } from "@/components/auth-layout";
import { Button, buttonVariants } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage } from "@/lib/format";
import { acceptWorkspaceInvitation } from "./asset-api";
import { authClient } from "./auth-client";
import { appPath } from "./app-path";

export function AcceptInvitation({ invitationId }: { invitationId: string }) {
  const session = authClient.useSession();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function accept() {
    setPending(true);
    setError("");
    try {
      const result = await acceptWorkspaceInvitation(invitationId);
      window.location.assign(appPath(`/workspaces/${encodeURIComponent(result.workspaceId)}`));
    } catch (cause) {
      setError(errorMessage(cause, "Invitation failed"));
      setPending(false);
    }
  }

  async function switchAccount() {
    await authClient.signOut();
    window.location.assign(appPath(`/?invitation=${encodeURIComponent(invitationId)}`));
  }

  if (!invitationId)
    return (
      <AuthLayout
        title="Invitation link incomplete"
        description="Ask the sender for a new link."
      >
        <div className="flex flex-col">
          <a href={appPath()} className={buttonVariants({ variant: "outline" })}>
            Go to Vardum
          </a>
        </div>
      </AuthLayout>
    );

  if (session.isPending)
    return (
      <AuthLayout title="You're invited">
        <Spinner />
      </AuthLayout>
    );

  if (!session.data)
    return (
      <AuthLayout
        title="You're invited"
        description="Sign in or create an account to join."
      >
        <div className="flex flex-col">
          <a href={appPath(`/?invitation=${encodeURIComponent(invitationId)}`)} className={buttonVariants()}>
            Continue
          </a>
        </div>
      </AuthLayout>
    );

  return (
    <AuthLayout
      title="You're invited"
      description={`Join as ${session.data.user.email}.`}
    >
      <div className="flex flex-col gap-2">
        {error && <FieldError>{error}</FieldError>}
        <Button disabled={pending} onClick={() => void accept()}>
          {pending && <Spinner data-icon="inline-start" />}
          Accept invitation
        </Button>
        <Button variant="ghost" disabled={pending} onClick={() => void switchAccount()}>
          Use another account
        </Button>
      </div>
    </AuthLayout>
  );
}
