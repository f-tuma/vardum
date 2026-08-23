import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState, type SyntheticEvent } from "react";
import {
  createOrganizationWorkspace,
  getOrganizationDirectory,
} from "./asset-api";
import { authClient } from "./auth-client";
import { useCloseDetailsOnOutsideClick } from "./asset-dashboard";
import {
  OrganizationInvitations,
  OrganizationMembers,
} from "./workspace-settings";

export function OrganizationSettings({
  organizationId,
}: {
  organizationId: string;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const directory = useQuery({
    queryKey: ["organizations"],
    queryFn: getOrganizationDirectory,
  });
  const organization = directory.data?.organizations.find(
    ({ id }) => id === organizationId,
  );
  const workspaceDrawerRef = useCloseDetailsOnOutsideClick();
  const [creatingOrganization, setCreatingOrganization] = useState(false);
  const [organizationError, setOrganizationError] = useState("");
  const [workspaceError, setWorkspaceError] = useState("");

  async function createOrganization(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setOrganizationError("");
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const result = await authClient.organization.create({
      name: String(form.get("name")),
      slug: String(form.get("slug")),
    });
    if (result.error) {
      setOrganizationError(
        result.error.message ?? "Organization creation failed",
      );
      return;
    }
    formElement.reset();
    await queryClient.invalidateQueries({ queryKey: ["organizations"] });
    await navigate({
      to: "/organizations/$organizationId/settings",
      params: { organizationId: result.data.id },
    });
    setCreatingOrganization(false);
  }

  async function createWorkspace(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!organization) return;
    setWorkspaceError("");
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    try {
      const workspace = await createOrganizationWorkspace(organization.id, {
        name: String(form.get("name")),
        slug: String(form.get("slug")),
      });
      formElement.reset();
      formElement.closest("details")?.removeAttribute("open");
      await queryClient.invalidateQueries({ queryKey: ["organizations"] });
      await navigate({
        to: "/workspaces/$workspaceId",
        params: { workspaceId: workspace.id },
      });
    } catch (cause) {
      setWorkspaceError(
        cause instanceof Error ? cause.message : "Workspace creation failed",
      );
    }
  }

  if (directory.isPending)
    return <div className="loading">Loading organization…</div>;
  if (directory.isError)
    return (
      <div className="state-panel" role="alert">
        {directory.error.message}
      </div>
    );
  if (!organization)
    return <div className="state-panel">Organization not found.</div>;

  const accessWorkspaceId = organization.workspaces[0]?.id;

  return (
    <main className="dashboard-main settings-page" id="organization-settings">
      <header className="settings-heading">
        <h1>{organization.name}</h1>
        <span>Organization workspaces, members, roles and invitations.</span>
      </header>

      <div className="settings-stack">
        <section className="settings-panel">
          <header>
            <h2>┌─ ORGANIZATION</h2>
            <span>{organization.role.toUpperCase()}</span>
          </header>
          <label>
            Organization
            <select
              value={organization.id}
              onChange={(event) =>
                void navigate({
                  to: "/organizations/$organizationId/settings",
                  params: { organizationId: event.target.value },
                })
              }
            >
              {directory.data.organizations.map((record) => (
                <option key={record.id} value={record.id}>
                  {record.name}
                </option>
              ))}
            </select>
          </label>
          <div className="settings-url">
            <span>SLUG</span>
            <code>{organization.slug}</code>
          </div>
          {directory.data.canCreateOrganization && (
            <div className="settings-actions">
              <span />
              <button
                type="button"
                onClick={() => {
                  setOrganizationError("");
                  setCreatingOrganization((value) => !value);
                }}
              >
                {creatingOrganization ? "Cancel" : "New organization"}
              </button>
            </div>
          )}
          {creatingOrganization && (
            <form onSubmit={createOrganization}>
              <label>
                Name
                <input name="name" required />
              </label>
              <label>
                Slug
                <input name="slug" pattern="[a-z0-9-]+" required />
              </label>
              <button className="primary-button">Create organization</button>
            </form>
          )}
          {organizationError && (
            <p className="error-strip settings-inline-error" role="alert">
              {organizationError}
            </p>
          )}
        </section>

        <section className="settings-panel">
          <header>
            <h2>┌─ WORKSPACES</h2>
            {organization.canCreateWorkspace ? (
              <details
                ref={workspaceDrawerRef}
                className="upload-drawer form-drawer quiet-summary"
              >
                <summary>New workspace</summary>
                <form onSubmit={createWorkspace}>
                  <div className="drawer-row">
                    <label>
                      Name
                      <input name="name" required />
                    </label>
                    <label>
                      Slug
                      <input name="slug" pattern="[a-z0-9-]+" required />
                    </label>
                    <button className="primary-button">Create</button>
                  </div>
                  {workspaceError && (
                    <p className="error-strip" role="alert">
                      {workspaceError}
                    </p>
                  )}
                </form>
              </details>
            ) : (
              <span>{organization.workspaces.length} TOTAL</span>
            )}
          </header>
          {organization.workspaces.length ? (
            <ul className="organization-workspace-list">
              {organization.workspaces.map((workspace) => (
                <li key={workspace.id}>
                  <span>
                    <strong>{workspace.name}</strong>
                    <small>{workspace.slug}</small>
                  </span>
                  <Link
                    to="/workspaces/$workspaceId"
                    params={{ workspaceId: workspace.id }}
                    className="button-link primary-button"
                  >
                    Open
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="settings-state">└─ No workspaces</p>
          )}
        </section>

        {organization.role === "owner" && accessWorkspaceId && (
          <>
            <OrganizationMembers workspaceId={accessWorkspaceId} />
            <OrganizationInvitations workspaceId={accessWorkspaceId} />
          </>
        )}
      </div>
    </main>
  );
}
