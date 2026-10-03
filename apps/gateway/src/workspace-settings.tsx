import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { CircleCheckIcon, KeyRoundIcon, PlusIcon, TriangleAlertIcon } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, type SyntheticEvent } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CopyIconButton } from "@/components/copy-button";
import { AppHeader, Page, PageHeader } from "@/components/page";
import { SettingsTabs } from "@/components/settings";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
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
import { dateOnly, errorMessage, timeAgo } from "@/lib/format";
import {
  configureWorkspaceDomain,
  createWorkspaceApiKey,
  deleteWorkspace,
  deleteWorkspaceApiKey,
  getWorkspaceDomain,
  listWorkspaceApiKeys,
  removeWorkspaceDomain,
  updateWorkspace,
  verifyWorkspaceDomain,
} from "./asset-api";
import { workspaceCrumb, type WorkspaceRef } from "./workspace";

export function WorkspaceSettings({ workspace }: { workspace: WorkspaceRef }) {
  const { tab } = useSearch({ from: "/workspaces/$workspaceId/settings" });
  const navigate = useNavigate();
  return (
    <>
      <AppHeader crumbs={[workspaceCrumb(workspace), { label: "Settings" }]} />
      <Page id="main">
        <PageHeader title="Workspace settings" />
        <SettingsTabs
          value={tab ?? "general"}
          onValueChange={(next) =>
            void navigate({
              to: "/workspaces/$workspaceId/settings",
              params: { workspaceId: workspace.id },
              search: { tab: next },
              replace: true,
            })
          }
          tabs={[
            { value: "general", label: "General", content: <GeneralSettings workspace={workspace} /> },
            { value: "custom-domain", label: "Domain", content: <DomainSettings workspaceId={workspace.id} canManage={workspace.canManage} /> },
            { value: "api-keys", label: "API keys", content: <ApiKeysSettings workspaceId={workspace.id} /> },
            ...(workspace.canEdit
              ? [{ value: "danger-zone", label: "Delete", content: <DangerZone workspace={workspace} /> }]
              : []),
          ]}
        />
      </Page>
    </>
  );
}

