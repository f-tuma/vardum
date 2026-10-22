import { mediaStem, uploadAccept } from "@vardum/shared";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ArchiveIcon,
  CloudDownloadIcon,
  CopyIcon,
  EllipsisIcon,
  ExternalLinkIcon,
  FolderIcon,
  FolderPlusIcon,
  ImagesIcon,
  LinkIcon,
  LayoutGridIcon,
  ListIcon,
  ArrowDownIcon,
  ArrowUpDownIcon,
  ArrowUpIcon,
  SearchIcon,
  RefreshCwIcon,
  Trash2Icon,
  TriangleAlertIcon,
  UploadIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useId, useRef, useState, type DragEvent, type SyntheticEvent } from "react";
import { toast } from "sonner";
import { AssetPageControls } from "@/components/asset-page-controls";
import { AssetThumb } from "@/components/asset-thumb";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { AppHeader, Page, PageHeader, PageSkeleton, type Crumb } from "@/components/page";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Empty,
  EmptyContent,
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
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
} from "@/components/ui/input-group";
import { Kbd } from "@/components/ui/kbd";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import {
  dateTime,
  errorMessage,
  formatBytes,
  formatDimensions,
  formatMimeType,
  timeAgo,
  toKey,
} from "@/lib/format";
import {
  assetDeliveryPath,
  assetPreviewUrl,
  createFolder,
  deleteFolder,
  formatUploadLimit,
  getUploadLimits,
  importAssets,
  type AssetSummary,
} from "./asset-api";
import { assetBrowserQueryOptions, flattenAssetPages } from "./asset-queries";
import { AssetUseDialog, LinkedUses, useLibraryUses } from "./asset-uses";
import { AssetDetail } from "./asset-detail";
import { useUploader } from "./use-uploader";
import { workspaceCrumb, type WorkspaceRef } from "./workspace";

export function AssetDashboard({
  workspace,
  search,
  assetId,
  prefix,
  fromPrefix,
}: {
  workspace: WorkspaceRef;
  search: string;
  assetId?: string;
  prefix: string;
  fromPrefix?: string;
}) {
  const [archiveOpen, setArchiveOpen] = useState(false);
  if (assetId)
    return (
      <AssetDetail workspace={workspace} assetId={assetId} fromPrefix={fromPrefix} fromSearch={search} />
    );
  return archiveOpen
    ? <AssetArchive workspace={workspace} onClose={() => setArchiveOpen(false)} />
    : <AssetBrowser workspace={workspace} search={search} prefix={prefix} onArchive={() => setArchiveOpen(true)} />;
}

