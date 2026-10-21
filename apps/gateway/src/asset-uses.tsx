import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, FolderIcon, LinkIcon, PlusIcon, TriangleAlertIcon } from "lucide-react";
import { useId, useState, type SyntheticEvent } from "react";
import { toast } from "sonner";
import { AssetThumb } from "@/components/asset-thumb";
import { OutputBackground, validOutputBackground } from "@/components/output-background";
import { OutputSafeArea, validOutputSafeArea } from "@/components/output-safe-area";
import { OutputSvg, outputMime } from "@/components/output-svg";
import { withOutputRenderer } from "./output-renderer";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CopyButton } from "@/components/copy-button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { errorMessage } from "@/lib/format";
import { ApiRequestError, assetDeliveryPath, assetPreviewUrl, createAssetUse, createTransformationUrl, getAsset,
  removeAssetUse, updateAssetUse, type AssetSummary, type AssetUseSummary, type TransformationInput } from "./asset-api";
import { assetBrowserQueryOptions, assetUseQueryOptions, flattenAssetPages } from "./asset-queries";
import { defaultUsePath } from "./asset-use-path";
import type { WorkspaceRef } from "./workspace";

export function useLibraryUses(workspaceId: string, prefix = "", search = "", sourceAssetId?: string) {
  return useInfiniteQuery(assetUseQueryOptions(workspaceId, prefix, search, sourceAssetId));
}

export function LinkedUses({ workspace, listing, source }: {
  workspace: WorkspaceRef; listing: ReturnType<typeof useLibraryUses>; source?: AssetSummary;
}) {
  const [editing, setEditing] = useState<AssetUseSummary | null>(null);
  const [creating, setCreating] = useState(false);
  const uses = [...new Map(listing.data?.pages.flatMap((page) => page.uses).map((use) => [use.id, use])).values()];
  if (!source && !listing.isPending && !listing.isError && !uses.length) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{source ? "Linked uses" : "Uses of existing assets"}</CardTitle>
        {source ? <CardDescription>Versions and visibility changes to this source apply to every use below.</CardDescription> : null}
        {source && workspace.canEdit ? <CardAction><Button variant="outline" onClick={() => setCreating(true)} disabled={!source.currentVersionId}>
          <PlusIcon data-icon="inline-start" />Use in another folder
        </Button></CardAction> : null}
      </CardHeader>
      <CardContent><div className="flex flex-col gap-4">
        {listing.isPending ? <span className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner />Loading linked uses…</span> : null}
        {listing.isError ? <Alert variant="destructive"><TriangleAlertIcon /><AlertTitle>Linked uses could not load</AlertTitle>
          <AlertDescription>{listing.error.message}<Button variant="outline" size="sm" onClick={() => void listing.refetch()}>Retry</Button></AlertDescription></Alert> : null}
        {!listing.isPending && !listing.isError && !uses.length ? <p className="text-sm text-muted-foreground">No linked uses yet.</p> : null}
        {uses.length ? <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5" aria-label="Linked uses">
          {uses.map((use) => <li key={use.id} className="min-w-0">
            <button type="button" className="flex w-full min-w-0 flex-col overflow-hidden rounded-lg border text-left focus-visible:outline-ring" onClick={() => setEditing(use)} aria-label={`Settings for linked use ${use.displayName}`}>
              <span className="flex aspect-16/10 w-full items-center justify-center overflow-hidden bg-muted bg-cells"><AssetThumb url={use.previewUrl} mimeType={use.outputMimeType} label={use.displayName} /></span>
              <span className="flex w-full min-w-0 flex-col gap-1 p-3">
                <span className="flex min-w-0 items-center justify-between gap-2 text-sm"><span className="truncate font-medium">{use.displayName}</span><Badge variant="secondary"><LinkIcon />Linked</Badge></span>
                <span className="truncate text-xs text-muted-foreground" title={use.key}>{use.key}</span>
                {use.availabilityError ? <span className="text-xs text-destructive">Source unavailable</span> : use.sourceProcessing ? <span className="text-xs text-muted-foreground">Updating source…</span> : null}
              </span>
            </button>
          </li>)}
        </ul> : null}
        {listing.hasNextPage ? <Button variant="outline" disabled={listing.isFetching} onClick={() => void listing.fetchNextPage({ cancelRefetch: false })}>Load more linked uses</Button> : null}
      </div></CardContent>
      {editing ? <AssetUseDialog workspace={workspace} use={editing} onClose={() => setEditing(null)} /> : null}
      {creating && source ? <AssetUseDialog workspace={workspace} source={source} onClose={() => setCreating(false)} /> : null}
    </Card>
  );
}

