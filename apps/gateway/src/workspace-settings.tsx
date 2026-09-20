import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type SyntheticEvent,
} from "react";
import {
  configureWorkspaceDomain,
  createWorkspaceApiKey,
  createWorkspaceInvitation,
  deleteWorkspace,
  deleteWorkspaceApiKey,
  getWorkspaceDomain,
  listWorkspaceApiKeys,
  listWorkspaceInvitations,
  listWorkspaceMembers,
  removeWorkspaceDomain,
  resendWorkspaceInvitation,
  revokeWorkspaceInvitation,
  updateWorkspace,
  updateWorkspaceMemberRole,
  verifyWorkspaceDomain,
  type WorkspaceDomain,
  type WorkspaceInvitation,
  type WorkspaceMember,
} from "./asset-api";
import { InfoTip } from "./info-tip";
import { CopyButton, FilterInput, PageTabs, TabPanel } from "./ui-controls";
import { ConfirmDialog } from "./confirm-dialog";
import { FormDialog } from "./form-dialog";
import { AuditLog } from "./audit-log";

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

export function WorkspaceSettings({
  workspaceId,
  workspaceName,
  workspaceSlug,
}: {
  workspaceId: string;
  workspaceName: string;
  workspaceSlug: string;
}) {
  const { tab } = useSearch({ from: "/workspaces/$workspaceId/settings" });
  const navigate = useNavigate();
  return (
    <main className="dashboard-main settings-page" id="settings">
      <header className="settings-heading">
        <h1>Workspace settings</h1>
        <span>{workspaceName}</span>
      </header>

      <PageTabs
        label="Workspace settings"
        value={tab ?? "workspace-identity"}
        onValueChange={(nextTab) =>
          void navigate({
            to: "/workspaces/$workspaceId/settings",
            params: { workspaceId },
            search: { tab: nextTab },
            replace: true,
          })
        }
        items={[
          ["workspace-identity", "General"],
          ["custom-domain", "Domain"],
          ["api-keys", "API keys"],
          ["activity", "Activity"],
          ["danger-zone", "Danger zone"],
        ]}
      >
        <TabPanel id="workspace-identity">
          <GeneralSettings
            workspaceId={workspaceId}
            workspaceName={workspaceName}
            workspaceSlug={workspaceSlug}
          />
        </TabPanel>
        <TabPanel id="custom-domain" guide="workspace-domain">
          <DomainSettings workspaceId={workspaceId} />
        </TabPanel>
        <TabPanel id="activity">
          <AuditLog workspaceId={workspaceId} />
        </TabPanel>
        <TabPanel id="api-keys" guide="workspace-keys">
          <ApiKeysSettings workspaceId={workspaceId} />
        </TabPanel>
        <TabPanel id="danger-zone">
          <DangerZone
            workspaceId={workspaceId}
            workspaceName={workspaceName}
            workspaceSlug={workspaceSlug}
          />
        </TabPanel>
      </PageTabs>
    </main>
  );
}

