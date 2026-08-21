import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type SyntheticEvent } from "react";
import {
  createWorkspaceApiKey,
  deleteWorkspaceApiKey,
  listWorkspaceApiKeys,
  listWorkspaceMembers,
  updateWorkspace,
  updateWorkspaceMemberRole,
  type WorkspaceMember,
} from "./asset-api";

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
        <p>WORKSPACE // SETTINGS</p>
        <h1>Settings</h1>
        <span>Identity, access and developer credentials.</span>
      </header>

      <div className="settings-stack">
        <GeneralSettings
          workspaceId={workspaceId}
          workspaceName={workspaceName}
          workspaceSlug={workspaceSlug}
        />
        <MembersSettings workspaceId={workspaceId} />
        <ApiKeysSettings workspaceId={workspaceId} />
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
          <code>/assets/{workspaceSlug}/&#123;key&#125;</code>
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

function MembersSettings({ workspaceId }: { workspaceId: string }) {
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
        <h2>┌─ MEMBERS</h2>
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
                      ? "A workspace needs at least one owner"
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
      <p className="settings-note">
        Invitations need outbound email and will be added with the mail
        provider.
      </p>
    </section>
  );
}

function ApiKeysSettings({ workspaceId }: { workspaceId: string }) {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
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

  async function revoke(keyId: string, name: string) {
    if (
      !window.confirm(
        `Revoke “${name}”? Requests using it will stop immediately.`,
      )
    )
      return;
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
                onClick={() => void revoke(key.id, key.name ?? "Unnamed key")}
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="settings-state">└─ No API keys</p>
      )}
    </section>
  );
}
