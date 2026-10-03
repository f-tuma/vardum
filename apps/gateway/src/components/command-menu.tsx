import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  ActivityIcon,
  BoxesIcon,
  Building2Icon,
  FileIcon,
  FolderIcon,
  ImagesIcon,
  LayoutDashboardIcon,
  RefreshCwIcon,
  SettingsIcon,
  UserIcon,
} from "lucide-react";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { listAssets } from "@/asset-api";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { Spinner } from "@/components/ui/spinner";
import { useDebouncedValue } from "@/hooks/use-debounced-value";

type CommandMenuState = { available: boolean; open: () => void };

const CommandMenuContext = createContext<CommandMenuState>({
  available: false,
  open: () => {},
});

export function useCommandMenu() {
  return useContext(CommandMenuContext);
}

type WorkspaceChoice = {
  id: string;
  name: string;
  organizationName: string;
};

export function CommandMenuProvider({
  workspaceId,
  organizationId,
  workspaces,
  children,
}: {
  workspaceId?: string;
  organizationId?: string;
  workspaces: WorkspaceChoice[];
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const available = Boolean(workspaceId);

  useEffect(() => {
    if (!available) return;
    function toggle(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((current) => !current);
      }
    }
    window.addEventListener("keydown", toggle);
    return () => window.removeEventListener("keydown", toggle);
  }, [available]);

  const state = useMemo(
    () => ({ available, open: () => setOpen(true) }),
    [available],
  );

  return (
    <CommandMenuContext.Provider value={state}>
      {children}
      {workspaceId && (
        <CommandDialog
          open={open}
          onOpenChange={setOpen}
          title="Search"
          description="Find an asset or jump to a page"
        >
          {open && (
            <CommandMenuContent
              workspaceId={workspaceId}
              organizationId={organizationId}
              workspaces={workspaces}
              onDone={() => setOpen(false)}
            />
          )}
        </CommandDialog>
      )}
    </CommandMenuContext.Provider>
  );
}

function CommandMenuContent({
  workspaceId,
  organizationId,
  workspaces,
  onDone,
}: {
  workspaceId: string;
  organizationId?: string;
  workspaces: WorkspaceChoice[];
  onDone: () => void;
}) {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const needle = useDebouncedValue(search.trim());
  const results = useQuery({
    queryKey: ["assets", workspaceId, "", needle],
    queryFn: () => listAssets(workspaceId, "", needle),
    enabled: Boolean(needle),
    retry: false,
  });

  function go(to: () => Promise<void>) {
    onDone();
    void to();
  }

  const pages = [
    {
      label: "Overview",
      icon: LayoutDashboardIcon,
      go: () => navigate({ to: "/workspaces/$workspaceId", params: { workspaceId } }),
    },
    {
      label: "Assets",
      icon: ImagesIcon,
      go: () =>
        navigate({
          to: "/workspaces/$workspaceId/assets",
          params: { workspaceId },
          search: { prefix: "" },
        }),
    },
    {
      label: "Vards",
      icon: BoxesIcon,
      go: () => navigate({ to: "/workspaces/$workspaceId/vards", params: { workspaceId } }),
    },
    {
      label: "Activity",
      icon: ActivityIcon,
      go: () => navigate({ to: "/workspaces/$workspaceId/activity", params: { workspaceId } }),
    },
    {
      label: "Workspace settings",
      icon: SettingsIcon,
      go: () =>
        navigate({ to: "/workspaces/$workspaceId/settings", params: { workspaceId } }),
    },
    ...(organizationId
      ? [
          {
            label: "Organization",
            icon: Building2Icon,
            go: () =>
              navigate({
                to: "/organizations/$organizationId/settings",
                params: { organizationId },
              }),
          },
        ]
      : []),
    {
      label: "Account",
      icon: UserIcon,
      go: () => navigate({ to: "/account" }),
    },
  ];

  // Server search covers assets; pages and workspaces are matched here.
  const query = search.trim().toLowerCase();
  const matches = (text: string) => text.toLowerCase().includes(query);
  const assets = needle ? (results.data?.assets ?? []) : [];
  const folders = needle ? (results.data?.folders ?? []) : [];
  const searchFailed = Boolean(needle && needle === search.trim() && results.isError);
  const shownPages = pages.filter((page) => matches(page.label));
  const shownWorkspaces = workspaces.filter(
    (workspace) =>
      workspace.id !== workspaceId && matches(`${workspace.name} ${workspace.organizationName}`),
  );

  return (
    <Command shouldFilter={false}>
      <CommandInput
        value={search}
        onValueChange={setSearch}
        placeholder="Search assets or pages…"
      />
      {searchFailed && (
        <div className="shrink-0 p-2">
          <Alert variant="destructive">
            <AlertDescription>Asset search failed. Try again or jump to a page.</AlertDescription>
          </Alert>
        </div>
      )}
      <CommandList>
        {!searchFailed && (
          <CommandEmpty>
            {results.isFetching ? (
              <output className="flex items-center justify-center gap-2">
                <Spinner />
                Searching…
              </output>
            ) : "No results"}
          </CommandEmpty>
        )}
        {searchFailed && (
          <CommandGroup heading="Asset search">
            <CommandItem
              value="retry asset search"
              disabled={results.isFetching}
              onSelect={() => { void results.refetch(); }}
            >
              {results.isFetching ? <Spinner /> : <RefreshCwIcon />}
              {results.isFetching ? "Retrying…" : "Retry"}
            </CommandItem>
          </CommandGroup>
        )}
        {assets.length > 0 && (
          <CommandGroup heading="Assets">
            {assets.map((asset) => (
              <CommandItem
                key={asset.id}
                value={`asset ${asset.id} ${asset.displayName} ${asset.key}`}
                onSelect={() =>
                  go(() =>
                    navigate({
                      to: "/workspaces/$workspaceId/assets/$assetId",
                      params: { workspaceId, assetId: asset.id },
                      search: { from: "" },
                    }),
                  )
                }
              >
                <FileIcon />
                <span className="truncate">{asset.displayName}</span>
                <span className="ml-auto truncate font-mono text-xs text-muted-foreground">
                  {asset.key}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {folders.length > 0 && (
          <CommandGroup heading="Folders">
            {folders.map((folder) => (
              <CommandItem
                key={folder.prefix}
                value={`folder ${folder.prefix}`}
                onSelect={() =>
                  go(() =>
                    navigate({
                      to: "/workspaces/$workspaceId/assets",
                      params: { workspaceId },
                      search: { prefix: folder.prefix },
                    }),
                  )
                }
              >
                <FolderIcon />
                <span className="truncate font-mono">{folder.prefix}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {shownPages.length > 0 && (
        <CommandGroup heading="Go to">
          {shownPages.map((page) => (
            <CommandItem key={page.label} onSelect={() => go(page.go)}>
              <page.icon />
              {page.label}
            </CommandItem>
          ))}
        </CommandGroup>
        )}
        {shownWorkspaces.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Switch workspace">
              {shownWorkspaces.map((workspace) => (
                  <CommandItem
                    key={workspace.id}
                    value={`workspace ${workspace.id} ${workspace.organizationName} ${workspace.name}`}
                    onSelect={() =>
                      go(() =>
                        navigate({
                          to: "/workspaces/$workspaceId",
                          params: { workspaceId: workspace.id },
                        }),
                      )
                    }
                  >
                    <LayoutDashboardIcon />
                    <span className="truncate">{workspace.name}</span>
                    <span className="ml-auto text-xs text-muted-foreground">
                      {workspace.organizationName}
                    </span>
                  </CommandItem>
                ))}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </Command>
  );
}