function GeneralSettings({
  workspaceId,
  workspaceName,
  workspaceSlug,
}: {
  workspaceId: string;
  workspaceName: string;
  workspaceSlug: string;
}) {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function save(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setMessage("");
    setError("");
    const name = String(new FormData(event.currentTarget).get("name"));
    try {
      await updateWorkspace(workspaceId, name);
      await queryClient.invalidateQueries({ queryKey: ["organizations"] });
      setMessage("Workspace saved");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Update failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="settings-panel" id="workspace-identity">
      <header>
        <h2 className="heading-with-tip">
          ┌─ WORKSPACE IDENTITY
          <InfoTip label="About workspace identity">
            The name appears in the dashboard and workspace selector. The slug
            is locked to keep asset URLs stable.
          </InfoTip>
        </h2>
        <span>GENERAL</span>
      </header>
      <form onSubmit={save}>
        <label>
          Name
          <input
            name="name"
            defaultValue={workspaceName}
            minLength={1}
            maxLength={80}
            required
          />
        </label>
        <label>
          Slug
          <input value={workspaceSlug} readOnly aria-readonly="true" />
        </label>
        <div className="settings-url">
          <span>DELIVERY PATH</span>
          <code>/w/{workspaceSlug}/&#123;key&#125;</code>
        </div>
        {error && (
          <p className="error-strip" role="alert">
            {error}
          </p>
        )}
        <div className="settings-actions">
          <span aria-live="polite">{message}</span>
          <button className="primary-button" disabled={pending}>
            {pending ? "Saving…" : "Save changes"}
          </button>
        </div>
      </form>
    </section>
  );
}

/**
 * Verification hinges on the TXT challenge: a domain proxied through Cloudflare
 * hides its CNAME behind flattened A records, so a missing CNAME is only worth
 * mentioning once ownership is proven.
 */
function verificationMessage(result: {
  status: string;
  checks?: { txt: boolean; cname: boolean };
}) {
  if (result.status === "verified")
    return result.checks?.cname
      ? "Domain verified"
      : "Domain verified — CNAME not visible (normal behind Cloudflare)";
  return "Waiting for the TXT record to propagate…";
}

function DomainSettings({ workspaceId }: { workspaceId: string }) {
  const queryClient = useQueryClient();
  const [pendingAction, setPendingAction] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [removeOpen, setRemoveOpen] = useState(false);
  const autoVerifyingRef = useRef(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const domain = useQuery({
    queryKey: ["workspace-domain", workspaceId],
    queryFn: () => getWorkspaceDomain(workspaceId),
  });

  async function refresh() {
    await queryClient.invalidateQueries({
      queryKey: ["workspace-domain", workspaceId],
    });
  }

  // Auto-verify every 12s while domain is pending (DNS propagation)
  const autoVerify = useCallback(async () => {
    if (domain.data?.status !== "pending" || autoVerifyingRef.current) return;
    autoVerifyingRef.current = true;
    try {
      const result = await verifyWorkspaceDomain(workspaceId);
      setMessage(verificationMessage(result));
      await queryClient.invalidateQueries({
        queryKey: ["workspace-domain", workspaceId],
      });
    } catch {
      // DNS timeouts happen, retry next interval
    } finally {
      autoVerifyingRef.current = false;
    }
  }, [domain.data?.status, workspaceId, queryClient, setMessage]);

  useEffect(() => {
    if (domain.data?.status !== "pending") {
      if (intervalRef.current) clearInterval(intervalRef.current);
      intervalRef.current = null;
      return;
    }
    if (!intervalRef.current) {
      intervalRef.current = setInterval(autoVerify, 12_000);
      autoVerify(); // also try immediately
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      intervalRef.current = null;
    };
  }, [domain.data?.status, autoVerify]);

  async function configure(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setPendingAction("configure");
    setMessage("");
    setError("");
    try {
      await configureWorkspaceDomain(
        workspaceId,
        String(new FormData(event.currentTarget).get("domain")),
      );
      setMessage("Add the DNS records below, then verify the domain");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Domain update failed");
    } finally {
      setPendingAction("");
    }
  }

  async function verify() {
    setPendingAction("verify");
    setMessage("");
    setError("");
    try {
      const result = await verifyWorkspaceDomain(workspaceId);
      setMessage(verificationMessage(result));
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Domain verification failed",
      );
    } finally {
      setPendingAction("");
    }
  }

  async function remove() {
    setError("");
    try {
      await removeWorkspaceDomain(workspaceId);
      setMessage("Custom domain removed");
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Domain removal failed",
      );
    }
  }

  const record: WorkspaceDomain | undefined = domain.data;
  return (
    <section className="settings-panel" id="custom-domain">
      <header>
        <h2 className="heading-with-tip">
          ┌─ CUSTOM DOMAIN
          <InfoTip label="About custom domains">
            Serve assets on your own domain. Save a hostname, add the displayed
            DNS records and verify ownership. HTTPS must be configured with your
            hosting provider.
          </InfoTip>
        </h2>
        <span>
          {record?.status.toUpperCase() ?? "LOADING"}
          {record?.status === "pending" ? " · POLLING" : ""}
        </span>
      </header>
      {domain.isPending ? (
        <p className="settings-state">Loading custom domain…</p>
      ) : domain.isError ? (
        <p className="error-strip settings-inline-error" role="alert">
          {domain.error.message}
        </p>
      ) : (
        <>
          <form className="domain-form" onSubmit={configure}>
            <label>
              Domain
              <input
                key={record?.domain}
                name="domain"
                defaultValue={record?.domain ?? ""}
                placeholder="assets.example.com"
                autoComplete="off"
                spellCheck={false}
                required
              />
            </label>
            <button
              className="primary-button"
              disabled={Boolean(pendingAction)}
            >
              {pendingAction === "configure" ? "Saving…" : "Save domain"}
            </button>
          </form>
          {record?.domain && record.verification && (
            <div className="domain-setup">
              <div>
                <span>TXT</span>
                <code>{record.verification.name}</code>
                <code>{record.verification.value}</code>
              </div>
              <div>
                <span>CNAME</span>
                <code>{record.domain}</code>
                <code>{record.target ?? "Not configured"}</code>
              </div>
              <div className="domain-delivery-example">
                <span>DELIVERY</span>
                <code>https://{record.domain}/w/&#123;key&#125;</code>
              </div>
            </div>
          )}
          {error && (
            <p className="error-strip settings-inline-error" role="alert">
              {error}
            </p>
          )}
          {record?.domain && (
            <div className="domain-actions">
              {message && (
                <p className="settings-message" role="status">
                  {message}
                </p>
              )}
              <button
                type="button"
                disabled={Boolean(pendingAction)}
                onClick={() => void verify()}
              >
                {pendingAction === "verify" ? "Checking DNS…" : "Verify DNS"}
              </button>
              <button
                className="danger-button"
                type="button"
                disabled={Boolean(pendingAction)}
                onClick={() => setRemoveOpen(true)}
              >
                Remove
              </button>
            </div>
          )}
        </>
      )}
      <ConfirmDialog
        open={removeOpen}
        title={`Remove custom domain “${record?.domain ?? ""}”?`}
        description="Delivery through this host will stop immediately. Canonical workspace URLs will keep working."
        confirmLabel="Remove domain"
        onCancel={() => setRemoveOpen(false)}
        onConfirm={remove}
      />
    </section>
  );
}

