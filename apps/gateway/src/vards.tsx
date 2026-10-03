import type { VardDefinition, VardFolderRule } from "@vardum/shared";
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowRightIcon,
  BoxesIcon,
  ChevronRightIcon,
  FolderIcon,
  PlusIcon,
  SearchIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import { useId, useMemo, useRef, useState, type SyntheticEvent } from "react";
import { toast } from "sonner";
import { AssetThumb } from "@/components/asset-thumb";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CopyButton, CopyIconButton } from "@/components/copy-button";
import { AppHeader, Page, PageHeader, PageSkeleton } from "@/components/page";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { errorMessage, timeAgo } from "@/lib/format";
import {
  assetPreviewUrl,
  createVard,
  deleteVard,
  getVard,
  getVardManifest,
  listAssets,
  listSyncAssets,
  listVards,
  replaceVardItems,
  updateVard,
  type AssetSummary,
  type SyncAsset,
  type TransformationInput,
  type VardItem,
  type VardManifest,
} from "./asset-api";
import { cliSetupCommand, cliSetupCommands, CLI_SETUP_VERSION } from "./cli-setup";
import {
  applyVardMetadata,
  generatedOutputs,
  manualDraftItems,
  refreshVardPreview,
  type DraftItem,
} from "./vard-editor-state";
import { sourcePreview } from "./vard-preview-url";
import { workspaceCrumb, type WorkspaceRef } from "./workspace";

function vardsCrumb(workspace: WorkspaceRef) {
  return {
    label: "Vards",
    link: <Link to="/workspaces/$workspaceId/vards" params={{ workspaceId: workspace.id }} />,
  };
}

