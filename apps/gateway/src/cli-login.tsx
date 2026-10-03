import { useQuery } from "@tanstack/react-query";
import { CircleCheckIcon, TerminalIcon } from "lucide-react";
import { useId, useState } from "react";
import { AuthLayout } from "@/components/auth-layout";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import {
  NativeSelect,
  NativeSelectOptGroup,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { createCliKey, getOrganizationDirectory } from "./asset-api";
import { AuthForm } from "./auth-form";
import { authClient } from "./auth-client";
import { loopbackCallback } from "./loopback";

export function CliLogin({
  callback,
  state,
  label,
  requestedWorkspace = "",
}: {
  callback: string;
  state: string;
  label: string;
  requestedWorkspace?: string;
}) {
  const id = useId();
  const session = authClient.useSession();
  const target = loopbackCallback(callback);
  const [workspaceId, setWorkspaceId] = useState("");
  const [access, setAccess] = useState<"read" | "write">("write");
  const [authorized, setAuthorized] = useState<{
    key: string;
    workspaceName: string;
  } | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const directory = useQuery({
    queryKey: ["organizations"],
    queryFn: getOrganizationDirectory,
    enabled: Boolean(session.data),
  });
  const organizations = directory.data?.organizations ?? [];
  const workspaces = organizations.flatMap((organization) => organization.workspaces);
  const selected = workspaceId || requestedWorkspace || workspaces[0]?.id || "";
  const selectedAvailable = workspaces.some(({ id: candidate }) => candidate === selected);

  async function authorize() {
    if (!target || !selectedAvailable) return;
    setPending(true);
    setError("");
    try {
      const created = await createCliKey(selected, { label, access });
      const workspaceName =
        workspaces.find((workspace) => workspace.id === selected)?.name ?? selected;
      // pi-lens-ignore: identifier — loopback-callback already validated the URL
      await fetch(target, {
        method: "POST",
        // text/plain keeps this a simple request: no preflight to the CLI's
        // throwaway listener, which only knows how to answer one POST.
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ state, key: created.key, workspace: selected }),
      });
      setAuthorized({ key: created.key, workspaceName });
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
      <AuthLayout
        title="Authorize the CLI"
        description={
          <>
            This link did not come from a CLI on your machine. Start again with{" "}
            <code>vardum login</code>.
          </>
        }
      />
    );
  // No session yet: let the user sign in right here. better-auth's useSession
  // is reactive, so this component re-renders into the authorize form below
  // the moment the sign-in succeeds — same tab, same callback/state.
  if (session.isPending)
    return (
      <AuthLayout title="Authorize the CLI">
        <Spinner />
      </AuthLayout>
    );
  if (!session.data) return <AuthForm />;

  if (authorized)
    return (
      <AuthLayout title="CLI authorized">
        <Alert>
          <CircleCheckIcon />
          <AlertTitle>
            {label} can now access {authorized.workspaceName}
          </AlertTitle>
          <AlertDescription>
            <code>{authorized.key.slice(0, 12)}••••</code> — you can close this tab.
          </AlertDescription>
        </Alert>
      </AuthLayout>
    );

  return (
    <AuthLayout
      title="Authorize the CLI"
      description={
        <>
          <code>{label}</code> wants a key for {session.data.user.email}.
        </>
      }
    >
      <form onSubmit={(event) => event.preventDefault()}>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor={`${id}-workspace`}>Workspace</FieldLabel>
            <NativeSelect
              id={`${id}-workspace`}
              value={selected}
              onChange={(event) => setWorkspaceId(event.target.value)}
            >
              {!selectedAvailable && (
                <NativeSelectOption value={selected}>Select a workspace</NativeSelectOption>
              )}
              {organizations.map((organization) => (
                <NativeSelectOptGroup key={organization.id} label={organization.name}>
                  {organization.workspaces.map((workspace) => (
                    <NativeSelectOption key={workspace.id} value={workspace.id}>
                      {workspace.name}
                    </NativeSelectOption>
                  ))}
                </NativeSelectOptGroup>
              ))}
            </NativeSelect>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-access`}>Access</FieldLabel>
            <NativeSelect
              id={`${id}-access`}
              value={access}
              onChange={(event) => setAccess(event.target.value as "read" | "write")}
            >
              <NativeSelectOption value="write">Pull and push</NativeSelectOption>
              <NativeSelectOption value="read">Pull only</NativeSelectOption>
            </NativeSelect>
            <FieldDescription>
              The key is sent to <code>{target.origin}</code> and is limited by your role.
            </FieldDescription>
          </Field>
          {error && <FieldError>{error}</FieldError>}
          <Button disabled={pending || !selectedAvailable} onClick={() => void authorize()}>
            {pending ? <Spinner data-icon="inline-start" /> : <TerminalIcon data-icon="inline-start" />}
            Authorize
          </Button>
        </FieldGroup>
      </form>
    </AuthLayout>
  );
}
