import { Link } from "@tanstack/react-router";
import type { Crumb } from "@/components/page";

export type WorkspaceRef = {
  id: string;
  name: string;
  slug: string;
  canEdit: boolean;
  canManage: boolean;
};

export function workspaceCrumb(workspace: WorkspaceRef): Crumb {
  return {
    label: workspace.name,
    link: <Link to="/workspaces/$workspaceId" params={{ workspaceId: workspace.id }} />,
  };
}
