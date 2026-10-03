import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { MailIcon, PlusIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useId, useState, type SyntheticEvent } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { AppHeader, Page, PageHeader, PageSkeleton } from "@/components/page";
import { SettingsTabs } from "@/components/settings";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { dateOnly, errorMessage, initials } from "@/lib/format";
import {
  createOrganizationWorkspace,
  createWorkspaceInvitation,
  getOrganizationDirectory,
  listWorkspaceInvitations,
  listWorkspaceMembers,
  resendWorkspaceInvitation,
  revokeWorkspaceInvitation,
  updateWorkspaceMemberRole,
  type OrganizationDirectory,
  type WorkspaceInvitation,
  type WorkspaceMember,
} from "./asset-api";
import { authClient } from "./auth-client";
import { NameSlugFields } from "./name-slug-fields";
import { OrganizationVerification } from "./organization-verification";

type Organization = OrganizationDirectory["organizations"][number];

const roleLabels = { owner: "Owner", editor: "Editor", viewer: "Viewer" } as const;
const roleDescriptions = {
  viewer: "Can browse and download.",
  editor: "Can also upload, edit and delete assets and Vards.",
  owner: "Can also manage members, workspaces and settings.",
} as const;

export function OrganizationSettings({ organizationId }: { organizationId: string }) {
  const { tab, create } = useSearch({ from: "/organizations/$organizationId/settings" });
  const navigate = useNavigate();
  const directory = useQuery({
    queryKey: ["organizations"],
    queryFn: getOrganizationDirectory,
  });
  const organization = directory.data?.organizations.find(({ id }) => id === organizationId);
  const accessWorkspaceId = organization?.workspaces[0]?.id;

  function setTab(next: string) {
    void navigate({
      to: "/organizations/$organizationId/settings",
      params: { organizationId },
      search: { tab: next },
      replace: true,
    });
  }

  if (directory.isPending || directory.isError || !organization)
    return (
      <>
        <AppHeader crumbs={[{ label: "Organization" }]} />
        <Page id="main">
          {directory.isPending ? (
            <PageSkeleton />
          ) : (
            <Alert variant="destructive">
              <TriangleAlertIcon />
              <AlertTitle>Organization unavailable</AlertTitle>
              <AlertDescription>
                {directory.isError ? directory.error.message : "Organization not found."}
              </AlertDescription>
            </Alert>
          )}
        </Page>
      </>
    );

  const owner = organization.role === "owner" && accessWorkspaceId;

  return (
    <>
      <AppHeader crumbs={[{ label: "Organization" }]} />
      <Page id="main">
        <PageHeader
          title={organization.name}
          badge={<Badge variant="outline">{roleLabels[organization.role]}</Badge>}
          description={<span className="font-mono">{organization.slug}</span>}
        />
        <SettingsTabs
          value={tab ?? "workspaces"}
          onValueChange={setTab}
          tabs={[
            {
              value: "workspaces",
              label: "Workspaces",
              content: <WorkspacesCard organization={organization} startCreating={Boolean(create)} />,
            },
            ...(owner
              ? [
                  { value: "members", label: "Members", content: <OrganizationMembers workspaceId={accessWorkspaceId} /> },
                  {
                    value: "invitations",
                    label: "Invitations",
                    content: <OrganizationInvitations workspaceId={accessWorkspaceId} />,
                  },
                ]
              : []),
            {
              value: "organizations",
              label: "Organizations",
              content: <OrganizationsCard directory={directory.data} current={organization} />,
            },
          ]}
        />
      </Page>
    </>
  );
}