export function VardsPage({ workspace }: { workspace: WorkspaceRef }) {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const vards = useQuery({
    queryKey: ["vards", workspace.id],
    queryFn: () => listVards(workspace.id),
  });
  const all = vards.data?.vards ?? [];
  const matching = all.filter((vard) =>
    vard.name.toLowerCase().includes(search.trim().toLowerCase()),
  );

  return (
    <>
      <AppHeader crumbs={[workspaceCrumb(workspace), { label: "Vards" }]} />
      <Page id="main">
        <PageHeader
          title="Vards"
          description="Pick the files each project pulls with the CLI."
          actions={
            workspace.canEdit && (
              <Button onClick={() => setCreating(true)}>
                <PlusIcon data-icon="inline-start" />
                New Vard
              </Button>
            )
          }
        />
        {vards.isPending ? (
          <PageSkeleton />
        ) : vards.isError ? (
          <Alert variant="destructive">
            <TriangleAlertIcon />
            <AlertTitle>Vards could not load</AlertTitle>
            <AlertDescription>{vards.error.message}</AlertDescription>
          </Alert>
        ) : all.length ? (
          <div className="flex flex-col gap-4">
            {all.length > 5 && (
              <div className="max-w-sm">
                <InputGroup>
                  <InputGroupAddon>
                    <SearchIcon />
                  </InputGroupAddon>
                  <InputGroupInput
                    type="search"
                    value={search}
                    placeholder="Filter Vards"
                    aria-label="Filter Vards"
                    onChange={(event) => setSearch(event.target.value)}
                  />
                </InputGroup>
              </div>
            )}
            <div className="rounded-xl border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Access</TableHead>
                    <TableHead>Files</TableHead>
                    <TableHead>Updated</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {matching.map((vard) => (
                    <TableRow key={vard.id}>
                      <TableCell>
                        <Link
                          to="/workspaces/$workspaceId/vards/$vardId"
                          params={{ workspaceId: workspace.id, vardId: vard.id }}
                          className="font-medium hover:underline"
                        >
                          {vard.name}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <Badge variant={vard.isPublic ? "secondary" : "outline"}>
                          {vard.isPublic ? "Public" : "Private"}
                        </Badge>
                      </TableCell>
                      <TableCell>{vard.itemCount.toLocaleString()}</TableCell>
                      <TableCell>
                        <span className="text-muted-foreground">{timeAgo(vard.updatedAt)}</span>
                      </TableCell>
                    </TableRow>
                  ))}
                  {!matching.length && (
                    <TableRow>
                      <TableCell colSpan={4}>
                        <span className="text-muted-foreground">No matching Vards.</span>
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </div>
        ) : (
          <Empty variant="outline">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <BoxesIcon />
              </EmptyMedia>
              <EmptyTitle>No Vards yet</EmptyTitle>
              <EmptyDescription>
                A Vard lists the assets one project needs and where they go.
              </EmptyDescription>
            </EmptyHeader>
            {workspace.canEdit && (
              <EmptyContent>
                <Button onClick={() => setCreating(true)}>
                  <PlusIcon data-icon="inline-start" />
                  New Vard
                </Button>
              </EmptyContent>
            )}
          </Empty>
        )}
      </Page>
      <NewVardDialog
        open={creating}
        workspaceId={workspace.id}
        onClose={() => setCreating(false)}
        onCreated={(vardId) =>
          void navigate({
            to: "/workspaces/$workspaceId/vards/$vardId",
            params: { workspaceId: workspace.id, vardId },
          })
        }
      />
    </>
  );
}

function NewVardDialog({
  open,
  workspaceId,
  onClose,
  onCreated,
}: {
  open: boolean;
  workspaceId: string;
  onClose: () => void;
  onCreated: (vardId: string) => void;
}) {
  const id = useId();
  const queryClient = useQueryClient();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError("");
    try {
      const vard = await createVard(workspaceId, {
        name: String(form.get("name")),
        isPublic: form.get("isPublic") === "on",
      });
      await queryClient.invalidateQueries({ queryKey: ["vards", workspaceId] });
      onClose();
      onCreated(vard.id);
    } catch (cause) {
      setError(errorMessage(cause, "Vard creation failed"));
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
              <DialogTitle>New Vard</DialogTitle>
              <DialogDescription>Usually one per project or repository.</DialogDescription>
            </DialogHeader>
            <Field>
              <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
              <Input
                id={`${id}-name`}
                name="name"
                placeholder="Website"
                maxLength={80}
                autoComplete="off"
                autoFocus
                required
              />
            </Field>
            <PublicManifestField id={`${id}-public`} name="isPublic" />
            {error && <FieldError>{error}</FieldError>}
            <DialogFooter>
              <Button type="submit" disabled={pending}>
                {pending && <Spinner data-icon="inline-start" />}
                Create Vard
              </Button>
            </DialogFooter>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PublicManifestField({
  id,
  name,
  checked,
  disabled,
  onCheckedChange,
}: {
  id: string;
  name?: string;
  checked?: boolean;
  disabled?: boolean;
  onCheckedChange?: (checked: boolean) => void;
}) {
  return (
    <Field orientation="horizontal">
      <FieldContent>
        <FieldLabel htmlFor={id}>Public manifest</FieldLabel>
        <FieldDescription>
          Lets anyone read the file list. Files stay private unless the assets are public.
        </FieldDescription>
      </FieldContent>
      <Switch
        id={id}
        name={name}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
      />
    </Field>
  );
}

export function VardEditor({
  workspace,
  vardId,
}: {
  workspace: WorkspaceRef;
  vardId: string;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canEdit = workspace.canEdit;
  const vard = useQuery({
    queryKey: ["vard", workspace.id, vardId],
    queryFn: () => getVard(workspace.id, vardId),
  });
  const preview = useQuery({
    queryKey: ["vard-preview", workspace.id, vardId],
    queryFn: () => getVardManifest(workspace.id, vardId),
    enabled: Boolean(vard.data),
    retry: false,
  });
  const assets = useQuery({
    queryKey: ["sync-assets", workspace.id],
    queryFn: () => listSyncAssets(workspace.id),
  });
  const [outputPrefix, setOutputPrefix] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [editingId, setEditingId] = useState("");
  // A picked asset is only a draft until its settings are saved; it joins the
  // Vard on the same write that stores them.
  const [newItem, setNewItem] = useState<DraftItem | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  // Saved rows are the only rows: every edit is written before it shows.
  const items = useMemo(() => (vard.data ? manualDraftItems(vard.data) : []), [vard.data]);

  function beginSave() {
    if (!canEdit || savingRef.current) return false;
    savingRef.current = true;
    setSaving(true);
    return true;
  }

  function endSave() {
    savingRef.current = false;
    setSaving(false);
  }

  async function refreshAfterSave() {
    // A refresh failure is not a failed write. Never roll back accepted data.
    try {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["vards", workspace.id] }, { throwOnError: true }),
        refreshVardPreview(queryClient, workspace.id, vardId),
      ]);
    } catch {
      toast.warning("Saved, but the page could not refresh. Reload to see the latest.");
    }
  }

  async function persistItems(next: DraftItem[]) {
    if (!beginSave()) return;
    try {
      await queryClient.cancelQueries({ queryKey: ["vard", workspace.id, vardId] });
      const saved = await replaceVardItems(
        workspace.id,
        vardId,
        next.map(({ assetId, versionId, outputPath, transformation, writable }) => ({
          assetId,
          versionId,
          outputPath,
          transformation,
          writable,
        })),
      );
      queryClient.setQueryData(["vard", workspace.id, vardId], saved);
      toast.success("Saved");
      await refreshAfterSave();
    } catch (cause) {
      toast.error(errorMessage(cause, "Vard update failed"));
    } finally {
      endSave();
    }
  }

  async function persistManifest(patch: {
    name?: string;
    isPublic?: boolean;
    folderRules?: VardFolderRule[];
  }) {
    if (!beginSave()) return false;
    try {
      await queryClient.cancelQueries({ queryKey: ["vard", workspace.id, vardId] });
      const saved = await updateVard(workspace.id, vardId, patch);
      queryClient.setQueryData<VardDefinition>(["vard", workspace.id, vardId], (current) =>
        current ? applyVardMetadata(current, saved) : current,
      );
      toast.success("Saved");
      await refreshAfterSave();
      return true;
    } catch (cause) {
      toast.error(errorMessage(cause, "Vard update failed"));
      return false;
    } finally {
      endSave();
    }
  }

  function addItem(picked: { id: string; key: string; mimeType: string }) {
    const filename = `${picked.key.split("/").pop()}.${extensionFor(picked.mimeType)}`;
    setPickerOpen(false);
    setNewItem({
      id: crypto.randomUUID(),
      assetId: picked.id,
      key: picked.key,
      outputPath: availableOutputPath(`${outputPrefix}${filename}`, items),
      versionId: null,
      transformation: null,
      writable: false,
    });
  }

  async function remove() {
    await deleteVard(workspace.id, vardId);
    await queryClient.invalidateQueries({ queryKey: ["vards", workspace.id] });
    toast.success("Vard deleted");
    await navigate({ to: "/workspaces/$workspaceId/vards", params: { workspaceId: workspace.id } });
  }

  if (vard.isPending || vard.isError)
    return (
      <>
        <AppHeader crumbs={[workspaceCrumb(workspace), vardsCrumb(workspace), { label: "Vard" }]} />
        <Page id="main">
          {vard.isPending ? (
            <PageSkeleton />
          ) : (
            <Alert variant="destructive">
              <TriangleAlertIcon />
              <AlertTitle>Vard unavailable</AlertTitle>
              <AlertDescription>{vard.error.message}</AlertDescription>
            </Alert>
          )}
        </Page>
      </>
    );

  const savedItems = new Map(vard.data.items.map((item) => [item.id, item]));
  const editing = newItem ?? items.find(({ id }) => id === editingId);

  return (
    <>
      <AppHeader
        crumbs={[workspaceCrumb(workspace), vardsCrumb(workspace), { label: vard.data.name }]}
      />
      <Page id="main">
        <PageHeader
          title={vard.data.name}
          badge={
            <Badge variant={vard.data.isPublic ? "secondary" : "outline"}>
              {vard.data.isPublic ? "Public" : "Private"}
            </Badge>
          }
          description={`${items.length} ${items.length === 1 ? "file" : "files"}${
            vard.data.folderRules.length
              ? ` · ${vard.data.folderRules.length} folder ${vard.data.folderRules.length === 1 ? "rule" : "rules"}`
              : ""
          }`}
          actions={
            <CopyButton
              text={cliSetupCommand(window.location.origin, workspace.id, vardId)}
              label="Copy setup command"
            />
          }
        />

        <Tabs defaultValue="files">
          <TabsList variant="line">
            <TabsTrigger value="files">Files</TabsTrigger>
            <TabsTrigger value="folders">Folder rules</TabsTrigger>
            <TabsTrigger value="preview">Preview</TabsTrigger>
            <TabsTrigger value="setup">Setup</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
          </TabsList>

          <TabsContent value="files" keepMounted>
            <div className="flex flex-col gap-4 pt-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <OutputPath prefix={outputPrefix} onNavigate={setOutputPrefix} />
                {canEdit && (
                  <Button disabled={saving} onClick={() => setPickerOpen(true)}>
                    <PlusIcon data-icon="inline-start" />
                    Add asset
                  </Button>
                )}
              </div>
              {assets.isError && (
                <Alert variant="destructive">
                  <TriangleAlertIcon />
                  <AlertTitle>Asset details unavailable</AlertTitle>
                  <AlertDescription>{assets.error.message}</AlertDescription>
                </Alert>
              )}
              <OutputGrid
                items={items}
                prefix={outputPrefix}
                savedItems={savedItems}
                canEdit={canEdit}
                onOpenFolder={setOutputPrefix}
                onOpenItem={setEditingId}
                onAdd={() => setPickerOpen(true)}
              />
            </div>
          </TabsContent>

          <TabsContent value="folders" keepMounted>
            <div className="pt-4">
              <FolderRulesForm
                rules={vard.data.folderRules}
                canEdit={canEdit}
                saving={saving}
                onSave={(folderRules) => persistManifest({ folderRules })}
              />
            </div>
          </TabsContent>

          <TabsContent value="preview">
            <div className="pt-4">
              <ResolvedPreview
                preview={preview}
                saving={saving}
                onRefresh={() => void preview.refetch()}
              />
            </div>
          </TabsContent>

          <TabsContent value="setup">
            <div className="pt-4">
              <SetupGuide workspaceId={workspace.id} vardId={vardId} />
            </div>
          </TabsContent>

          <TabsContent value="settings" keepMounted>
            <div className="pt-4">
              <VardSettings
                key={`${vard.data.name}:${String(vard.data.isPublic)}`}
                vard={vard.data}
                vardId={vardId}
                canEdit={canEdit}
                saving={saving}
                onSave={persistManifest}
                onDelete={remove}
              />
            </div>
          </TabsContent>
        </Tabs>
      </Page>

      {editing && (
        <VardItemDialog
          key={editing.id}
          item={editing}
          isNew={Boolean(newItem)}
          source={assets.data?.assets.find(({ id }) => id === editing.assetId)}
          workspaceSlug={assets.data?.workspaceSlug}
          saved={savedItems.get(editing.id)}
          canEdit={canEdit && !saving}
          onClose={() => {
            setEditingId("");
            setNewItem(null);
          }}
          onSave={(next) => {
            setEditingId("");
            setNewItem(null);
            void persistItems(
              newItem
                ? [...items, next]
                : items.map((current) => (current.id === next.id ? next : current)),
            );
          }}
          onRemove={() => {
            setEditingId("");
            if (newItem) {
              setNewItem(null);
              return;
            }
            void persistItems(items.filter(({ id }) => id !== editing.id));
          }}
        />
      )}

      <AssetPickerDialog
        open={pickerOpen}
        workspace={workspace}
        destination={outputPrefix}
        addedAssetIds={new Set(items.map(({ assetId }) => assetId))}
        onPick={addItem}
        onClose={() => setPickerOpen(false)}
      />
    </>
  );
}

function OutputPath({
  prefix,
  onNavigate,
}: {
  prefix: string;
  onNavigate: (prefix: string) => void;
}) {
  const segments = prefix.split("/").filter(Boolean);
  return (
    <nav aria-label="Project folder" className="flex min-w-0 flex-wrap items-center gap-1 font-mono text-sm">
      <Button variant="ghost" size="sm" onClick={() => onNavigate("")}>
        project root
      </Button>
      {segments.map((segment, index) => (
        <span key={segments.slice(0, index + 1).join("/")} className="flex items-center gap-1">
          <ChevronRightIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onNavigate(`${segments.slice(0, index + 1).join("/")}/`)}
          >
            {segment}
          </Button>
        </span>
      ))}
    </nav>
  );
}

