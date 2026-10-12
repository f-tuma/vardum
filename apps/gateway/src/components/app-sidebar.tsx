import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  ActivityIcon,
  BoxesIcon,
  Building2Icon,
  CheckIcon,
  ChevronsUpDownIcon,
  ImagesIcon,
  Link2Icon,
  LayoutDashboardIcon,
  LogOutIcon,
  MonitorIcon,
  MoonIcon,
  PlusIcon,
  SettingsIcon,
  SunIcon,
  UserIcon,
} from "lucide-react";
import { useTheme } from "next-themes";
import type { ComponentType } from "react";
import type { OrganizationDirectory } from "@/asset-api";
import { BrandMark } from "@/components/brand";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import { initials } from "@/lib/format";

type Organization = OrganizationDirectory["organizations"][number];
type Workspace = Organization["workspaces"][number];

export function AppSidebar({
  organizations,
  workspace,
  organization,
  user,
  onSignOut,
}: {
  organizations: Organization[];
  workspace?: Workspace;
  organization?: Organization;
  user: { name: string; email: string };
  onSignOut: () => void;
}) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <WorkspaceSwitcher
          organizations={organizations}
          workspace={workspace}
          organization={organization}
        />
      </SidebarHeader>
      <SidebarContent>
        {workspace && (
          <SidebarGroup>
            <SidebarGroupLabel>Workspace</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <NavItem
                  label="Overview"
                  icon={LayoutDashboardIcon}
                  active={pathname === `/workspaces/${workspace.id}`}
                  link={<Link to="/workspaces/$workspaceId" params={{ workspaceId: workspace.id }} />}
                />
                <NavItem
                  label="Assets"
                  icon={ImagesIcon}
                  active={pathname.startsWith(`/workspaces/${workspace.id}/assets`)}
                  link={
                    <Link
                      to="/workspaces/$workspaceId/assets"
                      params={{ workspaceId: workspace.id }}
                      search={{ prefix: "" }}
                    />
                  }
                />
                <NavItem
                  label="Vards"
                  icon={BoxesIcon}
                  active={pathname.startsWith(`/workspaces/${workspace.id}/vards`)}
                  link={<Link to="/workspaces/$workspaceId/vards" params={{ workspaceId: workspace.id }} />}
                />
                <NavItem
                  label="Usage"
                  icon={Link2Icon}
                  active={pathname.startsWith(`/workspaces/${workspace.id}/usage`)}
                  link={<Link to="/workspaces/$workspaceId/usage" params={{ workspaceId: workspace.id }} />}
                />
                <NavItem
                  label="Activity"
                  icon={ActivityIcon}
                  active={pathname.startsWith(`/workspaces/${workspace.id}/activity`)}
                  link={<Link to="/workspaces/$workspaceId/activity" params={{ workspaceId: workspace.id }} />}
                />
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
        <SidebarGroup>
          <SidebarGroupLabel>Manage</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {workspace && (
                <NavItem
                  label="Settings"
                  icon={SettingsIcon}
                  active={pathname.startsWith(`/workspaces/${workspace.id}/settings`)}
                  link={<Link to="/workspaces/$workspaceId/settings" params={{ workspaceId: workspace.id }} />}
                />
              )}
              {organization && (
                <NavItem
                  label="Organization"
                  icon={Building2Icon}
                  active={pathname.startsWith(`/organizations/${organization.id}`)}
                  link={
                    <Link
                      to="/organizations/$organizationId/settings"
                      params={{ organizationId: organization.id }}
                    />
                  }
                />
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <UserMenu user={user} onSignOut={onSignOut} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

function NavItem({
  label,
  icon: Icon,
  active,
  link,
}: {
  label: string;
  icon: ComponentType;
  active: boolean;
  link: React.ReactElement;
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton isActive={active} tooltip={label} render={link}>
        <Icon />
        <span>{label}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function WorkspaceSwitcher({
  organizations,
  workspace,
  organization,
}: {
  organizations: Organization[];
  workspace?: Workspace;
  organization?: Organization;
}) {
  const navigate = useNavigate();
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<SidebarMenuButton size="lg" aria-label="Switch workspace" />}
          >
            <BrandMark />
            <span className="flex min-w-0 flex-1 flex-col text-left leading-tight">
              <span className="truncate font-medium">
                {workspace?.name ?? organization?.name ?? "Vardum"}
              </span>
              <span className="truncate text-xs text-muted-foreground">
                {workspace ? organization?.name : "No workspace"}
              </span>
            </span>
            <ChevronsUpDownIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {organizations.map((record) => (
              <DropdownMenuGroup key={record.id}>
                <DropdownMenuLabel>{record.name}</DropdownMenuLabel>
                {record.workspaces.map((item) => (
                  <DropdownMenuItem
                    key={item.id}
                    onClick={() =>
                      void navigate({
                        to: "/workspaces/$workspaceId",
                        params: { workspaceId: item.id },
                      })
                    }
                  >
                    <span className="flex-1 truncate">{item.name}</span>
                    {item.id === workspace?.id && <CheckIcon />}
                  </DropdownMenuItem>
                ))}
                {record.canCreateWorkspace && (
                  <DropdownMenuItem
                    onClick={() =>
                      void navigate({
                        to: "/organizations/$organizationId/settings",
                        params: { organizationId: record.id },
                        search: { tab: "workspaces", create: true },
                      })
                    }
                  >
                    <PlusIcon />
                    New workspace
                  </DropdownMenuItem>
                )}
              </DropdownMenuGroup>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

function UserMenu({
  user,
  onSignOut,
}: {
  user: { name: string; email: string };
  onSignOut: () => void;
}) {
  const navigate = useNavigate();
  const { theme = "system", setTheme } = useTheme();
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger render={<SidebarMenuButton size="lg" aria-label="Account menu" />}>
            <Avatar>
              <AvatarFallback>{initials(user.name || user.email)}</AvatarFallback>
            </Avatar>
            <span className="flex min-w-0 flex-1 flex-col text-left leading-tight">
              <span className="truncate font-medium">{user.name}</span>
              <span className="truncate text-xs text-muted-foreground">
                {user.email}
              </span>
            </span>
            <ChevronsUpDownIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start">
            <DropdownMenuItem onClick={() => void navigate({ to: "/account" })}>
              <UserIcon />
              Account
            </DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <SunIcon />
                Theme
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup value={theme} onValueChange={setTheme}>
                  <DropdownMenuRadioItem value="light">
                    <SunIcon />
                    Light
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="dark">
                    <MoonIcon />
                    Dark
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="system">
                    <MonitorIcon />
                    System
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onSignOut}>
              <LogOutIcon />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
