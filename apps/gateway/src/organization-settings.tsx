import { FilterInput, PageTabs, TabPanel } from "./ui-controls";
import { NameSlugFields } from "./name-slug-fields";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState, type SyntheticEvent } from "react";
import {
  createOrganizationWorkspace,
  getOrganizationDirectory,
} from "./asset-api";
import { authClient } from "./auth-client";
import { OrganizationVerification } from "./organization-verification";
import { FormDialog } from "./form-dialog";
import {
  OrganizationInvitations,
  OrganizationMembers,
} from "./workspace-settings";

export function OrganizationSettings({
  organizationId,
}: {
  organizationId: string;
}) {
  const [workspaceSearch, setWorkspaceSearch] = useState("");
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const directory = useQuery({
    queryKey: ["organizations"],
    queryFn: getOrganizationDirectory,
  });
  const organization = directory.data?.organizations.find(
    ({ id }) => id === organizationId,
  );
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);
  const [creatingOrganization, setCreatingOrganization] = useState(false);
  const [organizationError, setOrganizationError] = useState("");
  const [organizationPending, setOrganizationPending] = useState(false);
  const [workspaceError, setWorkspaceError] = useState("");
  const [workspacePending, setWorkspacePending] = useState(false);

  async function createOrganization(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setOrganizationError("");
    if (organizationPending) return;
    setOrganizationPending(true);
    try {
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
    } catch (cause) {
      setOrganizationError(
        cause instanceof Error ? cause.message : "Organization creation failed",
      );
    } finally {
      setOrganizationPending(false);
    }
  }

  async function createWorkspace(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!organization || workspacePending) return;
    setWorkspacePending(true);
    setWorkspaceError("");
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    try {
      const workspace = await createOrganizationWorkspace(organization.id, {
        name: String(form.get("name")),
        slug: String(form.get("slug")),
      });
      formElement.reset();
      setCreatingWorkspace(false);
      await queryClient.invalidateQueries({ queryKey: ["organizations"] });
      await navigate({
        to: "/workspaces/$workspaceId",
        params: { workspaceId: workspace.id },
      });
    } catch (cause) {
      setWorkspaceError(
        cause instanceof Error ? cause.message : "Workspace creation failed",
      );
    } finally {
      setWorkspacePending(false);
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

      <PageTabs
        label="Organization settings"
        items={[
          ["organization-general", "General"],
          ["organization-workspaces", "Workspaces"],
          ...(organization.role === "owner" && accessWorkspaceId
            ? ([
                ["members", "Members"],
                ["invitations", "Invitations"],
              ] as Array<[string, string]>)
            : []),
        ]}
      >
        <TabPanel id="organization-general">
          <section className="settings-panel" id="organization-general">
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
            {directory.data.organizationCreation?.status ===
              "email_verification_required" && (
              <OrganizationVerification
                emailEnabled={
                  directory.data.organizationCreation.verificationEmailEnabled
                }
              />
            )}
            {directory.data.canCreateOrganization && (
              <div className="settings-actions">
                <span />
                <button
                  type="button"
                  onClick={() => {
                    setOrganizationError("");
                    setCreatingOrganization(true);
                  }}
                >
                  New organization
                </button>
              </div>
            )}
            <FormDialog
              open={creatingOrganization}
              title="New organization"
              pending={organizationPending}
              onClose={() => setCreatingOrganization(false)}
            >
              <form className="creation-form" onSubmit={createOrganization}>
                <NameSlugFields autoFocus />
                {organizationError && (
                  <p className="error-strip" role="alert">
                    {organizationError}
                  </p>
                )}
                <button
                  className="primary-button"
                  disabled={organizationPending}
                >
                  {organizationPending ? "Creating…" : "Create organization"}
                </button>
              </form>
            </FormDialog>
          </section>
        </TabPanel>

        <TabPanel id="organization-workspaces">
          <section className="settings-panel" id="organization-workspaces">
            <header>
              <h2>┌─ WORKSPACES</h2>
              {organization.canCreateWorkspace ? (
                <button
                  type="button"
                  onClick={() => {
                    setWorkspaceError("");
                    setCreatingWorkspace(true);
                  }}
                >
                  New workspace
                </button>
              ) : (
                <span>{organization.workspaces.length} TOTAL</span>
              )}
            </header>
            <FormDialog
              open={creatingWorkspace}
              title="New workspace"
              pending={workspacePending}
              onClose={() => setCreatingWorkspace(false)}
            >
              <form className="creation-form" onSubmit={createWorkspace}>
                <NameSlugFields autoFocus />
                {workspaceError && (
                  <p className="error-strip" role="alert">
                    {workspaceError}
                  </p>
                )}
                <button className="primary-button" disabled={workspacePending}>
                  {workspacePending ? "Creating…" : "Create workspace"}
                </button>
              </form>
            </FormDialog>
            <div className="list-toolbar">
              <FilterInput
                value={workspaceSearch}
                onChange={setWorkspaceSearch}
                label="Find workspaces"
              />
            </div>
            {organization.workspaces.length ? (
              <ul className="organization-workspace-list">
                {organization.workspaces
                  .filter((workspace) =>
                    `${workspace.name} ${workspace.slug}`
                      .toLowerCase()
                      .includes(workspaceSearch.trim().toLowerCase()),
                  )
                  .map((workspace) => (
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
              <p className="settings-state">
                {organization.canCreateWorkspace
                  ? "└─ No workspaces yet. Use New workspace to get started."
                  : "└─ No workspaces yet. Ask an organization owner to create one."}
              </p>
            )}
            {organization.workspaces.length > 0 &&
              !organization.workspaces.some((workspace) =>
                `${workspace.name} ${workspace.slug}`
                  .toLowerCase()
                  .includes(workspaceSearch.trim().toLowerCase()),
              ) && <p className="settings-state">No matching workspaces.</p>}
          </section>
        </TabPanel>

        {organization.role === "owner" && accessWorkspaceId && (
          <>
            <TabPanel id="members">
              <OrganizationMembers workspaceId={accessWorkspaceId} />
            </TabPanel>
            <TabPanel id="invitations">
              <OrganizationInvitations workspaceId={accessWorkspaceId} />
            </TabPanel>
          </>
        )}
      </PageTabs>
    </main>
  );
}
