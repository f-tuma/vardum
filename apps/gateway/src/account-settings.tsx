import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, useId, type SyntheticEvent } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { AppHeader, Page, PageHeader } from "@/components/page";
import { SettingsTabs } from "@/components/settings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { timeAgo } from "@/lib/format";
import { authClient } from "./auth-client";

type RevokeTarget = { token: string | null; label: string };

function sessionClient(userAgent: string | null | undefined) {
  const agent = userAgent ?? "";
  const browser = /Edg\//.test(agent)
    ? "Edge"
    : /Firefox\//.test(agent)
      ? "Firefox"
      : /Chrome\//.test(agent)
        ? "Chrome"
        : /Safari\//.test(agent)
          ? "Safari"
          : agent === "node"
            ? "API client"
            : "Unknown device";
  const platform = /Android/.test(agent)
    ? "Android"
    : /iPhone|iPad/.test(agent)
      ? "iOS"
      : /Windows/.test(agent)
        ? "Windows"
        : /Macintosh/.test(agent)
          ? "macOS"
          : /Linux/.test(agent)
            ? "Linux"
            : "";
  return [browser, platform].filter(Boolean).join(" on ");
}

export function AccountSettings() {
  const session = authClient.useSession();
  const [tab, setTab] = useState("profile");
  if (!session.data) return null;
  const user = session.data.user;
  return (
    <>
      <AppHeader crumbs={[{ label: "Account" }]} />
      <Page id="main">
        <PageHeader title="Account" description={user.email} />
        <SettingsTabs
          value={tab}
          onValueChange={setTab}
          tabs={[
            { value: "profile", label: "Profile", content: <ProfileCard /> },
            { value: "password", label: "Password", content: <PasswordCard /> },
            { value: "sessions", label: "Sessions", content: <SessionsCard /> },
          ]}
        />
      </Page>
    </>
  );
}