function AssetArchive({ workspace, onClose }: { workspace: WorkspaceRef; onClose: () => void }) {
  const [search, setSearch] = useState("");
  const needle = useDebouncedValue(search.trim());
  const listing = useInfiniteQuery(assetBrowserQueryOptions(workspace.id, "", needle, 50, true));
  const { assets } = flattenAssetPages(listing.data?.pages);
  const readOnlyWorkspace = { ...workspace, canEdit: false };
  return (
    <>
      <AppHeader crumbs={[
        workspaceCrumb(workspace),
        { label: "Assets", link: <Link to="/workspaces/$workspaceId/assets" params={{ workspaceId: workspace.id }} search={{ prefix: "" }} onClick={onClose} /> },
        { label: "Archive" },
      ]} />
      <Page id="main">
        <PageHeader
          title="Archive"
          description="Archived sources retain their URLs and versions. Open a source to inspect it or unarchive it."
          actions={<Button variant="outline" onClick={onClose}>Back to assets</Button>}
        />
        <Input type="search" aria-label="Search archived sources" placeholder="Search archived sources" value={search} onChange={(event) => setSearch(event.target.value)} />
        {listing.isPending ? (
          <PageSkeleton />
        ) : listing.isError && !listing.data ? (
          <Alert variant="destructive">
            <AlertTitle>Archive could not load</AlertTitle>
            <AlertDescription>{listing.error.message}</AlertDescription>
          </Alert>
        ) : assets.length ? (
          <ul aria-label="Archived sources" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {assets.map((asset) => <AssetTile key={asset.id} asset={asset} workspace={readOnlyWorkspace} prefix="" search="" />)}
          </ul>
        ) : (
          <Empty variant="outline">
            <EmptyHeader>
              <EmptyTitle>No archived sources</EmptyTitle>
              <EmptyDescription>{search ? "No archived sources match this search." : "Archive a source from its detail page."}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
        {listing.data && (
          <AssetPageControls
            loaded={assets.length}
            hasMore={listing.hasNextPage}
            fetching={listing.isFetching}
            loadingMore={listing.isFetchingNextPage}
            error={listing.isError ? listing.error.message : undefined}
            nextPageError={listing.isFetchNextPageError}
            onMore={() => { void listing.fetchNextPage({ cancelRefetch: false }); }}
            onRetry={() => { void listing.refetch(); }}
          />
        )}
      </Page>
    </>
  );
}

/** Crumbs for a folder path: each segment opens that folder. */
export function folderCrumbs(workspace: WorkspaceRef, prefix: string, search = ""): Crumb[] {
  const segments = prefix.split("/").filter(Boolean);
  return [
    workspaceCrumb(workspace),
    {
      label: "Assets",
      link: (
        <Link
          to="/workspaces/$workspaceId/assets"
          params={{ workspaceId: workspace.id }}
          search={{ prefix: "", ...(search && !segments.length ? { q: search } : {}) }}
        />
      ),
    },
    ...segments.map((segment, index) => ({
      label: segment,
      link: (
        <Link
          to="/workspaces/$workspaceId/assets"
          params={{ workspaceId: workspace.id }}
          search={{ prefix: `${segments.slice(0, index + 1).join("/")}/`, ...(search && index === segments.length - 1 ? { q: search } : {}) }}
        />
      ),
    })),
  ];
}

const viewKey = "vardum.assets.view";

/** Grid or list, remembered per browser; storage can be unavailable, so fall back quietly. */
function useStoredView() {
  const [view, setView] = useState<"grid" | "list">(() => {
    try {
      return window.localStorage.getItem(viewKey) === "list" ? "list" : "grid";
    } catch {
      return "grid";
    }
  });
  function update(next: "grid" | "list") {
    setView(next);
    try {
      window.localStorage.setItem(viewKey, next);
    } catch {
      // Private windows may refuse storage; the choice still holds for this visit.
    }
  }
  return [view, update] as const;
}

function AssetBrowser({
  workspace,
  search,
  prefix,
  onArchive,
}: {
  workspace: WorkspaceRef;
  search: string;
  prefix: string;
  onArchive: () => void;
}) {
  const navigate = useNavigate();
  const uploader = useUploader(workspace.id);
  const queryClient = useQueryClient();
  const needle = useDebouncedValue(search.trim());
  const [dialog, setDialog] = useState<"upload" | "folder" | "import" | "use" | null>(null);
  const [dragging, setDragging] = useState(false);
  const [view, setView] = useStoredView();
  const searchInput = useRef<HTMLInputElement>(null);

  // "/" jumps to search unless the user is already typing somewhere.
  useEffect(() => {
    function focusSearch(event: KeyboardEvent) {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, select")))
        return;
      event.preventDefault();
      searchInput.current?.focus();
    }
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);
  const dragDepth = useRef(0);
  const options = assetBrowserQueryOptions(workspace.id, needle ? "" : prefix, needle);
  const assets = useInfiniteQuery(options);
  const { folders, assets: files } = flattenAssetPages(assets.data?.pages);
  const uses = useLibraryUses(workspace.id, needle ? "" : prefix, needle);
  const linkedCount = uses.data?.pages.reduce((total, page) => total + page.uses.length, 0) ?? 0;
  const loaded = folders.length + files.length + linkedCount;

  function loadMore() {
    if (!assets.isFetching) void assets.fetchNextPage({ cancelRefetch: false });
  }

  function refresh() {
    void uses.refetch();
    if (!assets.isFetching) {
      window.scrollTo({ top: 0 });
      void queryClient.resetQueries({ queryKey: options.queryKey, exact: true });
    }
  }
  const folderName = prefix.split("/").findLast(Boolean);

  function setSearch(value: string) {
    void navigate({
      to: "/workspaces/$workspaceId/assets",
      params: { workspaceId: workspace.id },
      search: { prefix, ...(value ? { q: value } : {}) },
      replace: true,
    });
  }

  function hasFiles(event: DragEvent) {
    return workspace.canEdit && event.dataTransfer.types.includes("Files");
  }

  return (
    <>
      <AppHeader crumbs={folderCrumbs(workspace, prefix)} />
      <Page id="main">
        {/* Dropping files is a pointer shortcut; the Upload button is the keyboard path. */}
        {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
        <section
          aria-label="Assets"
          className="relative flex flex-1 flex-col gap-6"
          onDragEnter={(event) => {
            if (!hasFiles(event)) return;
            dragDepth.current += 1;
            setDragging(true);
          }}
          onDragOver={(event) => {
            if (hasFiles(event)) event.preventDefault();
          }}
          onDragLeave={() => {
            dragDepth.current = Math.max(0, dragDepth.current - 1);
            if (!dragDepth.current) setDragging(false);
          }}
          onDrop={(event) => {
            if (!hasFiles(event)) return;
            event.preventDefault();
            dragDepth.current = 0;
            setDragging(false);
            void uploader.uploadMany([...event.dataTransfer.files], needle ? "" : prefix);
          }}
        >
          <PageHeader
            title={folderName ?? "Assets"}
            description={
              assets.isPending
                ? "Loading…"
                : needle
                  ? `${loaded} ${loaded === 1 ? "match" : "matches"}${assets.hasNextPage ? " loaded" : ""} in all folders`
                  : `${loaded} ${loaded === 1 ? "item" : "items"}${assets.hasNextPage ? " loaded" : ""}`
            }
            actions={
              <>
                <Button variant="outline" onClick={onArchive}><ArchiveIcon data-icon="inline-start" />Archive</Button>
                {workspace.canEdit && <>
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={<Button variant="outline" size="icon" aria-label="More actions" />}
                    >
                      <EllipsisIcon />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => setDialog("folder")}>
                        <FolderPlusIcon />
                        New folder
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setDialog("import")}>
                        <CloudDownloadIcon />
                        Import from bucket
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <Button variant="outline" onClick={() => setDialog("use")}><LinkIcon data-icon="inline-start" />Use existing</Button>
                  <Button onClick={() => setDialog("upload")}>
                    <UploadIcon data-icon="inline-start" />
                    Upload
                  </Button>
                </>}
              </>
            }
          />

          <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="w-full max-w-md">
            <InputGroup>
              <InputGroupAddon>
                <SearchIcon />
              </InputGroupAddon>
              <InputGroupInput
                ref={searchInput}
                id="asset-search"
                type="search"
                value={search}
                placeholder="Search all assets by name or key"
                aria-label="Search assets"
                onChange={(event) => setSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setSearch("");
                }}
              />
              <InputGroupAddon align="inline-end">
                {search ? (
                  <InputGroupButton
                    size="icon-xs"
                    aria-label="Clear search"
                    onClick={() => setSearch("")}
                  >
                    <XIcon />
                  </InputGroupButton>
                ) : (
                  <Kbd>/</Kbd>
                )}
              </InputGroupAddon>
            </InputGroup>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="icon" aria-label="Refresh assets" disabled={assets.isFetching} onClick={refresh}>
              <RefreshCwIcon />
            </Button>
            <ToggleGroup
              variant="outline"
              spacing={0}
              value={[view]}
              onValueChange={(next: string[]) => {
                const chosen = next[0];
                if (chosen === "grid" || chosen === "list") setView(chosen);
              }}
              aria-label="View"
            >
              <ToggleGroupItem value="grid" aria-label="Grid view">
                <LayoutGridIcon />
              </ToggleGroupItem>
              <ToggleGroupItem value="list" aria-label="List view">
                <ListIcon />
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
          </div>

          {assets.isPending ? (
            <PageSkeleton />
          ) : assets.isError && !assets.data ? (
            <Alert variant="destructive">
              <TriangleAlertIcon />
              <AlertTitle>Assets could not load</AlertTitle>
              <AlertDescription>
                {assets.error.message}
                <Button variant="outline" size="sm" onClick={() => { void assets.refetch(); }}>Retry</Button>
              </AlertDescription>
            </Alert>
          ) : (folders.length || files.length) && view === "list" ? (
            <AssetTable
              folders={folders}
              assets={files}
              workspace={workspace}
              prefix={prefix}
              search={search}
              partial={assets.hasNextPage}
            />
          ) : folders.length || files.length ? (
            <div className="flex flex-col gap-6">
              {folders.length > 0 && (
                <ul aria-label="Folders" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                  {folders.map((folder) => (
                    <FolderTile key={folder.prefix} workspace={workspace} folder={folder} />
                  ))}
                </ul>
              )}
              {files.length > 0 && (
                <ul aria-label="Files" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                  {files.map((asset) => (
                    <AssetTile
                      key={asset.id}
                      asset={asset}
                      workspace={workspace}
                      prefix={prefix}
                      search={search}
                    />
                  ))}
                </ul>
              )}
            </div>
          ) : linkedCount || uses.isPending || uses.isError ? null : needle ? (
            <Empty variant="outline">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <SearchIcon />
                </EmptyMedia>
                <EmptyTitle>No matches</EmptyTitle>
                <EmptyDescription>Nothing is named or keyed “{needle}”.</EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button variant="outline" onClick={() => setSearch("")}>
                  Clear search
                </Button>
              </EmptyContent>
            </Empty>
          ) : (
            <Empty variant="outline">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <ImagesIcon />
                </EmptyMedia>
                <EmptyTitle>{prefix ? "Empty folder" : "No assets yet"}</EmptyTitle>
                <EmptyDescription>
                  {workspace.canEdit
                    ? "Drop files here or upload them."
                    : "Files your team uploads appear here."}
                </EmptyDescription>
              </EmptyHeader>
              {workspace.canEdit && (
                <EmptyContent>
                  <Button onClick={() => setDialog("upload")}>
                    <UploadIcon data-icon="inline-start" />
                    Upload
                  </Button>
                </EmptyContent>
              )}
            </Empty>
          )}

          <LinkedUses workspace={workspace} listing={uses} />

          {assets.data && (assets.hasNextPage || assets.data.pages.length > 1 || assets.isError) && (
            <AssetPageControls
              loaded={loaded}
              hasMore={assets.hasNextPage}
              fetching={assets.isFetching}
              loadingMore={assets.isFetchingNextPage}
              error={assets.isError ? assets.error.message : undefined}
              nextPageError={assets.isFetchNextPageError}
              onMore={loadMore}
              onRetry={() => { void assets.refetch(); }}
            />
          )}

          {dragging && (
            <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-background/80">
              <span className="flex items-center gap-2 font-medium">
                <UploadIcon aria-hidden="true" />
                Drop to upload to {prefix ? `/${prefix}` : "this workspace"}
              </span>
            </div>
          )}
        </section>
      </Page>

      {dialog === "use" ? <AssetUseDialog workspace={workspace} prefix={needle ? "" : prefix} onClose={() => setDialog(null)} /> : null}
      <UploadDialog
        open={dialog === "upload"}
        prefix={prefix}
        onClose={() => setDialog(null)}
        uploader={uploader}
      />
      <NewFolderDialog
        open={dialog === "folder"}
        workspaceId={workspace.id}
        prefix={prefix}
        onClose={() => setDialog(null)}
      />
      <ImportDialog
        open={dialog === "import"}
        workspaceId={workspace.id}
        prefix={prefix}
        onClose={() => setDialog(null)}
      />
    </>
  );
}

function FolderActions({
  workspace,
  folder,
}: {
  workspace: WorkspaceRef;
  folder: { name: string; prefix: string };
}) {
  const queryClient = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);

  async function remove() {
    await deleteFolder(workspace.id, folder.prefix);
    await queryClient.invalidateQueries({ queryKey: ["assets", workspace.id] });
    toast.success(`Folder “${folder.name}” deleted`);
  }

  if (!workspace.canEdit) return null;
  return (
    <div className="relative z-10">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="icon-xs" aria-label={`Actions for ${folder.name}`} />}
        >
          <EllipsisIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem variant="destructive" onClick={() => setConfirmOpen(true)}>
            <Trash2Icon />
            Delete folder
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmDialog
        open={confirmOpen}
        title={`Delete folder “${folder.name}”?`}
        description="Only empty folders can be deleted."
        confirmLabel="Delete folder"
        onCancel={() => setConfirmOpen(false)}
        onConfirm={remove}
      />
    </div>
  );
}

