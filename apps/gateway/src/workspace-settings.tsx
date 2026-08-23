import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
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
import { ConfirmDialog } from "./confirm-dialog";

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
  return (
    <main className="dashboard-main settings-page" id="settings">
      <header className="settings-heading">
        <h1>Settings</h1>
        <span>Workspace identity, delivery and developer credentials.</span>
      </header>

      <div className="settings-stack">
        <GeneralSettings
          workspaceId={workspaceId}
          workspaceName={workspaceName}
          workspaceSlug={workspaceSlug}
        />
        <DomainSettings workspaceId={workspaceId} />
        <section className="settings-panel" id="audit-log">
          <header>
            <h2>┌─ AUDIT LOG</h2>
            <span>FULL HISTORY</span>
          </header>
          <div className="panel-action-row">
            <p>
              Who changed what in this workspace, filterable by action and
              actor. The Overview shows only the newest events.
            </p>
            <Link
              to="/workspaces/$workspaceId/audit"
              params={{ workspaceId }}
              className="button-link primary-button"
            >
              Open audit log
            </Link>
          </div>
        </section>
        <ApiKeysSettings workspaceId={workspaceId} />
        <DangerZone
          workspaceId={workspaceId}
          workspaceName={workspaceName}
          workspaceSlug={workspaceSlug}
        />
      </div>
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
    <section className="settings-panel">
      <header>
        <h2>┌─ WORKSPACE IDENTITY</h2>
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
          <small>Shown in the dashboard and workspace selector.</small>
        </label>
        <label>
          Slug
          <input value={workspaceSlug} readOnly aria-readonly="true" />
          <small>Locked because it is part of every stable asset URL.</small>
        </label>
        <div className="settings-url">
          <span>PUBLIC PATH</span>
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
        <h2>┌─ CUSTOM DOMAIN</h2>
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
      {members.isPending ? (
        <p className="settings-state">Loading members…</p>
      ) : members.isError ? (
        <p className="error-strip" role="alert">
          {members.error.message}
        </p>
      ) : (
        <ul className="member-list">
          {members.data.members.map((member) => {
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
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setPendingId("create");
    setError("");
    setMessage("");
    try {
      await createWorkspaceInvitation(workspaceId, {
        email: String(form.get("email")),
        role: String(form.get("role")) as WorkspaceInvitation["role"],
      });
      formElement.reset();
      setMessage("Invitation sent");
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
        <span>{invitations.data?.invitations.length ?? 0} PENDING</span>
      </header>
      <form className="invitation-form" onSubmit={invite}>
        <label>
          Email
          <input name="email" type="email" autoComplete="email" required />
        </label>
        <label>
          Role
          <select name="role" defaultValue="viewer">
            <option value="viewer">Viewer</option>
            <option value="editor">Editor</option>
            <option value="owner">Owner</option>
          </select>
        </label>
        <button className="primary-button" disabled={Boolean(pendingId)}>
          {pendingId === "create" ? "Sending…" : "Send invitation"}
        </button>
      </form>
      {error && (
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
        <h2>┌─ API KEYS</h2>
        <span>{keys.data?.keys.length ?? 0} ACTIVE</span>
      </header>
      <form className="api-key-form" onSubmit={createKey}>
        <label>
          Name
          <input name="name" minLength={1} maxLength={32} required />
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

      {secret && (
        <div className="api-key-secret" role="status">
          <span>NEW KEY // COPY NOW</span>
          <code>{secret.key}</code>
          <button
            type="button"
            onClick={() => void navigator.clipboard.writeText(secret.key)}
          >
            Copy key
          </button>
          <small>This secret will not be shown again.</small>
        </div>
      )}
      {error && (
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
          Type <code>{workspaceSlug}</code> to confirm
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