function ProfileCard() {
  const id = useId();
  const session = authClient.useSession();
  const [error, setError] = useState("");
  const [nameError, setNameError] = useState("");
  const [pending, setPending] = useState(false);
  const [notice] = useState(
    () => new URLSearchParams(window.location.search).get("emailChanged") === "true",
  );
  if (!session.data) return null;
  const user = session.data.user;

  async function updateProfile(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const name = String(data.get("name")).trim();
    const email = String(data.get("email")).trim().toLowerCase();
    setError("");
    setNameError("");
    if (!name) {
      setNameError("Name is required");
      return;
    }
    setPending(true);
    const result = await authClient.updateUser({ name });
    if (result.error) {
      setPending(false);
      setError(result.error.message ?? "Profile update failed");
      return;
    }
    if (email !== user.email.toLowerCase()) {
      const emailResult = await authClient.changeEmail({
        newEmail: email,
        callbackURL: `${window.location.origin}/account?emailChanged=true`,
      });
      setPending(false);
      if (emailResult.error) {
        setError(emailResult.error.message ?? "Email change failed");
        return;
      }
      toast.success(`Check ${email} to confirm the change`);
      return;
    }
    setPending(false);
    await session.refetch();
    toast.success("Profile saved");
  }

  return (
    <form onSubmit={updateProfile}>
      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
          {notice && <CardDescription>Your email address was updated.</CardDescription>}
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field data-invalid={Boolean(nameError)}>
              <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
              <Input
                id={`${id}-name`}
                name="name"
                defaultValue={user.name}
                maxLength={255}
                aria-invalid={Boolean(nameError)}
                aria-describedby={nameError ? `${id}-name-error` : undefined}
                onChange={() => setNameError("")}
                required
              />
              {nameError && <FieldError id={`${id}-name-error`}>{nameError}</FieldError>}
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-email`}>Email</FieldLabel>
              <Input
                id={`${id}-email`}
                name="email"
                type="email"
                defaultValue={user.email}
                autoComplete="email"
                required
              />
              <FieldDescription>Changing it sends a confirmation link to the new address.</FieldDescription>
            </Field>
            {error && <FieldError>{error}</FieldError>}
          </FieldGroup>
        </CardContent>
        <CardFooter>
          <div className="flex w-full justify-end">
            <Button type="submit" disabled={pending}>
              {pending && <Spinner data-icon="inline-start" />}
              Save
            </Button>
          </div>
        </CardFooter>
      </Card>
    </form>
  );
}

function PasswordCard() {
  const id = useId();
  const queryClient = useQueryClient();
  const [error, setError] = useState("");
  const [passwordMismatch, setPasswordMismatch] = useState(false);
  const [pending, setPending] = useState(false);

  async function changePassword(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const newPassword = String(data.get("newPassword"));
    setError("");
    setPasswordMismatch(false);
    if (newPassword !== String(data.get("confirmPassword"))) {
      setPasswordMismatch(true);
      return;
    }
    setPending(true);
    const result = await authClient.changePassword({
      currentPassword: String(data.get("currentPassword")),
      newPassword,
      revokeOtherSessions: data.get("revokeOtherSessions") === "on",
    });
    setPending(false);
    if (result.error) {
      setError(result.error.message ?? "Password change failed");
      return;
    }
    form.reset();
    await queryClient.invalidateQueries({ queryKey: ["account-sessions"] });
    toast.success("Password changed");
  }

  return (
    <form onSubmit={changePassword}>
      <Card>
        <CardHeader>
          <CardTitle>Password</CardTitle>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={`${id}-current`}>Current password</FieldLabel>
              <Input
                id={`${id}-current`}
                name="currentPassword"
                type="password"
                autoComplete="current-password"
                required
              />
            </Field>
            <Field data-invalid={passwordMismatch}>
              <FieldLabel htmlFor={`${id}-new`}>New password</FieldLabel>
              <Input
                id={`${id}-new`}
                name="newPassword"
                type="password"
                autoComplete="new-password"
                minLength={8}
                aria-invalid={passwordMismatch}
                aria-describedby={passwordMismatch ? `${id}-new-description ${id}-mismatch` : `${id}-new-description`}
                onChange={() => setPasswordMismatch(false)}
                required
              />
              <FieldDescription id={`${id}-new-description`}>At least 8 characters.</FieldDescription>
            </Field>
            <Field data-invalid={passwordMismatch}>
              <FieldLabel htmlFor={`${id}-confirm`}>Confirm new password</FieldLabel>
              <Input
                id={`${id}-confirm`}
                name="confirmPassword"
                type="password"
                autoComplete="new-password"
                minLength={8}
                aria-invalid={passwordMismatch}
                aria-describedby={passwordMismatch ? `${id}-mismatch` : undefined}
                onChange={() => setPasswordMismatch(false)}
                required
              />
              {passwordMismatch && <FieldError id={`${id}-mismatch`}>New passwords do not match</FieldError>}
            </Field>
            <Field orientation="horizontal">
              <Checkbox id={`${id}-revoke`} name="revokeOtherSessions" defaultChecked />
              <FieldLabel htmlFor={`${id}-revoke`}>Sign out other devices</FieldLabel>
            </Field>
            {error && <FieldError>{error}</FieldError>}
          </FieldGroup>
        </CardContent>
        <CardFooter>
          <div className="flex w-full justify-end">
            <Button type="submit" disabled={pending}>
              {pending && <Spinner data-icon="inline-start" />}
              Change password
            </Button>
          </div>
        </CardFooter>
      </Card>
    </form>
  );
}

function SessionsCard() {
  const session = authClient.useSession();
  const queryClient = useQueryClient();
  const [revokeTarget, setRevokeTarget] = useState<RevokeTarget | null>(null);
  const sessions = useQuery({
    queryKey: ["account-sessions"],
    queryFn: async () => {
      const result = await authClient.listSessions();
      if (result.error) throw new Error(result.error.message ?? "Session loading failed");
      return result.data ?? [];
    },
    enabled: Boolean(session.data),
  });
  if (!session.data) return null;

  async function revokeSessions() {
    if (!revokeTarget) return;
    const result = revokeTarget.token
      ? await authClient.revokeSession({ token: revokeTarget.token })
      : await authClient.revokeOtherSessions();
    if (result.error) throw new Error(result.error.message ?? "Session revoke failed");
    await queryClient.invalidateQueries({ queryKey: ["account-sessions"] });
    toast.success("Signed out");
  }

  const currentToken = session.data.session.token;
  const ordered = (sessions.data ?? []).toSorted(
    (left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
  );
  const others = ordered.filter(({ token }) => token !== currentToken).length;

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Sessions</CardTitle>
          <CardDescription>Devices signed in to your account. CLI keys are separate.</CardDescription>
          <CardAction>
            <Button
              variant="outline"
              size="sm"
              disabled={!others}
              onClick={() => setRevokeTarget({ token: null, label: "all other devices" })}
            >
              Sign out others
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          {sessions.isPending ? (
            <Spinner />
          ) : sessions.isError ? (
            <FieldError>{sessions.error.message}</FieldError>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Device</TableHead>
                  <TableHead>Signed in</TableHead>
                  <TableHead>
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {ordered.map((item) => {
                  const current = item.token === currentToken;
                  return (
                    <TableRow key={item.id}>
                      <TableCell>
                        <span className="flex flex-col">
                          <span className="flex items-center gap-2 font-medium">
                            {sessionClient(item.userAgent)}
                            {current && <Badge variant="secondary">This device</Badge>}
                          </span>
                          <span className="text-xs text-muted-foreground" title={item.userAgent ?? undefined}>
                            {item.ipAddress || "IP unknown"}
                          </span>
                        </span>
                      </TableCell>
                      <TableCell>
                        <span className="text-muted-foreground">{timeAgo(item.createdAt)}</span>
                      </TableCell>
                      <TableCell>
                        {!current && (
                          <div className="flex justify-end">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() =>
                                setRevokeTarget({ token: item.token, label: item.ipAddress || "this device" })
                              }
                            >
                              Sign out
                            </Button>
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <ConfirmDialog
        open={Boolean(revokeTarget)}
        tone="neutral"
        title={`Sign out ${revokeTarget?.label ?? "session"}?`}
        description="Those devices will need to sign in again."
        confirmLabel="Sign out"
        onCancel={() => setRevokeTarget(null)}
        onConfirm={revokeSessions}
      />
    </>
  );
}