export function AssetUseDialog({ workspace, prefix = "", source, use, onClose }: {
  workspace: WorkspaceRef; prefix?: string; source?: AssetSummary; use?: AssetUseSummary; onClose: () => void;
}) {
  const [picked, setPicked] = useState<AssetSummary | null>(source ?? null);
  const sourceQuery = useQuery({
    queryKey: ["asset", workspace.id, use?.sourceAssetId],
    queryFn: () => getAsset(workspace.id, use!.sourceAssetId), enabled: Boolean(use),
  });
  const selected = use ? sourceQuery.data : picked;
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent size="xl">
      <DialogHeader><DialogTitle>{use ? "Linked use settings" : "Use existing asset"}</DialogTitle>
        <DialogDescription>{use ? "These settings apply only to this use." : "Reuse one source with its own path and output settings."}</DialogDescription>
      </DialogHeader>
      {selected ? <UseEditor key={use?.id ?? selected.id} workspace={workspace} source={selected} use={use} prefix={prefix} onClose={onClose} onBack={!use && !source ? () => setPicked(null) : undefined} />
        : use ? sourceQuery.isError ? <Alert variant="destructive"><AlertTitle>Source unavailable</AlertTitle><AlertDescription>{sourceQuery.error.message}</AlertDescription></Alert> : <Spinner />
        : <SourcePicker workspace={workspace} onPick={setPicked} />}
    </DialogContent>
  </Dialog>;
}

function SourcePicker({ workspace, onPick }: { workspace: WorkspaceRef; onPick: (source: AssetSummary) => void }) {
  const [search, setSearch] = useState("");
  const [folder, setFolder] = useState("");
  const needle = useDebouncedValue(search);
  const listing = useInfiniteQuery(assetBrowserQueryOptions(workspace.id, needle ? "" : folder, needle));
  const { folders, assets } = flattenAssetPages(listing.data?.pages);
  return <div className="flex flex-col gap-4">
    <Input aria-label="Find source asset" type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search sources by name or path" />
    {!needle && folder ? <Button variant="outline" onClick={() => setFolder(folder.split("/").filter(Boolean).slice(0, -1).map((part) => `${part}/`).join(""))}><ArrowLeftIcon data-icon="inline-start" />{folder}</Button> : null}
    <div className="grid max-h-80 grid-cols-2 gap-3 overflow-y-auto sm:grid-cols-3" aria-label="Source assets">
      {!needle ? folders.map((item) => <Button key={item.prefix} variant="outline" onClick={() => setFolder(item.prefix)}><FolderIcon data-icon="inline-start" />{item.name}</Button>) : null}
      {assets.map((asset) => <button type="button" key={asset.id} disabled={!asset.currentVersionId} onClick={() => onPick(asset)} className="flex min-w-0 flex-col overflow-hidden rounded-lg border text-left disabled:opacity-50">
        <span className="flex aspect-16/10 w-full overflow-hidden bg-muted bg-cells"><AssetThumb url={assetPreviewUrl(workspace.slug, asset)} mimeType={asset.mimeType} label={asset.displayName} /></span>
        <span className="flex min-w-0 flex-col gap-1 p-2 text-sm"><span className="truncate">{asset.displayName}</span><span className="truncate text-xs text-muted-foreground">{asset.key}</span></span>
      </button>)}
    </div>
    {listing.isPending ? <Spinner /> : null}
    {listing.isError ? <Alert variant="destructive"><AlertTitle>Sources could not load</AlertTitle><AlertDescription>{listing.error.message}<Button variant="outline" onClick={() => void listing.refetch()}>Retry</Button></AlertDescription></Alert> : null}
    {!assets.length && (!folders.length || needle) && !listing.isPending && !listing.isError ? <p className="text-sm text-muted-foreground">No matching sources.</p> : null}
    {listing.hasNextPage ? <Button variant="outline" disabled={listing.isFetching} onClick={() => void listing.fetchNextPage({ cancelRefetch: false })}>Load more sources</Button> : null}
  </div>;
}