function WorkspacesCard({
  organization,
  startCreating,
}: {
  organization: Organization;
  startCreating: boolean;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(startCreating && organization.canCreateWorkspace);
  const [previousStartCreating, setPreviousStartCreating] = useState(startCreating);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!startCreating) return;
    // Consume the shortcut so another request can open this mounted card again.
    void navigate({
      to: "/organizations/$organizationId/settings",
      params: { organizationId: organization.id },
      search: (current) => ({ ...current, create: undefined }),
      replace: true,
    });
  }, [startCreating, organization.id, navigate]);

  if (startCreating !== previousStartCreating) {
    setPreviousStartCreating(startCreating);
    if (startCreating) setCreating(organization.canCreateWorkspace);
  }

  async function createWorkspace(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError("");
    try {
      const workspace = await createOrganizationWorkspace(organization.id, {
        name: String(form.get("name")),
        slug: String(form.get("slug")),
      });
      await queryClient.invalidateQueries({ queryKey: ["organizations"] });
      setCreating(false);
      await navigate({ to: "/workspaces/$workspaceId", params: { workspaceId: workspace.id } });
    } catch (cause) {
      setError(errorMessage(cause, "Workspace creation failed"));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Workspaces</CardTitle>
          <CardDescription>Each workspace has its own assets, Vards and API keys.</CardDescription>
          {organization.canCreateWorkspace && (
            <CardAction>
              <Button variant="outline" size="sm" onClick={() => setCreating(true)}>
                <PlusIcon data-icon="inline-start" />
                New workspace
              </Button>
            </CardAction>
          )}
        </CardHeader>
        <CardContent>
          {organization.workspaces.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Slug</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {organization.workspaces.map((workspace) => (
                  <TableRow key={workspace.id}>
                    <TableCell>
                      <Link
                        to="/workspaces/$workspaceId"
                        params={{ workspaceId: workspace.id }}
                        className="font-medium hover:underline"
                      >
                        {workspace.name}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <span className="font-mono text-xs text-muted-foreground">{workspace.slug}</span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="text-sm text-muted-foreground">
              {organization.canCreateWorkspace
                ? "No workspaces yet."
                : "No workspaces yet. Ask an owner to create one."}
            </p>
          )}
        </CardContent>
      </Card>
      <Dialog
        open={creating && organization.canCreateWorkspace}
        onOpenChange={(next) => {
          if (!next && !pending) {
            setError("");
            setCreating(false);
          }
        }}
      >
        <DialogContent>
          <form onSubmit={createWorkspace}>
            <FieldGroup>
              <DialogHeader>
                <DialogTitle>New workspace</DialogTitle>
                <DialogDescription>In {organization.name}</DialogDescription>
              </DialogHeader>
              <NameSlugFields autoFocus />
              {error && <FieldError>{error}</FieldError>}
              <DialogFooter>
                <Button type="submit" disabled={pending}>
                  {pending && <Spinner data-icon="inline-start" />}
                  Create workspace
                </Button>
              </DialogFooter>
            </FieldGroup>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

function OrganizationsCard({
  directory,
  current,
}: {
  directory: OrganizationDirectory;
  current: Organization;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function createOrganization(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    setError("");
    setPending(true);
    try {
      const result = await authClient.organization.create({
        name: String(form.get("name")),
        slug: String(form.get("slug")),
      });
      if (result.error) {
        setError(result.error.message ?? "Organization creation failed");
        return;
      }
      await queryClient.invalidateQueries({ queryKey: ["organizations"] });
      setCreating(false);
      await navigate({
        to: "/organizations/$organizationId/settings",
        params: { organizationId: result.data.id },
        search: { tab: "workspaces", create: true },
      });
    } catch (cause) {
      setError(errorMessage(cause, "Organization creation failed"));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      {directory.organizationCreation.status === "email_verification_required" && (
        <OrganizationVerification
          emailEnabled={directory.organizationCreation.verificationEmailEnabled}
        />
      )}
      <Card>
        <CardHeader>
          <CardTitle>Your organizations</CardTitle>
          {directory.canCreateOrganization && (
            <CardAction>
              <Button variant="outline" size="sm" onClick={() => setCreating(true)}>
                <PlusIcon data-icon="inline-start" />
                New organization
              </Button>
            </CardAction>
          )}
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Your role</TableHead>
                <TableHead>Workspaces</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {directory.organizations.map((record) => (
                <TableRow key={record.id}>
                  <TableCell>
                    {record.id === current.id ? (
                      <span className="font-medium">{record.name}</span>
                    ) : (
                      <Link
                        to="/organizations/$organizationId/settings"
                        params={{ organizationId: record.id }}
                        className="font-medium hover:underline"
                      >
                        {record.name}
                      </Link>
                    )}
                  </TableCell>
                  <TableCell>{roleLabels[record.role]}</TableCell>
                  <TableCell>{record.workspaces.length}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <Dialog
        open={creating}
        onOpenChange={(next) => {
          if (!next && !pending) {
            setError("");
            setCreating(false);
          }
        }}
      >
        <DialogContent>
          <form onSubmit={createOrganization}>
            <FieldGroup>
              <DialogHeader>
                <DialogTitle>New organization</DialogTitle>
              </DialogHeader>
              <NameSlugFields autoFocus />
              {error && <FieldError>{error}</FieldError>}
              <DialogFooter>
                <Button type="submit" disabled={pending}>
                  {pending && <Spinner data-icon="inline-start" />}
                  Create organization
                </Button>
              </DialogFooter>
            </FieldGroup>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

function OrganizationMembers({ workspaceId }: { workspaceId: string }) {
  const queryClient = useQueryClient();
  const [pendingId, setPendingId] = useState("");
  const members = useQuery({
    queryKey: ["workspace-members", workspaceId],
    queryFn: () => listWorkspaceMembers(workspaceId),
  });
  const ownerCount = members.data?.members.filter(({ role }) => role === "owner").length ?? 0;

  async function changeRole(member: WorkspaceMember, role: WorkspaceMember["role"]) {
    setPendingId(member.id);
    try {
      await updateWorkspaceMemberRole(workspaceId, member.id, role);
      await queryClient.invalidateQueries({ queryKey: ["workspace-members", workspaceId] });
      toast.success(`${member.name || member.email} is now ${roleLabels[role].toLowerCase()}`);
    } catch (cause) {
      toast.error(errorMessage(cause, "Role update failed"));
    } finally {
      setPendingId("");
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Members</CardTitle>
        <CardDescription>Roles apply to every workspace in the organization.</CardDescription>
      </CardHeader>
      <CardContent>
        {members.isPending ? (
          <Spinner />
        ) : members.isError ? (
          <FieldError>{members.error.message}</FieldError>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Member</TableHead>
                <TableHead>Role</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.data.members.map((member) => {
                const lastOwner = member.role === "owner" && ownerCount === 1;
                return (
                  <TableRow key={member.id}>
                    <TableCell>
                      <span className="flex items-center gap-3">
                        <Avatar>
                          <AvatarFallback>{initials(member.name || member.email)}</AvatarFallback>
                        </Avatar>
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate font-medium">{member.name}</span>
                          <span className="truncate text-xs text-muted-foreground">{member.email}</span>
                        </span>
                      </span>
                    </TableCell>
                    <TableCell>
                      <div className="w-32">
                        <NativeSelect
                          size="sm"
                          aria-label={`Role for ${member.email}`}
                          value={member.role}
                          disabled={pendingId === member.id || lastOwner}
                          title={lastOwner ? "An organization needs at least one owner" : undefined}
                          onChange={(event) =>
                            void changeRole(member, event.target.value as WorkspaceMember["role"])
                          }
                        >
                          <NativeSelectOption value="owner">Owner</NativeSelectOption>
                          <NativeSelectOption value="editor">Editor</NativeSelectOption>
                          <NativeSelectOption value="viewer">Viewer</NativeSelectOption>
                        </NativeSelect>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function OrganizationInvitations({ workspaceId }: { workspaceId: string }) {
  const id = useId();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState<WorkspaceInvitation["role"]>("viewer");
  const [pendingId, setPendingId] = useState("");
  const [error, setError] = useState("");
  const [revokeTarget, setRevokeTarget] = useState<WorkspaceInvitation | null>(null);
  const invitations = useQuery({
    queryKey: ["workspace-invitations", workspaceId],
    queryFn: () => listWorkspaceInvitations(workspaceId),
  });

  function refresh() {
    return queryClient.invalidateQueries({ queryKey: ["workspace-invitations", workspaceId] });
  }

  async function invite(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pendingId) return;
    const form = new FormData(event.currentTarget);
    setPendingId("create");
    setError("");
    try {
      const created = await createWorkspaceInvitation(workspaceId, {
        email: String(form.get("email")),
        role,
      });
      setOpen(false);
      if (created.emailSent) toast.success("Invitation sent");
      else toast.warning("Invitation created, but the email failed. Use Resend.");
    } catch (cause) {
      setError(errorMessage(cause, "Invitation failed"));
    } finally {
      await refresh();
      setPendingId("");
    }
  }

  async function resend(record: WorkspaceInvitation) {
    setPendingId(record.id);
    try {
      await resendWorkspaceInvitation(workspaceId, record.id);
      toast.success(`Invitation resent to ${record.email}`);
      await refresh();
    } catch (cause) {
      toast.error(errorMessage(cause, "Resend failed"));
    } finally {
      setPendingId("");
    }
  }

  async function revoke(record: WorkspaceInvitation) {
    await revokeWorkspaceInvitation(workspaceId, record.id);
    toast.success(`Invitation to ${record.email} revoked`);
    await refresh();
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Invitations</CardTitle>
          <CardDescription>Pending invitations to join the organization.</CardDescription>
          <CardAction>
            <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
              <PlusIcon data-icon="inline-start" />
              Invite
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          {invitations.isPending ? (
            <Spinner />
          ) : invitations.isError ? (
            <FieldError>{invitations.error.message}</FieldError>
          ) : invitations.data.invitations.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead>
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invitations.data.invitations.map((record) => (
                  <TableRow key={record.id}>
                    <TableCell>
                      <span className="font-medium">{record.email}</span>
                    </TableCell>
                    <TableCell>{roleLabels[record.role]}</TableCell>
                    <TableCell>{dateOnly.format(new Date(record.expiresAt))}</TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={pendingId === record.id}
                          onClick={() => void resend(record)}
                        >
                          {pendingId === record.id && <Spinner data-icon="inline-start" />}
                          Resend
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={pendingId === record.id}
                          onClick={() => setRevokeTarget(record)}
                        >
                          Revoke
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <MailIcon />
                </EmptyMedia>
                <EmptyTitle>No pending invitations</EmptyTitle>
                <EmptyDescription>Invite teammates by email.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </CardContent>
      </Card>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next && !pendingId) {
            setError("");
            setOpen(false);
          }
        }}
      >
        <DialogContent>
          <form onSubmit={invite}>
            <FieldGroup>
              <DialogHeader>
                <DialogTitle>Invite member</DialogTitle>
              </DialogHeader>
              <Field>
                <FieldLabel htmlFor={`${id}-email`}>Email</FieldLabel>
                <Input id={`${id}-email`} name="email" type="email" autoComplete="email" autoFocus required />
              </Field>
              <Field>
                <FieldLabel htmlFor={`${id}-role`}>Role</FieldLabel>
                <NativeSelect
                  id={`${id}-role`}
                  value={role}
                  onChange={(event) => setRole(event.target.value as WorkspaceInvitation["role"])}
                >
                  <NativeSelectOption value="viewer">Viewer</NativeSelectOption>
                  <NativeSelectOption value="editor">Editor</NativeSelectOption>
                  <NativeSelectOption value="owner">Owner</NativeSelectOption>
                </NativeSelect>
                <FieldDescription>{roleDescriptions[role]}</FieldDescription>
              </Field>
              {error && <FieldError>{error}</FieldError>}
              <DialogFooter>
                <Button type="submit" disabled={Boolean(pendingId)}>
                  {pendingId === "create" && <Spinner data-icon="inline-start" />}
                  Send invitation
                </Button>
              </DialogFooter>
            </FieldGroup>
          </form>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={Boolean(revokeTarget)}
        title={`Revoke invitation to ${revokeTarget?.email ?? ""}?`}
        description="The invitation link stops working immediately."
        confirmLabel="Revoke invitation"
        onCancel={() => setRevokeTarget(null)}
        onConfirm={() => (revokeTarget ? revoke(revokeTarget) : Promise.resolve())}
      />
    </>
  );
}
