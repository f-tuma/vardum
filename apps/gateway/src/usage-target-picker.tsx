import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ArrowLeftIcon, BoxesIcon, FileIcon, FolderIcon, SearchIcon, TriangleAlertIcon } from "lucide-react";
import { useId, useState } from "react";
import { getVardManifest, listVards } from "./asset-api";
import { assetBrowserQueryOptions, flattenAssetPages } from "./asset-queries";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import type { UsageTarget } from "./usage-api";

export function UsageTargetPicker({ workspaceId, onPick, onClose }: { workspaceId: string; onPick: (target: UsageTarget, label: string) => void; onClose: () => void }) {
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}><DialogContent size="lg"><DialogHeader><DialogTitle>Choose bound source</DialogTitle><DialogDescription>Select an asset or a concrete output from the current Vard, including outputs expanded from folder rules.</DialogDescription></DialogHeader><Tabs defaultValue="assets"><TabsList><TabsTrigger value="assets">Assets</TabsTrigger><TabsTrigger value="vards">Vard outputs</TabsTrigger></TabsList><TabsContent value="assets"><AssetChoices workspaceId={workspaceId} onPick={onPick} /></TabsContent><TabsContent value="vards"><VardChoices workspaceId={workspaceId} onPick={onPick} /></TabsContent></Tabs><DialogFooter><Button variant="outline" onClick={onClose}>Cancel selection</Button></DialogFooter></DialogContent></Dialog>;
}
function CandidateFailure({ message, retry, pending }: { message: string; retry: () => void; pending: boolean }) {
  return <Alert variant="destructive"><TriangleAlertIcon /><AlertTitle>Sources could not load</AlertTitle><AlertDescription><div className="flex flex-col items-start gap-2"><span>{message}</span><Button variant="outline" disabled={pending} onClick={retry}>{pending ? <Spinner data-icon="inline-start" /> : null}Retry sources</Button></div></AlertDescription></Alert>;
}
function AssetChoices({ workspaceId, onPick }: { workspaceId: string; onPick: (target: UsageTarget, label: string) => void }) {
  const [prefix, setPrefix] = useState("");
  const [search, setSearch] = useState("");
  const needle = useDebouncedValue(search.trim(), 200);
  const assets = useInfiniteQuery({ ...assetBrowserQueryOptions(workspaceId, prefix, needle), retry: false });
  const listing = flattenAssetPages(assets.data?.pages);
  const parent = prefix.split("/").filter(Boolean).slice(0, -1).join("/");
  return <div className="flex min-w-0 flex-col gap-3">
    <InputGroup><InputGroupAddon><SearchIcon /></InputGroupAddon><InputGroupInput type="search" aria-label="Search source assets" placeholder="Search source assets" value={search} onChange={(event) => setSearch(event.target.value)} /></InputGroup>
    {prefix && !needle ? <Button variant="outline" onClick={() => setPrefix(parent ? `${parent}/` : "")}><ArrowLeftIcon data-icon="inline-start" />Parent folder</Button> : null}
    {assets.isPending ? <output className="flex items-center gap-2"><Spinner />Loading assets…</output> : assets.isError ? <CandidateFailure message={assets.error.message} retry={() => void (assets.isFetchNextPageError ? assets.fetchNextPage({ cancelRefetch: false }) : assets.refetch())} pending={assets.isFetching} /> : <>
      <div className="flex min-w-0 flex-col gap-2">{listing.folders.map((folder) => <Button key={folder.prefix} variant="outline" onClick={() => setPrefix(folder.prefix)}><FolderIcon data-icon="inline-start" /><span className="truncate">{folder.name}</span></Button>)}{listing.assets.map((asset) => <Button key={asset.id} variant="outline" disabled={!asset.currentVersionId} onClick={() => onPick({ kind: "asset", assetId: asset.id }, asset.displayName)}><FileIcon data-icon="inline-start" /><span className="truncate">{asset.displayName} · {asset.key}{!asset.currentVersionId ? " · source unavailable" : ""}</span></Button>)}</div>
      {!listing.assets.length && !listing.folders.length ? <Empty><EmptyHeader><EmptyTitle>No sources found</EmptyTitle><EmptyDescription>Choose another folder or search term.</EmptyDescription></EmptyHeader></Empty> : null}
      {assets.hasNextPage ? <Button variant="outline" disabled={assets.isFetching} onClick={() => void assets.fetchNextPage({ cancelRefetch: false })}>{assets.isFetching ? <Spinner data-icon="inline-start" /> : null}Load more assets</Button> : null}
    </>}
  </div>;
}
function VardChoices({ workspaceId, onPick }: { workspaceId: string; onPick: (target: UsageTarget, label: string) => void }) {
  const id = useId();
  const [vardId, setVardId] = useState("");
  const [filter, setFilter] = useState("");
  const vards = useQuery({ queryKey: ["vards", workspaceId], queryFn: () => listVards(workspaceId), retry: false });
  const manifest = useQuery({ queryKey: ["usage-vard-outputs", workspaceId, vardId], queryFn: () => getVardManifest(workspaceId, vardId), enabled: Boolean(vardId), retry: false });
  const outputs = manifest.data?.items.filter((item) => `${item.outputPath} ${item.key}`.toLowerCase().includes(filter.trim().toLowerCase())) ?? [];
  return <div className="flex min-w-0 flex-col gap-3">{vards.isPending ? <output className="flex items-center gap-2"><Spinner />Loading Vards…</output> : vards.isError ? <CandidateFailure message={vards.error.message} retry={() => void vards.refetch()} pending={vards.isFetching} /> : vards.data.vards.length ? <FieldGroup><Field><FieldLabel htmlFor={`${id}-vard`}>Vard</FieldLabel><NativeSelect id={`${id}-vard`} value={vardId} onChange={(event) => setVardId(event.target.value)}><NativeSelectOption value="">Select a Vard</NativeSelectOption>{vards.data.vards.map((vard) => <NativeSelectOption key={vard.id} value={vard.id}>{vard.name}</NativeSelectOption>)}</NativeSelect></Field></FieldGroup> : <Empty><EmptyHeader><EmptyTitle>No Vards yet</EmptyTitle><EmptyDescription>Create a Vard to bind one of its outputs.</EmptyDescription></EmptyHeader></Empty>}
    {vardId ? (manifest.isPending ? <output className="flex items-center gap-2"><Spinner />Resolving current outputs…</output> : manifest.isError ? <CandidateFailure message={manifest.error.message} retry={() => void manifest.refetch()} pending={manifest.isFetching} /> : <>
      <InputGroup><InputGroupAddon><SearchIcon /></InputGroupAddon><InputGroupInput type="search" value={filter} aria-label="Filter Vard outputs" placeholder="Filter Vard outputs" onChange={(event) => setFilter(event.target.value)} /></InputGroup>
      <div className="flex min-w-0 flex-col gap-2">{outputs.map((item) => <Button key={`${item.outputPath}:${item.assetId}`} variant="outline" disabled={!item.versionId || !item.fingerprint} onClick={() => onPick({ kind: "vard_output", vardId, outputPath: item.outputPath, assetId: item.assetId }, `${manifest.data!.name} · ${item.key}`)}><BoxesIcon data-icon="inline-start" /><span className="truncate">{item.outputPath} · {item.key}{!item.versionId || !item.fingerprint ? " · source unavailable" : ""}</span></Button>)}</div>
      {!outputs.length ? <Empty><EmptyHeader><EmptyTitle>No concrete outputs</EmptyTitle><EmptyDescription>This Vard currently has no matching outputs.</EmptyDescription></EmptyHeader></Empty> : null}
    </>) : null}
  </div>;
}