function UseEditor({ workspace, source, use, prefix, onClose, onBack }: {
  workspace: WorkspaceRef; source: AssetSummary; use?: AssetUseSummary; prefix: string; onClose: () => void; onBack?: () => void;
}) {
  const id = useId();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [name, setName] = useState(use?.displayName ?? source.displayName);
  const [key, setKey] = useState(use?.key ?? defaultUsePath(prefix, source.displayName));
  const [keyEdited, setKeyEdited] = useState(Boolean(use));
  const [format, setFormat] = useState<"original" | NonNullable<TransformationInput["format"]>>(use?.transformation?.format ?? "original");
  const [width, setWidth] = useState(String(use?.transformation?.w ?? ""));
  const [height, setHeight] = useState(String(use?.transformation?.h ?? ""));
  const [fit, setFit] = useState<TransformationInput["fit"]>(use?.transformation?.fit ?? "inside");
  const [quality, setQuality] = useState(String(use?.transformation?.q ?? 80));
  const [background, setBackground] = useState(use?.transformation?.bg);
  const [padding, setPadding] = useState(use?.transformation?.pad);
  const [vector, setVector] = useState<Partial<TransformationInput>>({
    layer: use?.transformation?.layer, darkLayer: use?.transformation?.darkLayer, darkColor: use?.transformation?.darkColor,
  });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [removing, setRemoving] = useState(false);
  const transformation: TransformationInput | null = withOutputRenderer(format === "original" ? null : {
    format, ...(width ? { w: Number(width) } : {}), ...(height ? { h: Number(height) } : {}),
    ...(format === "svg" ? { fit: "contain" as const, darkLayer: vector.darkLayer, darkColor: vector.darkColor }
      : { ...(width || height ? { fit } : {}), q: Number(quality) }),
    layer: vector.layer, ...(background !== undefined ? { bg: background } : {}), ...(padding !== undefined ? { pad: padding } : {}),
  }, source.mimeType, use?.transformation);
  const settled = useDebouncedValue(JSON.stringify(transformation));
  const transformPreview = useQuery({
    queryKey: ["use-preview", workspace.id, source.id, source.currentVersionId, source.isPublic, source.customDomain, settled],
    queryFn: () => createTransformationUrl(workspace.id, source.id, JSON.parse(settled) as TransformationInput),
    enabled: settled !== "null" && validOutputBackground((JSON.parse(settled) as TransformationInput | null)?.bg) && validOutputSafeArea(JSON.parse(settled) as TransformationInput | null) && Boolean(source.currentVersionId), staleTime: Infinity, retry: false,
  });
  const preview = format === "original" ? assetPreviewUrl(workspace.slug, source, assetDeliveryPath(workspace.slug, source))
    : settled === JSON.stringify(transformation) ? assetPreviewUrl(workspace.slug, source, transformPreview.data?.url) : null;
  async function invalidate() {
    await Promise.all(["asset-uses", "assets", "asset", "audit"].map((part) => client.invalidateQueries({ queryKey: [part, workspace.id] })));
  }
  async function save(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault(); if (!validOutputSafeArea(transformation)) return; setSaving(true); setError(null); setConflict(false);
    try {
      if (use) await updateAssetUse(workspace.id, use, { displayName: name, transformation });
      else await createAssetUse(workspace.id, { key, displayName: name, sourceAssetId: source.id, transformation });
      await invalidate(); toast.success(use ? "Linked use updated" : "Linked use created"); onClose();
      if (!use) void navigate({ to: "/workspaces/$workspaceId/assets", params: { workspaceId: workspace.id },
        search: { prefix: key.includes("/") ? `${key.split("/").slice(0, -1).join("/")}/` : "" } });
    } catch (cause) { setError(errorMessage(cause, "Could not save linked use")); setConflict(Boolean(use && cause instanceof ApiRequestError && cause.status === 409)); }
    finally { setSaving(false); }
  }
  async function remove() {
    if (!use) return;
    await removeAssetUse(workspace.id, use); await invalidate(); toast.success("Linked use removed; source kept"); onClose();
  }
  return <>
    <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
      <Link className="min-w-0 truncate" to="/workspaces/$workspaceId/assets/$assetId" params={{ workspaceId: workspace.id, assetId: source.id }} search={{ from: source.key.includes("/") ? `${source.key.split("/").slice(0, -1).join("/")}/` : "" }}>Source: {source.displayName}</Link>
      <Badge variant="secondary">Latest ready version · {source.isPublic ? "Public" : "Private"}</Badge>
    </div>
    <form onSubmit={save} className="flex flex-col gap-4">
      <div className="flex aspect-16/10 max-h-56 items-center justify-center overflow-hidden rounded-lg border bg-muted bg-cells"><AssetThumb url={preview} mimeType={format === "original" ? source.mimeType : outputMime(format)} label={`Preview of ${name}`} controls /></div>
      {use?.availabilityError ? <Alert variant="destructive"><TriangleAlertIcon /><AlertTitle>Saved use unavailable</AlertTitle><AlertDescription>{use.availabilityError}</AlertDescription></Alert> : null}
      <FieldGroup>
        <Field><FieldLabel htmlFor={`${id}-name`}>Use name</FieldLabel><Input id={`${id}-name`} value={name} required maxLength={255} readOnly={!workspace.canEdit} onChange={(event) => { setName(event.target.value); if (!keyEdited) setKey(defaultUsePath(prefix, event.target.value)); }} /></Field>
        <Field><FieldLabel htmlFor={`${id}-key`}>Path</FieldLabel><Input id={`${id}-key`} value={key} required maxLength={255} pattern={"[a-z0-9][a-z0-9._\\-]*(/[a-z0-9][a-z0-9._\\-]*)*"} readOnly={Boolean(use) || !workspace.canEdit} onChange={(event) => { setKeyEdited(true); setKey(event.target.value); }} />
          <FieldDescription>{use ? "Path is fixed. Create another use for a different URL." : "Include the destination folder. A file extension is optional."}</FieldDescription></Field>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Field><FieldLabel htmlFor={`${id}-format`}>Output format</FieldLabel><NativeSelect id={`${id}-format`} value={format} disabled={!workspace.canEdit} onChange={(event) => setFormat(event.target.value as typeof format)}>
            <NativeSelectOption value="original">Original</NativeSelectOption>
            {source.mimeType === "image/svg+xml" ? <NativeSelectOption value="svg">SVG</NativeSelectOption> : null}
            {["png", "webp", "jpeg", "avif"].map((value) => <NativeSelectOption key={value} value={value} disabled={!source.mimeType?.startsWith("image/")}>{value.toUpperCase()}</NativeSelectOption>)}
          </NativeSelect></Field>
          <Field data-disabled={format === "original"}><FieldLabel htmlFor={`${id}-width`}>Width</FieldLabel><Input id={`${id}-width`} type="number" min="1" max="4096" value={width} disabled={format === "original" || !workspace.canEdit} placeholder="Auto" onChange={(event) => setWidth(event.target.value)} /></Field>
          <Field data-disabled={format === "original"}><FieldLabel htmlFor={`${id}-height`}>Height</FieldLabel><Input id={`${id}-height`} type="number" min="1" max="4096" value={height} disabled={format === "original" || !workspace.canEdit} placeholder="Auto" onChange={(event) => setHeight(event.target.value)} /></Field>
          <Field data-disabled={format === "original" || format === "svg"}><FieldLabel htmlFor={`${id}-fit`}>Fit</FieldLabel><NativeSelect id={`${id}-fit`} value={format === "svg" ? "contain" : fit} disabled={format === "original" || format === "svg" || Boolean(padding) || !workspace.canEdit} onChange={(event) => setFit(event.target.value as typeof fit)}>
            {["inside", "cover", "contain", "fill", "outside"].map((value) => <NativeSelectOption key={value} value={value}>{value}</NativeSelectOption>)}
          </NativeSelect></Field>
          <Field data-disabled={format === "original" || format === "svg"}><FieldLabel htmlFor={`${id}-quality`}>Quality</FieldLabel><Input id={`${id}-quality`} type="number" min="1" max="100" required value={quality} disabled={format === "original" || format === "svg" || !workspace.canEdit} onChange={(event) => setQuality(event.target.value)} /></Field>
        </div>
        <OutputSafeArea id={`${id}-safe-area`} transformation={transformation} onChange={(pad) => { setPadding(pad); if (pad) setFit("contain"); }} disabled={format === "original" || !workspace.canEdit} />
        <OutputBackground id={`${id}-background`} value={format === "original" ? undefined : background} onChange={setBackground} disabled={format === "original" || !workspace.canEdit} />
        {source.mimeType === "image/svg+xml" && transformation ? <OutputSvg id={`${id}-svg`} value={transformation}
          onChange={(patch) => setVector((current) => ({ ...current, ...patch }))} disabled={!workspace.canEdit} /> : null}
        {transformPreview.isError && format !== "original" ? <FieldError>{transformPreview.error.message}</FieldError> : null}
        {error ? <FieldError role="alert">{error}</FieldError> : null}
        {conflict ? <Button type="button" variant="outline" onClick={async () => { await invalidate(); onClose(); }}>Close and reload settings</Button> : null}
      </FieldGroup>
      <DialogFooter><div className="flex w-full flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex gap-2">{onBack ? <Button type="button" variant="outline" onClick={onBack}>Change source</Button> : null}
          {use ? <CopyButton text={new URL(`/w/${encodeURIComponent(workspace.slug)}/${use.key.split("/").map(encodeURIComponent).join("/")}`, window.location.origin).href} label="Copy URL" /> : null}
          {use && workspace.canEdit ? <Button type="button" variant="destructive" onClick={() => setRemoving(true)}>Remove use</Button> : null}
        </div>
        {workspace.canEdit ? <Button type="submit" disabled={saving || !source.currentVersionId || !validOutputSafeArea(transformation)}>{saving ? <Spinner data-icon="inline-start" /> : null}{use ? "Save settings" : "Create use"}</Button> : null}
      </div></DialogFooter>
    </form>
    <ConfirmDialog open={removing} title="Remove this linked use?" description="The source asset, its versions and all other uses are kept. This use's URL will stop working." confirmLabel="Remove use" onCancel={() => setRemoving(false)} onConfirm={remove} />
  </>;
}