export function OrganizationMembers({ workspaceId }: { workspaceId: string }) {
  const [search, setSearch] = useState("");
  const queryClient = useQueryClient();
  const [pendingId, setPendingId] = useState("");
  const [error, setError] = useState("");
  const members = useQuery({
    queryKey: ["workspace-members", workspaceId],
    queryFn: () => listWorkspaceMembers(workspaceId),
  });
  const ownerCount =
    members.data?.members.filter(({ role }) => role === "owner").length ?? 0;

  async function changeRole(
    member: WorkspaceMember,
    role: WorkspaceMember["role"],
  ) {
    setPendingId(member.id);
    setError("");
    try {
      await updateWorkspaceMemberRole(workspaceId, member.id, role);
      await queryClient.invalidateQueries({
        queryKey: ["workspace-members", workspaceId],
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Role update failed");
    } finally {
      setPendingId("");
    }
  }

  return (
    <section className="settings-panel" id="members">
      <header>
        <h2>┌─ ORGANIZATION MEMBERS</h2>
        <span>{members.data?.members.length ?? 0} USERS</span>
      </header>
      <div className="list-toolbar">
        <FilterInput value={search} onChange={setSearch} label="Find members" />
      </div>
      {members.isPending ? (
        <p className="settings-state">Loading members…</p>
      ) : members.isError ? (
        <p className="error-strip" role="alert">
          {members.error.message}
        </p>
      ) : (
        <ul className="member-list">
          {members.data.members
            .filter((member) =>
              `${member.name} ${member.email}`
                .toLowerCase()
                .includes(search.trim().toLowerCase()),
            )
            .map((member) => {
              const lastOwner = member.role === "owner" && ownerCount === 1;
              return (
                <li key={member.id}>
                  <span className="avatar">
                    {(member.name || member.email).slice(0, 2).toUpperCase()}
                  </span>
                  <span className="member-identity">
                    <strong>{member.name}</strong>
                    <small>{member.email}</small>
                  </span>
                  <select
                    aria-label={`Role for ${member.email}`}
                    value={member.role}
                    disabled={pendingId === member.id || lastOwner}
                    title={
                      lastOwner
                        ? "An organization needs at least one owner"
                        : undefined
                    }
                    onChange={(event) =>
                      void changeRole(
                        member,
                        event.target.value as WorkspaceMember["role"],
                      )
                    }
                  >
                    <option value="owner">Owner</option>
                    <option value="editor">Editor</option>
                    <option value="viewer">Viewer</option>
                  </select>
                </li>
              );
            })}
        </ul>
      )}
      {members.data &&
        !members.data.members.some((member) =>
          `${member.name} ${member.email}`
            .toLowerCase()
            .includes(search.trim().toLowerCase()),
        ) && <p className="settings-state">No matching members.</p>}
      {error && (
        <p className="error-strip settings-inline-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

export function OrganizationInvitations({
  workspaceId,
}: {
  workspaceId: string;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [pendingId, setPendingId] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [revokeTarget, setRevokeTarget] = useState<WorkspaceInvitation | null>(
    null,
  );
  const invitations = useQuery({
    queryKey: ["workspace-invitations", workspaceId],
    queryFn: () => listWorkspaceInvitations(workspaceId),
  });

  async function invite(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pendingId) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setPendingId("create");
    setError("");
    setMessage("");
    try {
      const created = await createWorkspaceInvitation(workspaceId, {
        email: String(form.get("email")),
        role: String(form.get("role")) as WorkspaceInvitation["role"],
      });
      formElement.reset();
      setOpen(false);
      setMessage(
        created.emailSent
          ? "Invitation sent"
          : "Invitation created, but the email could not be sent — use Resend",
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Invitation failed");
    } finally {
      await queryClient.invalidateQueries({
        queryKey: ["workspace-invitations", workspaceId],
      });
      setPendingId("");
    }
  }

  async function resend(record: WorkspaceInvitation) {
    setPendingId(record.id);
    setError("");
    setMessage("");
    try {
      await resendWorkspaceInvitation(workspaceId, record.id);
      setMessage(`Invitation resent to ${record.email}`);
      await queryClient.invalidateQueries({
        queryKey: ["workspace-invitations", workspaceId],
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Resend failed");
    } finally {
      setPendingId("");
    }
  }

  async function revoke(record: WorkspaceInvitation) {
    setError("");
    setMessage("");
    try {
      await revokeWorkspaceInvitation(workspaceId, record.id);
      setMessage(`Invitation to ${record.email} revoked`);
      await queryClient.invalidateQueries({
        queryKey: ["workspace-invitations", workspaceId],
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Revoke failed");
    }
  }

  return (
    <section className="settings-panel" id="invitations">
      <header>
        <h2>┌─ ORGANIZATION INVITATIONS</h2>
        <button
          type="button"
          disabled={Boolean(pendingId)}
          onClick={() => {
            setError("");
            setOpen(true);
          }}
        >
          Invite member
        </button>
      </header>
      <FormDialog
        open={open}
        title="Invite member"
        pending={pendingId === "create"}
        onClose={() => setOpen(false)}
      >
        <form className="creation-form" onSubmit={invite}>
          <label>
            Email
            <input
              name="email"
              type="email"
              autoComplete="email"
              autoFocus
              required
            />
          </label>
          <label>
            Role
            <select name="role" defaultValue="viewer">
              <option value="viewer">Viewer</option>
              <option value="editor">Editor</option>
              <option value="owner">Owner</option>
            </select>
          </label>
          {error && (
            <p className="error-strip" role="alert">
              {error}
            </p>
          )}
          <button className="primary-button" disabled={Boolean(pendingId)}>
            {pendingId === "create" ? "Sending…" : "Send invitation"}
          </button>
        </form>
      </FormDialog>
      {!open && error && (
        <p className="error-strip settings-inline-error" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="settings-message" role="status">
          {message}
        </p>
      )}
      {invitations.isPending ? (
        <p className="settings-state">Loading invitations…</p>
      ) : invitations.isError ? (
        <p className="error-strip" role="alert">
          {invitations.error.message}
        </p>
      ) : invitations.data.invitations.length ? (
        <ul className="invitation-list">
          {invitations.data.invitations.map((record) => (
            <li key={record.id}>
              <span className="member-identity">
                <strong>{record.email}</strong>
                <small>
                  {record.role.toUpperCase()} // expires{" "}
                  {dateTime.format(new Date(record.expiresAt))}
                </small>
              </span>
              <div className="invitation-actions">
                <button
                  type="button"
                  disabled={pendingId === record.id}
                  onClick={() => void resend(record)}
                >
                  {pendingId === record.id ? "Sending…" : "Resend"}
                </button>
                <button
                  className="danger-button"
                  type="button"
                  disabled={pendingId === record.id}
                  onClick={() => setRevokeTarget(record)}
                >
                  Revoke
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="settings-state">└─ No pending invitations</p>
      )}
      <ConfirmDialog
        open={Boolean(revokeTarget)}
        title={`Revoke invitation to “${revokeTarget?.email ?? ""}”?`}
        description="The invitation link will stop working immediately."
        confirmLabel="Revoke invitation"
        onCancel={() => setRevokeTarget(null)}
        onConfirm={() =>
          revokeTarget ? revoke(revokeTarget) : Promise.resolve()
        }
      />
    </section>
  );
}

function ApiKeysSettings({ workspaceId }: { workspaceId: string }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [revokeTarget, setRevokeTarget] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [secret, setSecret] = useState<{
    id: string;
    name: string;
    key: string;
  } | null>(null);
  const keys = useQuery({
    queryKey: ["workspace-api-keys", workspaceId],
    queryFn: () => listWorkspaceApiKeys(workspaceId),
  });

  async function createKey(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setPending(true);
    setError("");
    setSecret(null);
    try {
      const created = await createWorkspaceApiKey(workspaceId, {
        name: String(form.get("name")),
        access: String(form.get("access")) as "read" | "write",
      });
      setSecret({
        id: created.id,
        name: created.name ?? "API key",
        key: created.key,
      });
      formElement.reset();
      await queryClient.invalidateQueries({
        queryKey: ["workspace-api-keys", workspaceId],
      });
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "API key creation failed",
      );
    } finally {
      setPending(false);
    }
  }

  async function revoke(keyId: string) {
    setError("");
    try {
      await deleteWorkspaceApiKey(workspaceId, keyId);
      if (secret?.id === keyId) setSecret(null);
      await queryClient.invalidateQueries({
        queryKey: ["workspace-api-keys", workspaceId],
      });
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "API key revoke failed",
      );
    }
  }

  return (
    <section className="settings-panel" id="api-keys">
      <header>
        <h2 className="heading-with-tip">
          ┌─ API KEYS
          <InfoTip label="About API key access">
            Use a separate key for each integration. Read only can fetch files;
            read + write can also publish. Revoke a key to stop its requests.
          </InfoTip>
        </h2>
        <button
          type="button"
          onClick={() => {
            setError("");
            setSecret(null);
            setOpen(true);
          }}
        >
          New API key
        </button>
      </header>
      <FormDialog
        open={open}
        title={secret ? "API key created" : "New API key"}
        pending={pending}
        onClose={() => setOpen(false)}
      >
        {!secret && (
          <form className="creation-form" onSubmit={createKey}>
            <label>
              Name
              <input
                name="name"
                autoFocus
                placeholder="e.g. Website production"
                minLength={1}
                maxLength={32}
                required
              />
            </label>
            <label>
              Access
              <select name="access" defaultValue="read">
                <option value="read">Read only</option>
                <option value="write">Read + write</option>
              </select>
            </label>
            <button className="primary-button" disabled={pending}>
              {pending ? "Creating…" : "Create key"}
            </button>
          </form>
        )}

        {secret && (
          <div className="api-key-secret" role="status">
            <span>NEW KEY // COPY NOW</span>
            <code>{secret.key}</code>
            <CopyButton text={secret.key} label="Copy key" />
            <small>This secret will not be shown again.</small>
          </div>
        )}
        {error && (
          <p className="error-strip settings-inline-error" role="alert">
            {error}
          </p>
        )}
      </FormDialog>
      {!open && error && (
        <p className="error-strip settings-inline-error" role="alert">
          {error}
        </p>
      )}

      {keys.isPending ? (
        <p className="settings-state">Loading API keys…</p>
      ) : keys.isError ? (
        <p className="error-strip" role="alert">
          {keys.error.message}
        </p>
      ) : keys.data.keys.length ? (
        <ul className="api-key-list">
          {keys.data.keys.map((key) => (
            <li key={key.id}>
              <span>
                <strong>{key.name ?? "Unnamed key"}</strong>
                <small>
                  {key.start ?? "varda_"}•••• // {key.access.toUpperCase()} //
                  created {dateTime.format(new Date(key.createdAt))}
                </small>
              </span>
              <button
                className="danger-button"
                type="button"
                onClick={() =>
                  setRevokeTarget({
                    id: key.id,
                    name: key.name ?? "Unnamed key",
                  })
                }
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="settings-state">└─ No API keys</p>
      )}
      <ConfirmDialog
        open={Boolean(revokeTarget)}
        title={`Revoke API key “${revokeTarget?.name ?? ""}”?`}
        description="Requests using this key will stop immediately. This cannot be undone."
        confirmLabel="Revoke key"
        onCancel={() => setRevokeTarget(null)}
        onConfirm={() =>
          revokeTarget ? revoke(revokeTarget.id) : Promise.resolve()
        }
      />
    </section>
  );
}

function DangerZone({
  workspaceId,
  workspaceName,
  workspaceSlug,
}: {
  workspaceId: string;
  workspaceName: string;
  workspaceSlug: string;
}) {
  const [confirmation, setConfirmation] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [error, setError] = useState("");

  async function removeWorkspace() {
    setError("");
    try {
      await deleteWorkspace(workspaceId, confirmation);
      window.location.assign("/");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Workspace deletion failed",
      );
    }
  }

  return (
    <section className="settings-panel danger-zone" id="danger-zone">
      <header>
        <h2>!! DANGER ZONE</h2>
        <span>IRREVERSIBLE</span>
      </header>
      <form
        className="danger-zone-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (confirmation === workspaceSlug) setDialogOpen(true);
        }}
      >
        <div className="danger-zone-copy">
          <strong>Delete {workspaceName}</strong>
          <p>
            Permanently delete every asset, version, folder, API key and
            delivery record in this workspace. Organization members and
            invitations remain.
          </p>
        </div>
        <label>
          <span>
            Type <code>{workspaceSlug}</code> to confirm
          </span>
          <input
            value={confirmation}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setConfirmation(event.target.value)}
          />
        </label>
        {error && (
          <p className="error-strip" role="alert">
            {error}
          </p>
        )}
        <div className="settings-actions">
          <button
            className="danger-button"
            disabled={confirmation !== workspaceSlug}
          >
            Delete workspace
          </button>
        </div>
      </form>
      <ConfirmDialog
        open={dialogOpen}
        title={`Delete workspace “${workspaceName}”?`}
        description="All workspace data and stored files will be permanently deleted. This cannot be undone."
        confirmLabel="Delete workspace"
        onCancel={() => setDialogOpen(false)}
        onConfirm={removeWorkspace}
      />
    </section>
  );
}