function FolderLink({
  workspace,
  folder,
}: {
  workspace: WorkspaceRef;
  folder: { name: string; prefix: string };
}) {
  return (
    <Link
      to="/workspaces/$workspaceId/assets"
      params={{ workspaceId: workspace.id }}
      search={{ prefix: folder.prefix }}
      className="min-w-0 flex-1 truncate font-mono text-sm outline-none after:absolute after:inset-0 after:rounded-lg focus-visible:after:ring-3 focus-visible:after:ring-ring/50"
    >
      {folder.name}
      <span className="text-muted-foreground">/</span>
    </Link>
  );
}

function FolderTile({
  workspace,
  folder,
}: {
  workspace: WorkspaceRef;
  folder: { name: string; prefix: string };
}) {
  return (
    <li className="relative flex items-center gap-3 rounded-lg border bg-card px-3 py-2.5 transition-colors hover:bg-muted">
      <FolderIcon aria-hidden="true" className="size-5 shrink-0 text-brand" />
      <FolderLink workspace={workspace} folder={folder} />
      <FolderActions workspace={workspace} folder={folder} />
    </li>
  );
}

function statusBadge(asset: Pick<AssetSummary, "status">) {
  if (asset.status === "processing" || asset.status === "pending")
    return (
      <Badge variant="secondary">
        <Spinner data-icon="inline-start" />
        Processing
      </Badge>
    );
  if (asset.status === "failed") return <Badge variant="destructive">Failed</Badge>;
  if (!asset.status) return <Badge variant="secondary">Empty</Badge>;
  return null;
}