function itemBadge(item: DraftItem) {
  if (item.transformation) return (item.transformation.format ?? "resized").toUpperCase();
  if (item.versionId) return "Pinned";
  return item.writable ? "Writable" : "Latest";
}

function OutputGrid({
  items,
  prefix,
  savedItems,
  canEdit,
  onOpenFolder,
  onOpenItem,
  onAdd,
}: {
  items: DraftItem[];
  prefix: string;
  savedItems: Map<string, VardItem>;
  canEdit: boolean;
  onOpenFolder: (prefix: string) => void;
  onOpenItem: (id: string) => void;
  onAdd: () => void;
}) {
  const { folders, files } = outputTree(items, prefix);
  if (!folders.length && !files.length)
    return (
      <Empty variant="outline">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <BoxesIcon />
          </EmptyMedia>
          <EmptyTitle>{items.length ? "Empty folder" : "No files yet"}</EmptyTitle>
          <EmptyDescription>
            Add assets and choose where each one lands in the project.
          </EmptyDescription>
        </EmptyHeader>
        {canEdit && (
          <EmptyContent>
            <Button onClick={onAdd}>
              <PlusIcon data-icon="inline-start" />
              Add asset
            </Button>
          </EmptyContent>
        )}
      </Empty>
    );

  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
      {folders.map((folder) => (
        <li key={folder.prefix}>
          <button
            type="button"
            className="flex w-full items-center gap-3 rounded-lg border bg-card px-3 py-2.5 text-left text-sm transition-colors outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
            onClick={() => onOpenFolder(folder.prefix)}
          >
            <FolderIcon aria-hidden="true" className="size-5 shrink-0 text-primary" />
            <span className="min-w-0 flex-1 truncate font-medium">{folder.name}</span>
            <span className="text-xs text-muted-foreground tabular-nums">{folder.count}</span>
          </button>
        </li>
      ))}
      {files.map((item) => {
        const saved = savedItems.get(item.id);
        return (
          <li key={item.id}>
            <button
              type="button"
              className="flex w-full flex-col overflow-hidden rounded-xl border bg-card text-left transition-colors outline-none hover:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              onClick={() => onOpenItem(item.id)}
            >
              <span className="aspect-4/3 bg-muted">
                <AssetThumb url={saved?.downloadUrl} mimeType={saved?.mimeType} />
              </span>
              <span className="flex flex-col gap-1 p-2.5">
                <span className="truncate font-mono text-xs">
                  {item.outputPath.slice(prefix.length)}
                </span>
                <span className="text-xs text-muted-foreground">{itemBadge(item)}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function FolderRulesForm({
  rules,
  canEdit,
  saving,
  onSave,
}: {
  rules: VardFolderRule[];
  canEdit: boolean;
  saving: boolean;
  onSave: (rules: VardFolderRule[]) => Promise<boolean>;
}) {
  const id = useId();
  // Rows need a stable identity while the user edits, adds and removes them.
  const [draft, setDraft] = useState(() => withRowIds(rules));
  const [dirty, setDirty] = useState(false);
  // Saved rules replace an untouched draft; unsaved edits are never overwritten.
  const [syncedRules, setSyncedRules] = useState(rules);
  if (rules !== syncedRules && !dirty) {
    setSyncedRules(rules);
    setDraft(withRowIds(rules));
  }

  function change(next: typeof draft) {
    setDraft(next);
    setDirty(true);
  }

  function changeRule(rowId: string, patch: Partial<VardFolderRule>) {
    change(draft.map((rule) => (rule.rowId === rowId ? { ...rule, ...patch } : rule)));
  }

  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        if (
          canEdit &&
          dirty &&
          !saving &&
          (await onSave(draft.map(({ sourcePrefix, outputPrefix }) => ({ sourcePrefix, outputPrefix }))))
        )
          setDirty(false);
      }}
    >
      <Card>
        <CardHeader>
          <CardTitle>Folder rules</CardTitle>
          <CardDescription>
            Include a whole workspace folder, e.g. <code>brand/</code> → <code>public/brand/</code>.
            Prefixes end with <code>/</code>; leave empty for the root.
          </CardDescription>
          {canEdit && (
            <CardAction>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={saving || draft.length >= 64}
                onClick={() =>
                  change([...draft, { sourcePrefix: "", outputPrefix: "", rowId: crypto.randomUUID() }])
                }
              >
                <PlusIcon data-icon="inline-start" />
                Add rule
              </Button>
            </CardAction>
          )}
        </CardHeader>
        <CardContent>
          {draft.length ? (
            <ul className="flex flex-col gap-3">
              {draft.map((rule, index) => (
                <li key={rule.rowId} className="flex items-end gap-2">
                  <div className="flex flex-1 items-end gap-2">
                    <div className="flex-1">
                    <Field>
                      <FieldLabel htmlFor={`${id}-${rule.rowId}-source`}>
                        {index === 0 ? "Workspace folder" : <span className="sr-only">Workspace folder</span>}
                      </FieldLabel>
                      <Input
                        id={`${id}-${rule.rowId}-source`}
                        value={rule.sourcePrefix}
                        maxLength={255}
                        placeholder="brand/"
                        spellCheck={false}
                        disabled={!canEdit || saving}
                        onChange={(event) => changeRule(rule.rowId, { sourcePrefix: event.target.value })}
                      />
                    </Field>
                    </div>
                    <ArrowRightIcon aria-hidden="true" className="mb-2 size-4 shrink-0 text-muted-foreground" />
                    <div className="flex-1">
                    <Field>
                      <FieldLabel htmlFor={`${id}-${rule.rowId}-output`}>
                        {index === 0 ? "Project folder" : <span className="sr-only">Project folder</span>}
                      </FieldLabel>
                      <Input
                        id={`${id}-${rule.rowId}-output`}
                        value={rule.outputPrefix}
                        maxLength={255}
                        placeholder="public/brand/"
                        spellCheck={false}
                        disabled={!canEdit || saving}
                        onChange={(event) => changeRule(rule.rowId, { outputPrefix: event.target.value })}
                      />
                    </Field>
                    </div>
                  </div>
                  {canEdit && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      disabled={saving}
                      aria-label={`Remove folder rule ${index + 1}`}
                      onClick={() => change(draft.filter(({ rowId }) => rowId !== rule.rowId))}
                    >
                      <Trash2Icon />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No folder rules.</p>
          )}
        </CardContent>
        {canEdit && dirty && (
          <CardFooter>
            <div className="flex w-full items-center justify-between gap-2">
              <span className="text-sm text-muted-foreground">
                Unsaved changes. Pull with <code>--delete</code> to remove files a rule no longer includes.
              </span>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  disabled={saving}
                  onClick={() => {
                    setDraft(withRowIds(rules));
                    setDirty(false);
                  }}
                >
                  Discard
                </Button>
                <Button type="submit" disabled={saving}>
                  {saving && <Spinner data-icon="inline-start" />}
                  Save rules
                </Button>
              </div>
            </div>
          </CardFooter>
        )}
      </Card>
    </form>
  );
}

function ResolvedPreview({
  preview,
  saving,
  onRefresh,
}: {
  preview: UseQueryResult<VardManifest>;
  saving: boolean;
  onRefresh: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>What <code>vardum pull</code> writes</CardTitle>
        <CardDescription>Saved configuration only. Folder outputs are read-only.</CardDescription>
        <CardAction>
          <Button variant="outline" size="sm" disabled={saving || preview.isFetching} onClick={onRefresh}>
            {preview.isFetching && <Spinner data-icon="inline-start" />}
            Refresh
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {preview.isPending ? (
          <Spinner />
        ) : preview.isError ? (
          <Alert variant="destructive">
            <TriangleAlertIcon />
            <AlertTitle>Preview unavailable</AlertTitle>
            <AlertDescription>
              {preview.error.message}. Fix colliding paths or reduce outputs, then refresh.
            </AlertDescription>
          </Alert>
        ) : preview.data.items.length ? (
          <PreviewTable manifest={preview.data} />
        ) : (
          <p className="text-sm text-muted-foreground">Nothing to pull yet.</p>
        )}
      </CardContent>
    </Card>
  );
}

function PreviewTable({ manifest }: { manifest: VardManifest }) {
  const fromFolders = new Set(generatedOutputs(manifest).map(({ id }) => id));
  return (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Project path</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>From</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {manifest.items
                .toSorted((left, right) => left.outputPath.localeCompare(right.outputPath))
                .map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>
                      <span className="font-mono text-xs">{item.outputPath}</span>
                    </TableCell>
                    <TableCell>
                      <span className="font-mono text-xs text-muted-foreground">{item.key}</span>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">
                        {fromFolders.has(item.id) ? "Folder rule" : "File"}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
  );
}

function CodeBlock({
  code,
  displayCode = code,
  label,
}: {
  code: string;
  displayCode?: string;
  label: string;
}) {
  return (
    <div className="relative w-fit max-w-full">
      <pre className="rounded-lg border bg-muted p-3 pr-12 text-xs leading-relaxed whitespace-pre-wrap wrap-anywhere">
        <code>{displayCode}</code>
      </pre>
      <div className="absolute top-1.5 right-1.5">
        <CopyIconButton text={code} label={label} />
      </div>
    </div>
  );
}

function SetupGuide({ workspaceId, vardId }: { workspaceId: string; vardId: string }) {
  const setupCommands = cliSetupCommands(window.location.origin, workspaceId, vardId);
  const config = JSON.stringify(
    { schema: 1, server: window.location.origin, workspace: workspaceId, vard: vardId },
    null,
    2,
  );
  const steps = [
    {
      title: "Run in your project root",
      description: `Installs CLI ${CLI_SETUP_VERSION}, writes vardum.json, signs you in and pulls the files. Needs Node.js 22+.`,
      body: (
        <CodeBlock
          code={setupCommands.join(" && ")}
          displayCode={setupCommands.join(" &&\n")}
          label="Copy setup command"
        />
      ),
    },
    {
      title: "Commit the result",
      description: (
        <>
          <code>vardum.json</code>, <code>.vardum.lock</code>, <code>package.json</code> and your
          lockfile.
        </>
      ),
    },
    {
      title: "Pull in CI",
      description: (
        <>
          Add a read-only API key as the <code>VARDUM_API_KEY</code> secret.
        </>
      ),
      body: <CodeBlock code="npx vardum pull --frozen --json" label="Copy CI command" />,
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <ol className="flex flex-col gap-6">
        {steps.map((step, index) => (
          <li key={step.title} className="flex gap-4">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium">
              {index + 1}
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <div className="flex flex-col gap-0.5">
                <h3 className="font-medium">{step.title}</h3>
                <p className="text-sm text-muted-foreground">{step.description}</p>
              </div>
              {step.body}
            </div>
          </li>
        ))}
      </ol>
      <details className="group rounded-lg border p-3">
        <summary className="cursor-pointer text-sm font-medium">vardum.json</summary>
        <div className="pt-3">
          <CodeBlock code={config} label="Copy vardum.json" />
        </div>
      </details>
    </div>
  );
}

function VardSettings({
  vard,
  vardId,
  canEdit,
  saving,
  onSave,
  onDelete,
}: {
  vard: VardDefinition;
  vardId: string;
  canEdit: boolean;
  saving: boolean;
  onSave: (patch: { name?: string; isPublic?: boolean }) => Promise<boolean>;
  onDelete: () => Promise<void>;
}) {
  const id = useId();
  const [name, setName] = useState(vard.name);
  const [deleteOpen, setDeleteOpen] = useState(false);

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>General</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (name && name !== vard.name) void onSave({ name });
            }}
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
                <div className="flex gap-2">
                  <div className="flex-1">
                    <Input
                      id={`${id}-name`}
                      value={name}
                      maxLength={80}
                      required
                      disabled={!canEdit || saving}
                      onChange={(event) => setName(event.target.value)}
                    />
                  </div>
                  {canEdit && (
                    <Button type="submit" variant="outline" disabled={saving || !name || name === vard.name}>
                      Save
                    </Button>
                  )}
                </div>
              </Field>
              <PublicManifestField
                id={`${id}-public`}
                checked={vard.isPublic}
                disabled={!canEdit || saving}
                onCheckedChange={(checked) => void onSave({ isPublic: checked })}
              />
              <Field>
                <FieldLabel htmlFor={`${id}-vard-id`}>Vard ID</FieldLabel>
                <InputGroup>
                  <InputGroupInput id={`${id}-vard-id`} readOnly value={vardId} />
                  <InputGroupAddon align="inline-end">
                    <CopyIconButton text={vardId} label="Copy Vard ID" />
                  </InputGroupAddon>
                </InputGroup>
              </Field>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>

      {canEdit && (
        <Card>
          <CardHeader>
            <CardTitle>Delete Vard</CardTitle>
            <CardDescription>Removes the file list only. Assets are not touched.</CardDescription>
            <CardAction>
              <Button variant="destructive" disabled={saving} onClick={() => setDeleteOpen(true)}>
                Delete
              </Button>
            </CardAction>
          </CardHeader>
        </Card>
      )}
      <ConfirmDialog
        open={deleteOpen}
        title={`Delete “${vard.name}”?`}
        description="Projects using this Vard will no longer be able to pull. Assets stay in the workspace."
        confirmLabel="Delete Vard"
        onCancel={() => setDeleteOpen(false)}
        onConfirm={onDelete}
      />
    </div>
  );
}

function VardItemDialog({
  item,
  isNew,
  source,
  workspaceSlug,
  saved,
  canEdit,
  onSave,
  onRemove,
  onClose,
}: {
  item: DraftItem;
  isNew: boolean;
  source?: SyncAsset;
  workspaceSlug?: string;
  saved?: VardItem;
  canEdit: boolean;
  onSave: (item: DraftItem) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState(item);
  const transformed = Boolean(draft.transformation);
  const preview = sourcePreview(draft, workspaceSlug, source, saved);

  function change(patch: Partial<DraftItem>) {
    setDraft((current) => ({ ...current, ...patch }));
  }

  function changeTransformation(patch: Partial<TransformationInput>) {
    change({
      transformation: draft.transformation ? { ...draft.transformation, ...patch } : null,
    });
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent size="lg">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (draft.outputPath) onSave(draft);
          }}
        >
          <FieldGroup>
            <DialogHeader>
              <DialogTitle>{isNew ? "Add file" : "File settings"}</DialogTitle>
              <DialogDescription>
                <span className="font-mono">{item.key}</span>
                {source?.mimeType ? ` · ${source.mimeType}` : source ? "" : " · asset unavailable"}
              </DialogDescription>
            </DialogHeader>

            <div className="flex h-40 items-center justify-center overflow-hidden rounded-lg border bg-muted">
              <AssetThumb
                url={preview.url}
                mimeType={preview.mimeType}
                label={`Source preview of ${item.key}`}
                controls
                fit="contain"
              />
            </div>

            <Field>
              <FieldLabel htmlFor={`${id}-path`}>Project path</FieldLabel>
              <Input
                id={`${id}-path`}
                value={draft.outputPath}
                required
                spellCheck={false}
                disabled={!canEdit}
                onChange={(event) => change({ outputPath: event.target.value })}
              />
            </Field>

            <Field>
              <FieldLabel htmlFor={`${id}-format`}>Format</FieldLabel>
              <NativeSelect
                id={`${id}-format`}
                value={draft.transformation?.format ?? "original"}
                disabled={!canEdit}
                onChange={(event) => {
                  const format = event.target.value;
                  change({
                    writable: false,
                    transformation:
                      format === "original"
                        ? null
                        : {
                            ...draft.transformation,
                            format: format as NonNullable<TransformationInput["format"]>,
                          },
                  });
                }}
              >
                <NativeSelectOption value="original">Original file</NativeSelectOption>
                <NativeSelectOption value="avif">AVIF</NativeSelectOption>
                <NativeSelectOption value="jpeg">JPEG</NativeSelectOption>
                <NativeSelectOption value="png">PNG</NativeSelectOption>
                <NativeSelectOption value="webp">WebP</NativeSelectOption>
              </NativeSelect>
              {!transformed && (
                <FieldDescription>Pick a format to resize or convert.</FieldDescription>
              )}
            </Field>

            {transformed && (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Field>
                  <FieldLabel htmlFor={`${id}-w`}>Width</FieldLabel>
                  <Input
                    id={`${id}-w`}
                    type="number"
                    min={1}
                    max={4096}
                    disabled={!canEdit}
                    value={draft.transformation?.w ?? ""}
                    onChange={(event) => changeTransformation({ w: numberOrUndefined(event.target.value) })}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor={`${id}-h`}>Height</FieldLabel>
                  <Input
                    id={`${id}-h`}
                    type="number"
                    min={1}
                    max={4096}
                    disabled={!canEdit}
                    value={draft.transformation?.h ?? ""}
                    onChange={(event) => changeTransformation({ h: numberOrUndefined(event.target.value) })}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor={`${id}-fit`}>Fit</FieldLabel>
                  <NativeSelect
                    id={`${id}-fit`}
                    value={draft.transformation?.fit ?? "inside"}
                    disabled={!canEdit || (!draft.transformation?.w && !draft.transformation?.h)}
                    onChange={(event) =>
                      changeTransformation({ fit: event.target.value as TransformationInput["fit"] })
                    }
                  >
                    <NativeSelectOption value="inside">Inside</NativeSelectOption>
                    <NativeSelectOption value="cover">Cover</NativeSelectOption>
                    <NativeSelectOption value="contain">Contain</NativeSelectOption>
                    <NativeSelectOption value="fill">Fill</NativeSelectOption>
                    <NativeSelectOption value="outside">Outside</NativeSelectOption>
                  </NativeSelect>
                </Field>
                <Field>
                  <FieldLabel htmlFor={`${id}-q`}>Quality</FieldLabel>
                  <Input
                    id={`${id}-q`}
                    type="number"
                    min={1}
                    max={100}
                    disabled={!canEdit}
                    value={draft.transformation?.q ?? ""}
                    onChange={(event) => changeTransformation({ q: numberOrUndefined(event.target.value) })}
                  />
                </Field>
              </div>
            )}

            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor={`${id}-pin`}>Pin this version</FieldLabel>
                <FieldDescription>Keep pulling the current version, even after new uploads.</FieldDescription>
              </FieldContent>
              <Switch
                id={`${id}-pin`}
                checked={Boolean(draft.versionId)}
                disabled={!canEdit || !source || transformed || draft.writable}
                onCheckedChange={(checked) =>
                  change({ versionId: checked ? (source?.versionId ?? null) : null })
                }
              />
            </Field>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor={`${id}-push`}>Writable</FieldLabel>
                <FieldDescription>
                  <code>vardum push</code> can upload local edits as a new version. Not for
                  pinned or converted files.
                </FieldDescription>
              </FieldContent>
              <Switch
                id={`${id}-push`}
                checked={draft.writable}
                disabled={!canEdit || transformed || Boolean(draft.versionId)}
                onCheckedChange={(checked) => change({ writable: checked })}
              />
            </Field>

            {canEdit && (
              <DialogFooter>
                <div className="flex w-full justify-between gap-2">
                  <Button type="button" variant="destructive" onClick={onRemove}>
                    {isNew ? "Discard" : "Remove"}
                  </Button>
                  <Button type="submit" disabled={!draft.outputPath}>
                    {isNew ? "Add file" : "Save"}
                  </Button>
                </div>
              </DialogFooter>
            )}
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AssetPickerDialog({
  open,
  onClose,
  workspace,
  destination,
  addedAssetIds,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  workspace: WorkspaceRef;
  destination: string;
  addedAssetIds: Set<string>;
  onPick: (asset: { id: string; key: string; mimeType: string }) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>Add asset</DialogTitle>
          <DialogDescription>
            Lands in <code>/{destination}</code>. You can change the path next.
          </DialogDescription>
        </DialogHeader>
        {open && (
          <AssetPicker workspace={workspace} addedAssetIds={addedAssetIds} onPick={onPick} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function AssetPicker({
  workspace,
  addedAssetIds,
  onPick,
}: {
  workspace: WorkspaceRef;
  addedAssetIds: Set<string>;
  onPick: (asset: { id: string; key: string; mimeType: string }) => void;
}) {
  const [prefix, setPrefix] = useState("");
  const browse = useQuery({
    queryKey: ["assets", workspace.id, prefix],
    queryFn: () => listAssets(workspace.id, prefix),
  });
  const folders = browse.data?.folders ?? [];
  const assets = browse.data?.assets ?? [];
  const segments = prefix.split("/").filter(Boolean);

  return (
    <div className="flex flex-col gap-4">
      <nav aria-label="Workspace folder" className="flex flex-wrap items-center gap-1 text-sm">
        <Button variant="ghost" size="sm" onClick={() => setPrefix("")}>
          {workspace.name}
        </Button>
        {segments.map((segment, index) => (
          <span key={segments.slice(0, index + 1).join("/")} className="flex items-center gap-1">
            <ChevronRightIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPrefix(`${segments.slice(0, index + 1).join("/")}/`)}
            >
              {segment}
            </Button>
          </span>
        ))}
      </nav>
      {browse.isPending ? (
        <Spinner />
      ) : browse.isError ? (
        <FieldError>{browse.error.message}</FieldError>
      ) : folders.length || assets.length ? (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {folders.map((folder) => (
            <li key={folder.prefix}>
              <button
                type="button"
                className="flex w-full items-center gap-3 rounded-lg border bg-card px-3 py-2.5 text-left text-sm transition-colors outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
                onClick={() => setPrefix(folder.prefix)}
              >
                <FolderIcon aria-hidden="true" className="size-5 shrink-0 text-primary" />
                <span className="min-w-0 flex-1 truncate font-medium">{folder.name}</span>
              </button>
            </li>
          ))}
          {assets.map((asset) => (
            <PickerAsset
              key={asset.id}
              asset={asset}
              workspaceSlug={workspace.slug}
              added={addedAssetIds.has(asset.id)}
              onPick={onPick}
            />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">This folder is empty.</p>
      )}
    </div>
  );
}

function PickerAsset({
  asset,
  workspaceSlug,
  added,
  onPick,
}: {
  asset: AssetSummary;
  workspaceSlug: string;
  added: boolean;
  onPick: (asset: { id: string; key: string; mimeType: string }) => void;
}) {
  const ready = Boolean(asset.currentVersionId);
  return (
    <li>
      <button
        type="button"
        disabled={!ready}
        title={ready ? undefined : "Not ready yet"}
        className="flex w-full flex-col overflow-hidden rounded-xl border bg-card text-left transition-colors outline-none hover:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
        onClick={() => onPick({ id: asset.id, key: asset.key, mimeType: asset.mimeType ?? "" })}
      >
        <span className="relative aspect-4/3 bg-muted">
          <AssetThumb url={assetPreviewUrl(workspaceSlug, asset)} mimeType={asset.mimeType} />
          {added && (
            <span className="absolute top-2 left-2">
              <Badge variant="secondary">Added</Badge>
            </span>
          )}
        </span>
        <span className="flex flex-col gap-0.5 p-2.5">
          <span className="truncate text-sm font-medium">{asset.displayName}</span>
          <span className="truncate font-mono text-xs text-muted-foreground">{asset.key}</span>
        </span>
      </button>
    </li>
  );
}

function withRowIds(rules: VardFolderRule[]) {
  return rules.map((rule) => ({ ...rule, rowId: crypto.randomUUID() }));
}

// The Vard's own output paths, browsed as the directory tree `vardum pull` writes.
function outputTree(items: DraftItem[], prefix: string) {
  const folders = new Map<string, number>();
  const files: DraftItem[] = [];
  for (const item of items) {
    if (!item.outputPath.startsWith(prefix)) continue;
    const remainder = item.outputPath.slice(prefix.length);
    const slash = remainder.indexOf("/");
    if (slash === -1) files.push(item);
    else {
      const name = remainder.slice(0, slash);
      folders.set(name, (folders.get(name) ?? 0) + 1);
    }
  }
  return {
    folders: [...folders]
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([name, count]) => ({ name, count, prefix: `${prefix}${name}/` })),
    files: files.toSorted((left, right) => left.outputPath.localeCompare(right.outputPath)),
  };
}

// Clicking the same asset twice would otherwise collide on the per-Vard unique output path.
function availableOutputPath(candidate: string, items: DraftItem[]) {
  const taken = new Set(items.map(({ outputPath }) => outputPath));
  if (!taken.has(candidate)) return candidate;
  const [, base, extension] = candidate.match(/^(.*?)(\.[^./]*)?$/) ?? [];
  for (let suffix = 2; ; suffix += 1) {
    const next = `${base}-${suffix}${extension ?? ""}`;
    if (!taken.has(next)) return next;
  }
}

function extensionFor(mimeType: string) {
  return (
    {
      "image/avif": "avif",
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/svg+xml": "svg",
      "image/webp": "webp",
    }[mimeType] ?? "bin"
  );
}

function numberOrUndefined(value: string) {
  return value ? Number(value) : undefined;
}
