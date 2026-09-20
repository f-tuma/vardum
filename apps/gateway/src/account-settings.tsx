import { PageTabs, TabPanel } from "./ui-controls";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type SyntheticEvent } from "react";
import { authClient } from "./auth-client";
import { ConfirmDialog } from "./confirm-dialog";

const dateTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});
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
  return [browser, platform].filter(Boolean).join(" · ");
}

export function AccountSettings() {
  const session = authClient.useSession();
  const queryClient = useQueryClient();
  const [profileStatus, setProfileStatus] = useState(() =>
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("emailChanged") === "true"
      ? "Email updated"
      : "",
  );
  const [profileError, setProfileError] = useState("");
  const [profilePending, setProfilePending] = useState(false);
  const [passwordStatus, setPasswordStatus] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [passwordPending, setPasswordPending] = useState(false);
  const [sessionError, setSessionError] = useState("");
  const [revokeTarget, setRevokeTarget] = useState<RevokeTarget | null>(null);
  const sessions = useQuery({
    queryKey: ["account-sessions"],
    queryFn: async () => {
      const result = await authClient.listSessions();
      if (result.error)
        throw new Error(result.error.message ?? "Session loading failed");
      return result.data ?? [];
    },
    enabled: Boolean(session.data),
  });

  if (!session.data) return null;

  async function updateProfile(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const name = String(data.get("name")).trim();
    const email = String(data.get("email")).trim().toLowerCase();
    setProfileError("");
    setProfileStatus("");
    if (!name) {
      setProfileError("Name is required");
      return;
    }

    setProfilePending(true);
    const result = await authClient.updateUser({ name });
    if (result.error) {
      setProfilePending(false);
      setProfileError(result.error.message ?? "Profile update failed");
      return;
    }
    if (email !== session.data?.user.email.toLowerCase()) {
      const emailResult = await authClient.changeEmail({
        newEmail: email,
        callbackURL: `${window.location.origin}/account?emailChanged=true`,
      });
      setProfilePending(false);
      if (emailResult.error) {
        setProfileError(emailResult.error.message ?? "Email change failed");
        return;
      }
      setProfileStatus(`Verification sent to ${email}`);
      return;
    }
    setProfilePending(false);
    await session.refetch();
    setProfileStatus("Profile updated");
  }

  async function changePassword(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const currentPassword = String(data.get("currentPassword"));
    const newPassword = String(data.get("newPassword"));
    setPasswordError("");
    setPasswordStatus("");
    if (newPassword !== String(data.get("confirmPassword"))) {
      setPasswordError("New passwords do not match");
      return;
    }

    setPasswordPending(true);
    const result = await authClient.changePassword({
      currentPassword,
      newPassword,
      revokeOtherSessions: data.get("revokeOtherSessions") === "on",
    });
    setPasswordPending(false);
    if (result.error) {
      setPasswordError(result.error.message ?? "Password change failed");
      return;
    }
    form.reset();
    await queryClient.invalidateQueries({ queryKey: ["account-sessions"] });
    setPasswordStatus("Password changed");
  }

  async function revokeSessions() {
    if (!revokeTarget) return;
    setSessionError("");
    const result = revokeTarget.token
      ? await authClient.revokeSession({ token: revokeTarget.token })
      : await authClient.revokeOtherSessions();
    if (result.error) {
      setSessionError(result.error.message ?? "Session revoke failed");
      return;
    }
    await queryClient.invalidateQueries({ queryKey: ["account-sessions"] });
  }

  const currentToken = session.data.session.token;
  const orderedSessions = [...(sessions.data ?? [])].sort(
    (left, right) =>
      new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
  );
  const otherSessionCount = orderedSessions.filter(
    ({ token }) => token !== currentToken,
  ).length;

  return (
    <main className="dashboard-main settings-page" id="account">
      <header className="settings-heading">
        <div>
          <h1>Account</h1>
        </div>
        <span>{session.data.user.email}</span>
      </header>

      <PageTabs
        label="Account settings"
        items={[
          ["profile", "Profile"],
          ["password", "Password"],
          ["sessions", "Sessions"],
        ]}
      >
        <TabPanel id="profile">
          <section className="settings-panel" id="profile">
            <header>
              <h2>┌─ PROFILE</h2>
              <span>Personal identity</span>
            </header>
            <form onSubmit={updateProfile}>
              <label>
                Name
                <input
                  name="name"
                  defaultValue={session.data.user.name}
                  maxLength={255}
                  required
                />
              </label>
              <label>
                Email
                <input
                  name="email"
                  type="email"
                  defaultValue={session.data.user.email}
                  autoComplete="email"
                  required
                />
              </label>
              {profileError && (
                <p className="error-strip settings-inline-error" role="alert">
                  {profileError}
                </p>
              )}
              <div className="settings-actions">
                <button
                  className="primary-button"
                  type="submit"
                  disabled={profilePending}
                >
                  {profilePending ? "Saving…" : "Save profile"}
                </button>
                <span role="status">{profileStatus}</span>
              </div>
            </form>
          </section>
        </TabPanel>

        <TabPanel id="password">
          <section className="settings-panel" id="password">
            <header>
              <h2>┌─ PASSWORD</h2>
              <span>Account security</span>
            </header>
            <form onSubmit={changePassword}>
              <label>
                Current password
                <input
                  name="currentPassword"
                  type="password"
                  autoComplete="current-password"
                  required
                />
              </label>
              <label>
                New password
                <input
                  name="newPassword"
                  type="password"
                  autoComplete="new-password"
                  minLength={8}
                  required
                />
              </label>
              <label>
                Confirm new password
                <input
                  name="confirmPassword"
                  type="password"
                  autoComplete="new-password"
                  minLength={8}
                  required
                />
              </label>
              {passwordError && (
                <p className="error-strip settings-inline-error" role="alert">
                  {passwordError}
                </p>
              )}
              <div className="password-actions">
                <label className="checkbox-label">
                  <input
                    name="revokeOtherSessions"
                    type="checkbox"
                    defaultChecked
                  />
                  Sign out all other sessions
                </label>
                <div className="settings-actions">
                  <button
                    className="primary-button"
                    type="submit"
                    disabled={passwordPending}
                  >
                    {passwordPending ? "Changing…" : "Change password"}
                  </button>
                  <span role="status">{passwordStatus}</span>
                </div>
              </div>
            </form>
          </section>
        </TabPanel>

        <TabPanel id="sessions">
          <section className="settings-panel" id="sessions">
            <header>
              <h2>┌─ SESSIONS</h2>
              <span>{orderedSessions.length} active</span>
            </header>
            <div className="session-toolbar">
              <p>Devices currently signed in to this account.</p>
              <button
                className="danger-button"
                type="button"
                disabled={!otherSessionCount}
                onClick={() =>
                  setRevokeTarget({ token: null, label: "all other sessions" })
                }
              >
                Sign out other sessions
              </button>
            </div>
            {sessions.isPending ? (
              <p className="settings-state">Loading sessions…</p>
            ) : sessions.isError ? (
              <p className="error-strip settings-inline-error" role="alert">
                {sessions.error.message}
              </p>
            ) : (
              <div className="session-list">
                {orderedSessions.map((item) => {
                  const current = item.token === currentToken;
                  return (
                    <article className="session-row" key={item.id}>
                      <div className="session-client">
                        <strong>
                          {sessionClient(item.userAgent)}
                          {current && <b>CURRENT</b>}
                        </strong>
                        <small title={item.userAgent ?? undefined}>
                          {item.ipAddress || "IP unavailable"}
                        </small>
                      </div>
                      <div className="session-dates">
                        <small>
                          Signed in {dateTime.format(new Date(item.createdAt))}
                        </small>
                        <small>
                          Expires {dateTime.format(new Date(item.expiresAt))}
                        </small>
                      </div>
                      {!current && (
                        <button
                          className="danger-button"
                          type="button"
                          onClick={() =>
                            setRevokeTarget({
                              token: item.token,
                              label: item.ipAddress || "this session",
                            })
                          }
                        >
                          Revoke
                        </button>
                      )}
                    </article>
                  );
                })}
              </div>
            )}
            {sessionError && (
              <p className="error-strip settings-inline-error" role="alert">
                {sessionError}
              </p>
            )}
          </section>
        </TabPanel>
      </PageTabs>
      <ConfirmDialog
        open={Boolean(revokeTarget)}
        title={`Sign out ${revokeTarget?.label ?? "session"}?`}
        description="The affected devices will need to authenticate again."
        confirmLabel="Sign out"
        onCancel={() => setRevokeTarget(null)}
        onConfirm={revokeSessions}
      />
    </main>
  );
}