export { statusBadge };

function AssetLink({
  asset,
  workspace,
  prefix,
  search,
}: {
  asset: AssetSummary;
  workspace: WorkspaceRef;
  prefix: string;
  search: string;
}) {
  return (
    <Link
      to="/workspaces/$workspaceId/assets/$assetId"
      params={{ workspaceId: workspace.id, assetId: asset.id }}
      search={{ from: prefix, ...(search ? { q: search } : {}) }}
      className="truncate text-sm font-medium outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:ring-3 focus-visible:after:ring-ring/50"
    >
      {asset.displayName}
    </Link>
  );
}

function AssetActions({ asset, workspace }: { asset: AssetSummary; workspace: WorkspaceRef }) {
  if (!asset.currentVersionId) return null;
  const path = assetDeliveryPath(workspace.slug, asset);

  async function copyUrl() {
    try {
      await navigator.clipboard.writeText(new URL(path, window.location.origin).href);
      toast.success("URL copied");
    } catch {
      toast.error("Copy failed");
    }
  }

  return (
    <div className="relative z-10">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="ghost" size="icon-xs" aria-label={`Actions for ${asset.displayName}`} />
          }
        >
          <EllipsisIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => void copyUrl()}>
            <CopyIcon />
            Copy URL
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => window.open(path, "_blank", "noopener")}>
            <ExternalLinkIcon />
            Open file
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function AssetTile({
  asset,
  workspace,
  prefix,
  search,
}: {
  asset: AssetSummary;
  workspace: WorkspaceRef;
  prefix: string;
  search: string;
}) {
  const badge = statusBadge(asset);
  return (
    <li className="group relative flex flex-col overflow-hidden rounded-xl border bg-card transition-colors hover:border-ring">
      <div className="relative aspect-4/3 shrink-0 overflow-hidden bg-muted bg-cells">
        <div className="absolute inset-0">
          <AssetThumb url={assetPreviewUrl(workspace.slug, asset)} mimeType={asset.mimeType} />
        </div>
        {badge && <div className="absolute top-2 left-2">{badge}</div>}
      </div>
      <div className="flex shrink-0 items-start gap-1 p-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <AssetLink asset={asset} workspace={workspace} prefix={prefix} search={search} />
          <span className="truncate font-mono text-xs text-muted-foreground">{asset.key}</span>
          <span className="truncate text-xs text-muted-foreground">
            {[
              asset.mimeType ? formatMimeType(asset.mimeType) : null,
              asset.width ? formatDimensions(asset) : null,
              asset.size ? formatBytes(asset.size) : null,
              asset.isPublic ? "Public" : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </div>
        <AssetActions asset={asset} workspace={workspace} />
      </div>
    </li>
  );
}

type SortKey = "name" | "size" | "updated";
type Sort = { key: SortKey; direction: "asc" | "desc" };

function sortAssets(assets: AssetSummary[], sort: Sort) {
  const factor = sort.direction === "asc" ? 1 : -1;
  return assets.toSorted((left, right) => {
    if (sort.key === "size") return ((left.size ?? 0) - (right.size ?? 0)) * factor;
    if (sort.key === "updated")
      return (new Date(left.updatedAt).getTime() - new Date(right.updatedAt).getTime()) * factor;
    return left.displayName.localeCompare(right.displayName) * factor;
  });
}

function SortableHead({
  label,
  column,
  sort,
  onSort,
}: {
  label: string;
  column: SortKey;
  sort: Sort;
  onSort: (sort: Sort) => void;
}) {
  const active = sort.key === column;
  return (
    <TableHead aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}>
      <Button
        variant="ghost"
        size="xs"
        onClick={() =>
          onSort({
            key: column,
            direction: active && sort.direction === "asc" ? "desc" : active ? "asc" : column === "name" ? "asc" : "desc",
          })
        }
      >
        {label}
        {active ? (
          sort.direction === "asc" ? (
            <ArrowUpIcon data-icon="inline-end" />
          ) : (
            <ArrowDownIcon data-icon="inline-end" />
          )
        ) : (
          <ArrowUpDownIcon data-icon="inline-end" />
        )}
      </Button>
    </TableHead>
  );
}

function AssetTable({
  folders,
  assets,
  workspace,
  prefix,
  search,
  partial,
}: {
  folders: Array<{ name: string; prefix: string }>;
  assets: AssetSummary[];
  workspace: WorkspaceRef;
  prefix: string;
  search: string;
  partial: boolean;
}) {
  const [sort, setSort] = useState<Sort>({ key: "name", direction: "asc" });
  return (
    <div className="flex flex-col gap-2">
      {partial && <p className="text-xs text-muted-foreground">Sorts loaded files.</p>}
      <div className="rounded-xl border">
      <Table>
        <TableHeader>
          <TableRow>
            <SortableHead label="Name" column="name" sort={sort} onSort={setSort} />
            <TableHead>Type</TableHead>
            <TableHead>Dimensions</TableHead>
            <SortableHead label="Size" column="size" sort={sort} onSort={setSort} />
            <SortableHead label="Updated" column="updated" sort={sort} onSort={setSort} />
            <TableHead>
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {folders.map((folder) => (
            <TableRow key={folder.prefix}>
              <TableCell>
                <span className="relative flex items-center gap-3">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted">
                    <FolderIcon aria-hidden="true" className="size-4 text-brand" />
                  </span>
                  <FolderLink workspace={workspace} folder={folder} />
                </span>
              </TableCell>
              <TableCell>
                <span className="text-muted-foreground">Folder</span>
              </TableCell>
              <TableCell />
              <TableCell />
              <TableCell />
              <TableCell>
                <div className="flex justify-end">
                  <FolderActions workspace={workspace} folder={folder} />
                </div>
              </TableCell>
            </TableRow>
          ))}
          {sortAssets(assets, sort).map((asset) => {
            const badge = statusBadge(asset);
            return (
              <TableRow key={asset.id}>
                <TableCell>
                  <span className="relative flex min-w-0 items-center gap-3">
                    <span className="size-9 shrink-0 overflow-hidden rounded-md bg-muted">
                      <AssetThumb url={assetPreviewUrl(workspace.slug, asset)} mimeType={asset.mimeType} />
                    </span>
                    <span className="flex min-w-0 flex-col">
                      <span className="flex min-w-0 items-center gap-2">
                        <AssetLink asset={asset} workspace={workspace} prefix={prefix} search={search} />
                        {badge}
                        {asset.isPublic && <Badge variant="outline">Public</Badge>}
                      </span>
                      <span className="truncate font-mono text-xs text-muted-foreground">{asset.key}</span>
                    </span>
                  </span>
                </TableCell>
                <TableCell>
                  <span className="text-muted-foreground">
                    {asset.mimeType ? formatMimeType(asset.mimeType) : "—"}
                  </span>
                </TableCell>
                <TableCell>
                  <span className="text-muted-foreground tabular-nums">{formatDimensions(asset)}</span>
                </TableCell>
                <TableCell>
                  <span className="text-muted-foreground tabular-nums">
                    {asset.size ? formatBytes(asset.size) : "—"}
                  </span>
                </TableCell>
                <TableCell>
                  <time
                    dateTime={asset.updatedAt}
                    title={dateTime.format(new Date(asset.updatedAt))}
                    className="text-muted-foreground"
                  >
                    {timeAgo(asset.updatedAt)}
                  </time>
                </TableCell>
                <TableCell>
                  <div className="flex justify-end">
                    <AssetActions asset={asset} workspace={workspace} />
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      </div>
    </div>
  );
}

export function UploadLimitDescription() {
  const limits = useQuery({
    queryKey: ["upload-limits"],
    queryFn: getUploadLimits,
    staleTime: Number.POSITIVE_INFINITY,
  });
  if (!limits.data) return null;
  return (
    <FieldDescription>
      Images up to {formatUploadLimit(limits.data.image)}, videos up to{" "}
      {formatUploadLimit(limits.data.video)}.
    </FieldDescription>
  );
}

function UploadDialog({
  open,
  prefix,
  onClose,
  uploader,
}: {
  open: boolean;
  prefix: string;
  onClose: () => void;
  uploader: ReturnType<typeof useUploader>;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        {open && <UploadForm prefix={prefix} onDone={onClose} uploader={uploader} />}
      </DialogContent>
    </Dialog>
  );
}

function UploadForm({
  prefix,
  onDone,
  uploader,
}: {
  prefix: string;
  onDone: () => void;
  uploader: ReturnType<typeof useUploader>;
}) {
  const id = useId();
  const [files, setFiles] = useState<File[]>([]);
  const [displayName, setDisplayName] = useState("");
  const [key, setKey] = useState("");
  const [keyEdited, setKeyEdited] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const single = files.length <= 1;

  function chooseFiles(list: FileList | null) {
    const chosen = [...(list ?? [])];
    setFiles(chosen);
    setError("");
    const first = chosen[0];
    if (chosen.length === 1 && first) {
      const name = displayName || mediaStem(first.name);
      setDisplayName(name);
      if (!keyEdited) setKey(toKey(name));
    }
  }

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !files.length) return;
    setPending(true);
    setError("");
    try {
      const first = files[0];
      if (single && first) await uploader.uploadNew(first, { prefix, key, displayName });
      else await uploader.uploadMany(files, prefix);
      onDone();
    } catch (cause) {
      setError(errorMessage(cause, "Upload failed"));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <FieldGroup>
        <DialogHeader>
          <DialogTitle>Upload</DialogTitle>
          <DialogDescription>
            {prefix ? <>To <code>/{prefix}</code></> : "To the workspace root"}
          </DialogDescription>
        </DialogHeader>
        <Field>
          <FieldLabel htmlFor={`${id}-file`}>Files</FieldLabel>
          <Input
            id={`${id}-file`}
            name="file"
            type="file"
            accept={uploadAccept}
            multiple
            required
            onChange={(event) => chooseFiles(event.currentTarget.files)}
          />
          <UploadLimitDescription />
        </Field>
        {files.length === 1 ? (
          <>
            <Field>
              <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
              <Input
                id={`${id}-name`}
                value={displayName}
                required
                onChange={(event) => {
                  setDisplayName(event.target.value);
                  if (!keyEdited) setKey(toKey(event.target.value));
                }}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-key`}>Key</FieldLabel>
              <InputGroup>
                {prefix && (
                  <InputGroupAddon>
                    <InputGroupText>{prefix}</InputGroupText>
                  </InputGroupAddon>
                )}
                <InputGroupInput
                  id={`${id}-key`}
                  value={key}
                  placeholder="logo"
                  pattern="[a-z0-9._\-]+"
                  spellCheck={false}
                  required
                  onChange={(event) => {
                    setKey(event.target.value);
                    setKeyEdited(true);
                  }}
                />
              </InputGroup>
              <FieldDescription>Part of the delivery URL.</FieldDescription>
            </Field>
          </>
        ) : files.length > 1 ? (
          <FieldDescription>
            {files.length} files · names and keys come from the file names.
          </FieldDescription>
        ) : null}
        {error && <FieldError>{error}</FieldError>}
        <DialogFooter>
          <Button type="submit" disabled={pending || !files.length}>
            {pending && <Spinner data-icon="inline-start" />}
            {single ? "Upload" : `Upload ${files.length} files`}
          </Button>
        </DialogFooter>
      </FieldGroup>
    </form>
  );
}

function NewFolderDialog({
  open,
  workspaceId,
  prefix,
  onClose,
}: {
  open: boolean;
  workspaceId: string;
  prefix: string;
  onClose: () => void;
}) {
  const id = useId();
  const queryClient = useQueryClient();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const name = toKey(String(new FormData(event.currentTarget).get("name")));
    setPending(true);
    setError("");
    try {
      await createFolder(workspaceId, prefix, name);
      await queryClient.invalidateQueries({ queryKey: ["assets", workspaceId] });
      onClose();
    } catch (cause) {
      setError(errorMessage(cause, "Folder creation failed"));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !pending) {
          setError("");
          onClose();
        }
      }}
    >
      <DialogContent>
        <form onSubmit={submit}>
          <FieldGroup>
            <DialogHeader>
              <DialogTitle>New folder</DialogTitle>
              {prefix && (
                <DialogDescription>
                  Inside <code>/{prefix}</code>
                </DialogDescription>
              )}
            </DialogHeader>
            <Field>
              <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
              <Input
                id={`${id}-name`}
                name="name"
                placeholder="brand-assets"
                maxLength={80}
                autoComplete="off"
                autoFocus
                required
              />
              <FieldDescription>Lowercase letters, numbers, dots and dashes.</FieldDescription>
            </Field>
            {error && <FieldError>{error}</FieldError>}
            <DialogFooter>
              <Button type="submit" disabled={pending}>
                {pending && <Spinner data-icon="inline-start" />}
                Create folder
              </Button>
            </DialogFooter>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ImportDialog({
  open,
  workspaceId,
  prefix,
  onClose,
}: {
  open: boolean;
  workspaceId: string;
  prefix: string;
  onClose: () => void;
}) {
  const id = useId();
  const queryClient = useQueryClient();
  const [error, setError] = useState("");
  const [progress, setProgress] = useState("");
  const [pending, setPending] = useState(false);

  // The endpoint walks one page per call, so the loop lives here and the user
  // watches the count climb instead of waiting on one long request.
  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const source = String(new FormData(event.currentTarget).get("source"));
    setPending(true);
    setError("");
    setProgress("");
    try {
      let imported = 0;
      let skipped = 0;
      let token: string | undefined;
      do {
        // oxlint-disable-next-line no-await-in-loop -- each page needs the previous page's token
        const page = await importAssets(workspaceId, { source, prefix, token });
        imported += page.imported;
        skipped += page.skipped;
        token = page.nextToken ?? undefined;
        setProgress(`${imported} imported, ${skipped} skipped…`);
      } while (token);
      await queryClient.invalidateQueries({ queryKey: ["assets", workspaceId] });
      toast.success(`${imported} imported, ${skipped} skipped`);
      onClose();
    } catch (cause) {
      setError(errorMessage(cause, "Import failed"));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !pending) {
          setError("");
          setProgress("");
          onClose();
        }
      }}
    >
      <DialogContent>
        <form onSubmit={submit}>
          <FieldGroup>
            <DialogHeader>
              <DialogTitle>Import from bucket</DialogTitle>
              <DialogDescription>
                Adopt objects already in the storage bucket{prefix && <> into <code>/{prefix}</code></>}.
              </DialogDescription>
            </DialogHeader>
            <Field>
              <FieldLabel htmlFor={`${id}-source`}>Bucket prefix</FieldLabel>
              <Input
                id={`${id}-source`}
                name="source"
                placeholder="legacy-photos/"
                maxLength={1024}
                autoFocus
                required
              />
              <output className="text-sm text-muted-foreground">{progress}</output>
            </Field>
            {error && <FieldError>{error}</FieldError>}
            <DialogFooter>
              <Button type="submit" disabled={pending}>
                {pending && <Spinner data-icon="inline-start" />}
                Import
              </Button>
            </DialogFooter>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}