function GeneralSettings({ workspace }: { workspace: WorkspaceRef }) {
  const id = useId();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function save(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    const name = String(new FormData(event.currentTarget).get("name"));
    try {
      await updateWorkspace(workspace.id, name);
      await queryClient.invalidateQueries({ queryKey: ["organizations"] });
      toast.success("Workspace saved");
    } catch (cause) {
      setError(errorMessage(cause, "Update failed"));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={save}>
      <Card>
        <CardHeader>
          <CardTitle>General</CardTitle>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
              <Input
                id={`${id}-name`}
                name="name"
                defaultValue={workspace.name}
                minLength={1}
                maxLength={80}
                required
                disabled={!workspace.canEdit}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-slug`}>Slug</FieldLabel>
              <Input id={`${id}-slug`} value={workspace.slug} readOnly />
              <FieldDescription>
                Fixed so asset URLs never change: <code>/w/{workspace.slug}/&#123;key&#125;</code>
              </FieldDescription>
            </Field>
            {error && <FieldError>{error}</FieldError>}
          </FieldGroup>
        </CardContent>
        {workspace.canEdit && (
          <CardFooter>
            <div className="flex w-full justify-end">
              <Button type="submit" disabled={pending}>
                {pending && <Spinner data-icon="inline-start" />}
                Save
              </Button>
            </div>
          </CardFooter>
        )}
      </Card>
    </form>
  );
}

/**
 * Verification hinges on the TXT challenge: a domain proxied through Cloudflare
 * hides its CNAME behind flattened A records, so a missing CNAME is only worth
 * mentioning once ownership is proven.
 */
function verificationMessage(result: { status: string; checks?: { txt: boolean; cname: boolean } }) {
  if (result.status === "verified")
    return result.checks?.cname
      ? "Domain verified"
      : "Domain verified — CNAME not visible (normal behind Cloudflare)";
  return "TXT record not found yet";
}

export function DomainSettings({ workspaceId, canManage }: { workspaceId: string; canManage: boolean }) {
  const id = useId();
  const queryClient = useQueryClient();
  const [pendingAction, setPendingAction] = useState("");
  const [error, setError] = useState("");
  const [removeOpen, setRemoveOpen] = useState(false);
  const autoVerifyingRef = useRef(false);
  const domain = useQuery({
    queryKey: ["workspace-domain", workspaceId],
    queryFn: () => getWorkspaceDomain(workspaceId),
    enabled: canManage,
    retry: false,
  });
  const status = domain.data?.status;
  const canConfigure = canManage && domain.isSuccess && Boolean(domain.data.target);

  const refresh = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ["workspace-domain", workspaceId] }),
    [queryClient, workspaceId],
  );

  // Re-check every 12 s while DNS propagates.
  useEffect(() => {
    if (!canConfigure || status !== "pending") return;
    async function autoVerify() {
      if (autoVerifyingRef.current) return;
      autoVerifyingRef.current = true;
      try {
        const result = await verifyWorkspaceDomain(workspaceId);
        if (result.status === "verified") toast.success(verificationMessage(result));
        await refresh();
      } catch {
        // DNS timeouts happen; the next interval retries.
      } finally {
        autoVerifyingRef.current = false;
      }
    }
    void autoVerify();
    const interval = window.setInterval(() => void autoVerify(), 12_000);
    return () => window.clearInterval(interval);
  }, [canConfigure, status, workspaceId, refresh]);

  async function configure(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canConfigure || pendingAction) return;
    setPendingAction("configure");
    setError("");
    try {
      await configureWorkspaceDomain(workspaceId, String(new FormData(event.currentTarget).get("domain")));
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause, "Domain update failed"));
    } finally {
      setPendingAction("");
    }
  }

  async function verify() {
    if (!canConfigure || pendingAction) return;
    setPendingAction("verify");
    setError("");
    try {
      const result = await verifyWorkspaceDomain(workspaceId);
      if (result.status === "verified") toast.success(verificationMessage(result));
      else toast.info(verificationMessage(result));
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause, "Domain verification failed"));
    } finally {
      setPendingAction("");
    }
  }

  async function remove() {
    if (!canManage || !domain.data?.domain) return;
    await removeWorkspaceDomain(workspaceId);
    await refresh();
    toast.success("Custom domain removed");
  }

  if (!canManage)
    return (
      <Card>
        <CardHeader>
          <CardTitle>Custom domain</CardTitle>
          <CardDescription>Only organization owners can manage custom domains. Ask an owner to make changes.</CardDescription>
        </CardHeader>
      </Card>
    );
  if (domain.isPending)
    return (
      <output className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner />
        Loading domain settings…
      </output>
    );
  if (domain.isError)
    return (
      <Alert variant="destructive">
        <TriangleAlertIcon />
        <AlertTitle>Domain settings unavailable</AlertTitle>
        <AlertDescription>
          {domain.error.message}
          <Button type="button" variant="outline" size="sm" disabled={domain.isFetching} onClick={() => void domain.refetch()}>Retry</Button>
        </AlertDescription>
      </Alert>
    );
  const record = domain.data;

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Custom domain</CardTitle>
          <CardDescription>Serve public assets from a hostname you own.</CardDescription>
          {record.domain && (
            <CardAction>
              <Badge variant={record.status === "verified" ? "secondary" : "outline"}>
                {record.status === "verified" ? (
                  <CircleCheckIcon data-icon="inline-start" />
                ) : (
                  <Spinner data-icon="inline-start" />
                )}
                {record.status === "verified" ? "Verified" : "Waiting for DNS"}
              </Badge>
            </CardAction>
          )}
        </CardHeader>
        <CardContent>
          <form onSubmit={configure}>
            <FieldGroup>
              <Field data-disabled={!canConfigure}>
                <FieldLabel htmlFor={`${id}-domain`}>Hostname</FieldLabel>
                <div className="flex gap-2">
                  <div className="flex-1">
                    <Input
                      key={record.domain}
                      id={`${id}-domain`}
                      name="domain"
                      defaultValue={record.domain ?? ""}
                      placeholder="assets.example.com"
                      autoComplete="off"
                      spellCheck={false}
                      disabled={!canConfigure}
                      aria-describedby={!canConfigure ? `${id}-domain-availability` : undefined}
                      required
                    />
                  </div>
                  <Button
                    type="submit"
                    variant="outline"
                    disabled={Boolean(pendingAction) || !canConfigure}
                    aria-describedby={!canConfigure ? `${id}-domain-availability` : undefined}
                  >
                    {pendingAction === "configure" && <Spinner data-icon="inline-start" />}
                    Save
                  </Button>
                </div>
              </Field>
              {!canConfigure && (
                <FieldDescription id={`${id}-domain-availability`}>Custom domains are unavailable because this server has no delivery target. Ask the server administrator to configure one.</FieldDescription>
              )}
              {error && <FieldError>{error}</FieldError>}
            </FieldGroup>
          </form>
        </CardContent>
        {record.domain && record.verification && (
          <CardContent>
            <div className="flex flex-col gap-3">
              <p className="text-sm text-muted-foreground">
                Add these records at your DNS provider. HTTPS for the hostname is set up by
                whoever runs this server.
              </p>
              <div className="rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Type</TableHead>
                      <TableHead>Name</TableHead>
                      <TableHead>Value</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    <DnsRow type="TXT" name={record.verification.name} value={record.verification.value} />
                    <DnsRow type="CNAME" name={record.domain} value={record.target ?? "Not configured"} />
                  </TableBody>
                </Table>
              </div>
            </div>
          </CardContent>
        )}
        {record.domain && (
          <CardFooter>
            <div className="flex w-full justify-between gap-2">
              <Button
                variant="destructive"
                disabled={Boolean(pendingAction)}
                onClick={() => setRemoveOpen(true)}
              >
                Remove
              </Button>
              <Button variant="outline" disabled={Boolean(pendingAction) || !canConfigure} aria-describedby={!canConfigure ? `${id}-domain-availability` : undefined} onClick={() => void verify()}>
                {pendingAction === "verify" && <Spinner data-icon="inline-start" />}
                Check DNS now
              </Button>
            </div>
          </CardFooter>
        )}
      </Card>
      <ConfirmDialog
        open={removeOpen}
        title={`Remove ${record.domain ?? "custom domain"}?`}
        description="Delivery through this hostname stops immediately. Standard workspace URLs keep working."
        confirmLabel="Remove domain"
        onCancel={() => setRemoveOpen(false)}
        onConfirm={remove}
      />
    </>
  );
}

function DnsRow({ type, name, value }: { type: string; name: string; value: string }) {
  return (
    <TableRow>
      <TableCell>
        <Badge variant="outline">{type}</Badge>
      </TableCell>
      <TableCell>
        <span className="flex items-center gap-1 font-mono text-xs">
          <span className="truncate">{name}</span>
          <CopyIconButton text={name} label={`Copy ${type} name`} />
        </span>
      </TableCell>
      <TableCell>
        <span className="flex items-center gap-1 font-mono text-xs">
          <span className="truncate">{value}</span>
          <CopyIconButton text={value} label={`Copy ${type} value`} />
        </span>
      </TableCell>
    </TableRow>
  );
}

function ApiKeysSettings({ workspaceId }: { workspaceId: string }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<{ id: string; name: string } | null>(null);
  const keys = useQuery({
    queryKey: ["workspace-api-keys", workspaceId],
    queryFn: () => listWorkspaceApiKeys(workspaceId),
  });

  async function revoke(keyId: string) {
    await deleteWorkspaceApiKey(workspaceId, keyId);
    await queryClient.invalidateQueries({ queryKey: ["workspace-api-keys", workspaceId] });
    toast.success("API key revoked");
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>API keys</CardTitle>
          <CardDescription>
            For CI and scripts. Use one key per integration, set as <code>VARDUM_API_KEY</code>.
          </CardDescription>
          <CardAction>
            <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
              <PlusIcon data-icon="inline-start" />
              New key
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          {keys.isPending ? (
            <Spinner />
          ) : keys.isError ? (
            <FieldError>{keys.error.message}</FieldError>
          ) : keys.data.keys.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Access</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Last used</TableHead>
                  <TableHead>
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {keys.data.keys.map((key) => (
                  <TableRow key={key.id}>
                    <TableCell>
                      <span className="flex flex-col">
                        <span className="font-medium">{key.name ?? "Unnamed key"}</span>
                        <span className="font-mono text-xs text-muted-foreground">
                          {key.start ?? "varda_"}••••
                        </span>
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge variant={key.access === "write" ? "secondary" : "outline"}>
                        {key.access === "write" ? "Read + write" : "Read only"}
                      </Badge>
                    </TableCell>
                    <TableCell>{dateOnly.format(new Date(key.createdAt))}</TableCell>
                    <TableCell>
                      <span className="text-muted-foreground">
                        {key.lastRequest ? timeAgo(key.lastRequest) : "Never"}
                      </span>
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setRevokeTarget({ id: key.id, name: key.name ?? "Unnamed key" })}
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
                  <KeyRoundIcon />
                </EmptyMedia>
                <EmptyTitle>No API keys</EmptyTitle>
                <EmptyDescription>
                  For local work, <code>vardum login</code> creates a key for you.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </CardContent>
      </Card>
      <NewApiKeyDialog open={open} workspaceId={workspaceId} onClose={() => setOpen(false)} />
      <ConfirmDialog
        open={Boolean(revokeTarget)}
        title={`Revoke “${revokeTarget?.name ?? ""}”?`}
        description="Requests using this key fail immediately."
        confirmLabel="Revoke key"
        onCancel={() => setRevokeTarget(null)}
        onConfirm={() => (revokeTarget ? revoke(revokeTarget.id) : Promise.resolve())}
      />
    </>
  );
}

function NewApiKeyDialog({
  open,
  workspaceId,
  onClose,
}: {
  open: boolean;
  workspaceId: string;
  onClose: () => void;
}) {
  const id = useId();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [secret, setSecret] = useState("");

  async function createKey(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError("");
    try {
      const created = await createWorkspaceApiKey(workspaceId, {
        name: String(form.get("name")),
        access: String(form.get("access")) as "read" | "write",
      });
      setSecret(created.key);
      await queryClient.invalidateQueries({ queryKey: ["workspace-api-keys", workspaceId] });
    } catch (cause) {
      setError(errorMessage(cause, "API key creation failed"));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next || pending) return;
        setError("");
        setSecret("");
        onClose();
      }}
    >
      <DialogContent>
        {secret ? (
          <FieldGroup>
            <DialogHeader>
              <DialogTitle>Copy your new key</DialogTitle>
              <DialogDescription>It is shown only once. Store it in your secret manager.</DialogDescription>
            </DialogHeader>
            <InputGroup>
              <InputGroupInput readOnly value={secret} aria-label="New API key" />
              <InputGroupAddon align="inline-end">
                <CopyIconButton text={secret} label="Copy key" />
              </InputGroupAddon>
            </InputGroup>
            <DialogFooter>
              <Button
                onClick={() => {
                  setSecret("");
                  onClose();
                }}
              >
                Done
              </Button>
            </DialogFooter>
          </FieldGroup>
        ) : (
          <form onSubmit={createKey}>
            <FieldGroup>
              <DialogHeader>
                <DialogTitle>New API key</DialogTitle>
              </DialogHeader>
              <Field>
                <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
                <Input
                  id={`${id}-name`}
                  name="name"
                  placeholder="Website CI"
                  minLength={1}
                  maxLength={32}
                  autoComplete="off"
                  autoFocus
                  required
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`${id}-access`}>Access</FieldLabel>
                <NativeSelect id={`${id}-access`} name="access" defaultValue="read">
                  <NativeSelectOption value="read">Read only</NativeSelectOption>
                  <NativeSelectOption value="write">Read + write</NativeSelectOption>
                </NativeSelect>
                <FieldDescription>
                  Read only is enough for <code>vardum pull</code>. Write also allows upload,
                  delete and publish.
                </FieldDescription>
              </Field>
              {error && <FieldError>{error}</FieldError>}
              <DialogFooter>
                <Button type="submit" disabled={pending}>
                  {pending && <Spinner data-icon="inline-start" />}
                  Create key
                </Button>
              </DialogFooter>
            </FieldGroup>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function DangerZone({ workspace }: { workspace: WorkspaceRef }) {
  const id = useId();
  const [confirmation, setConfirmation] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);

  async function removeWorkspace() {
    await deleteWorkspace(workspace.id, confirmation);
    window.location.assign("/");
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (confirmation === workspace.slug) setDialogOpen(true);
      }}
    >
      <Card>
        <CardHeader>
          <CardTitle>Delete workspace</CardTitle>
          <CardDescription>
            Permanently deletes every asset, version, folder, Vard, API key and delivery record.
            Members and invitations belong to the organization and stay.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Field>
            <FieldLabel htmlFor={`${id}-confirm`}>
              Type <code>{workspace.slug}</code> to confirm
            </FieldLabel>
            <Input
              id={`${id}-confirm`}
              value={confirmation}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </Field>
        </CardContent>
        <CardFooter>
          <div className="flex w-full justify-end">
            <Button type="submit" variant="destructive" disabled={confirmation !== workspace.slug}>
              Delete workspace
            </Button>
          </div>
        </CardFooter>
      </Card>
      <ConfirmDialog
        open={dialogOpen}
        title={`Delete “${workspace.name}”?`}
        description="All workspace data and stored files are deleted. This cannot be undone."
        confirmLabel="Delete workspace"
        onCancel={() => setDialogOpen(false)}
        onConfirm={removeWorkspace}
      />
    </form>
  );
}
