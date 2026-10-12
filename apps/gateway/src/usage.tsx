import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckIcon, HistoryIcon, Link2Icon, PencilIcon, PlusIcon, RefreshCwIcon, Trash2Icon, TriangleAlertIcon } from "lucide-react";
import { useId, useState, type SyntheticEvent } from "react";
import { toast } from "sonner";
import { AppHeader, Page, PageHeader, PageSkeleton } from "@/components/page";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { errorMessage } from "@/lib/format";
import { UsageTargetPicker } from "./usage-target-picker";
import { createKnownUsage, deleteKnownUsage, getKnownUsage, getKnownUsageInventory, isUsageConflict, listUsageChecks, listUsageVersionPage, recordUsageCheck, updateKnownUsage, type UsageBinding, type UsageBindingInput, type UsageConsumer, type UsageConsumerInput, type UsageEvidence, type UsageMode } from "./usage-api";
import { workspaceCrumb, type WorkspaceRef } from "./workspace";

const modeLabels: Record<UsageMode, string> = { live_url: "Live URL", manual_frozen: "Manual frozen copy", opt_in_pr: "Opt-in PR" };
const modeHelp: Record<UsageMode, string> = {
  live_url: "A stable source URL may serve newer source versions. A recorded report does not establish what the destination currently serves.",
  manual_frozen: "A copied version needs a manual update at the destination. This records the delivery preference only.",
  opt_in_pr: "Changes are intended to be proposed for review. This preference does not create a pull request or update the destination.",
};
const statusLabels: Record<UsageBinding["status"], string> = {
  unknown: "Not manually checked", recorded_match: "Matches recorded source", source_changed: "Source changed since recorded check", scope_changed: "Check scope changed", unresolved: "Unresolved reference",
};
const resolutionReasons: Record<string, string> = {
  asset_missing: "The asset was deleted or is unavailable.",
  vard_missing: "The Vard was deleted or is unavailable.",
  vard_outputs_invalid: "The Vard outputs cannot currently resolve.",
  output_missing: "The selected Vard output no longer exists.",
  output_rebound: "This output path now points to a different asset.",
  source_unavailable: "The selected source version is unavailable.",
};
function resolutionReason(reason: string | null) { return reason ? resolutionReasons[reason] ?? reason : "Source is unavailable."; }
function dateLabel(value: string) { return new Date(value).toLocaleString(); }
function queryKey(workspaceId: string) { return ["known-usages", workspaceId]; }

export function UsagePage({ workspace }: { workspace: WorkspaceRef }) {
  const client = useQueryClient();
  const [editing, setEditing] = useState<{ consumer?: UsageConsumer } | null>(null);
  const [deleting, setDeleting] = useState<UsageConsumer | null>(null);
  const [checking, setChecking] = useState<{ consumer: UsageConsumer; binding: UsageBinding } | null>(null);
  const [history, setHistory] = useState<{ consumer: UsageConsumer; binding: UsageBinding } | null>(null);
  const inventory = useQuery({ queryKey: queryKey(workspace.id), queryFn: ({ signal }) => getKnownUsageInventory(workspace.id, signal), retry: false });
  const consumers = inventory.data?.consumers ?? [];
  const bindingCount = consumers.reduce((count, consumer) => count + consumer.bindings.length, 0);
  function saved(consumer: UsageConsumer) {
    client.setQueryData<{ consumers: UsageConsumer[] }>(queryKey(workspace.id), (current) => ({ consumers: current?.consumers.some((record) => record.id === consumer.id)
      ? current.consumers.map((record) => record.id === consumer.id ? consumer : record)
      : [...(current?.consumers ?? []), consumer] }));
    void client.invalidateQueries({ queryKey: queryKey(workspace.id) });
  }
  return <>
    <AppHeader crumbs={[workspaceCrumb(workspace), { label: "Usage" }]} />
    <Page id="main">
      <PageHeader title="Usage" description="First-party and selected external destinations you register." actions={workspace.canEdit ? <Button onClick={() => setEditing({})}><PlusIcon data-icon="inline-start" />Register consumer</Button> : undefined} />
      {inventory.isPending ? <PageSkeleton /> : inventory.isError ? <RequestFailure title="Known usage could not load" error={inventory.error} retry={() => void inventory.refetch()} pending={inventory.isFetching} /> : <>
        <p className="text-sm text-muted-foreground">{consumers.length.toLocaleString()} registered consumers · {bindingCount.toLocaleString()} bindings. Coverage includes these records only; destinations are not discovered or checked automatically.</p>
        {consumers.length ? <div className="flex min-w-0 flex-col gap-4">{consumers.map((consumer) => <Card key={consumer.id}>
          <CardHeader><CardTitle>{consumer.name}</CardTitle><CardDescription>{consumer.kind === "first_party" ? "First-party" : "Selected external"} · {consumer.destinations.length} destinations</CardDescription>
            {workspace.canEdit ? <CardAction><Button variant="outline" size="sm" aria-label={`Edit ${consumer.name}`} onClick={() => setEditing({ consumer })}><PencilIcon data-icon="inline-start" />Edit</Button></CardAction> : null}
          </CardHeader>
          <CardContent><div className="flex min-w-0 flex-col gap-4">
            <ul className="flex flex-col gap-1 text-sm">{consumer.destinations.map((destination) => <li key={destination.id} className="min-w-0"><span className="font-medium">{destination.label || "Destination"}: </span><a className="break-all underline underline-offset-4" href={destination.url} target="_blank" rel="noreferrer">{destination.url}</a></li>)}</ul>
            {consumer.bindings.length ? <div className="min-w-0 overflow-x-auto"><Table>
              <TableHeader><TableRow><TableHead>Bound source</TableHead><TableHead>Destination / mode</TableHead><TableHead>Current resolved version</TableHead><TableHead>Recorded manual check</TableHead><TableHead>Status</TableHead><TableHead><span className="sr-only">Actions</span></TableHead></TableRow></TableHeader>
              <TableBody>{consumer.bindings.map((binding) => {
                const destination = consumer.destinations.find((record) => record.id === binding.destinationId);
                return <TableRow key={binding.id}>
                  <TableCell><div className="flex w-56 flex-col gap-1 whitespace-normal"><span className="break-all font-medium">{binding.targetLabel}</span><span className="text-xs text-muted-foreground">{binding.target.kind === "vard_output" ? "Vard output" : "Asset"}</span></div></TableCell>
                  <TableCell><div className="flex flex-col items-start gap-1"><span>{destination?.label || "Destination"}</span><Tooltip><TooltipTrigger render={<Button variant="ghost" size="sm" />}>{modeLabels[binding.mode]}</TooltipTrigger><TooltipContent>{modeHelp[binding.mode]}</TooltipContent></Tooltip></div></TableCell>
                  <TableCell>{binding.current.resolved && binding.current.source ? <span>Version {binding.current.source.number}</span> : <div className="flex max-w-xs flex-col gap-1 whitespace-normal"><Badge variant="outline">Unresolved</Badge><span className="text-xs text-muted-foreground">{resolutionReason(binding.current.reason)}</span></div>}</TableCell>
                  <TableCell>{binding.latestEvidence ? <div className="flex flex-col gap-1"><span>Reported version {binding.latestEvidence.source.number}</span><span className="text-xs text-muted-foreground">{dateLabel(binding.latestEvidence.checkedAt)}</span><Button variant="ghost" size="sm" onClick={() => setHistory({ consumer, binding })}><HistoryIcon data-icon="inline-start" />Check history</Button></div> : <span className="text-muted-foreground">No recorded check</span>}</TableCell>
                  <TableCell><span className="block max-w-48 whitespace-normal text-sm">{statusLabels[binding.status]}</span></TableCell>
                  <TableCell>{workspace.canEdit ? <Button variant="outline" size="sm" disabled={!binding.current.resolved} onClick={() => setChecking({ consumer, binding })}><CheckIcon data-icon="inline-start" />Record check</Button> : null}</TableCell>
                </TableRow>;
              })}</TableBody>
            </Table></div> : <p className="text-sm text-muted-foreground">No asset or Vard output bindings registered.</p>}
          </div></CardContent>
          {workspace.canEdit ? <CardFooter><Button variant="ghost" size="sm" aria-label={`Delete ${consumer.name}`} onClick={() => setDeleting(consumer)}><Trash2Icon data-icon="inline-start" />Delete consumer</Button></CardFooter> : null}
        </Card>)}</div> : <Empty variant="outline"><EmptyHeader><EmptyMedia variant="icon"><Link2Icon /></EmptyMedia><EmptyTitle>No known consumers yet</EmptyTitle><EmptyDescription>Register a consumer and its concrete destination URLs to keep a record of known use.</EmptyDescription></EmptyHeader>{workspace.canEdit ? <EmptyContent><Button onClick={() => setEditing({})}><PlusIcon data-icon="inline-start" />Register consumer</Button></EmptyContent> : null}</Empty>}
      </>}
    </Page>
    {editing ? <ConsumerDialog workspaceId={workspace.id} consumer={editing.consumer} onClose={() => setEditing(null)} onSaved={saved} /> : null}
    {deleting ? <DeleteConsumerDialog workspaceId={workspace.id} consumer={deleting} onClose={() => setDeleting(null)} onDeleted={() => { client.setQueryData<{ consumers: UsageConsumer[] }>(queryKey(workspace.id), (current) => ({ consumers: current?.consumers.filter((record) => record.id !== deleting.id) ?? [] })); void client.invalidateQueries({ queryKey: queryKey(workspace.id) }); }} /> : null}
    {checking ? <CheckDialog workspaceId={workspace.id} {...checking} onClose={() => setChecking(null)} onSaved={saved} /> : null}
    {history ? <HistoryDialog workspaceId={workspace.id} {...history} onClose={() => setHistory(null)} /> : null}
  </>;
}

function RequestFailure({ title, error, retry, pending = false }: { title: string; error: unknown; retry: () => void; pending?: boolean }) {
  return <Alert variant="destructive"><TriangleAlertIcon /><AlertTitle>{title}</AlertTitle><AlertDescription><div className="flex flex-col items-start gap-2"><span>{errorMessage(error, "Request failed")}</span><Button variant="outline" size="sm" disabled={pending} onClick={retry}>{pending ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}Retry</Button></div></AlertDescription></Alert>;
}
function MutationError({ error, conflict, reload, pending }: { error: string; conflict: boolean; reload: () => void; pending: boolean }) {
  if (!error) return null;
  return <Alert variant="destructive"><TriangleAlertIcon /><AlertTitle>{conflict ? "Record changed" : "Changes could not save"}</AlertTitle><AlertDescription><div className="flex flex-col items-start gap-2"><span>{error}</span>{conflict ? <><span>Your unsaved changes are kept. Reload the latest record before saving.</span><Button variant="outline" disabled={pending} onClick={reload}>{pending ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}Reload and discard changes</Button></> : null}</div></AlertDescription></Alert>;
}
function consumerDraft(consumer?: UsageConsumer): UsageConsumerInput {
  return consumer ? { name: consumer.name, kind: consumer.kind, destinations: consumer.destinations.map((destination) => ({ ...destination })), bindings: consumer.bindings.map(({ id, destinationId, mode, target }) => ({ id, destinationId, mode, target: { ...target } })) } : { name: "", kind: "first_party", destinations: [{ id: crypto.randomUUID(), label: "", url: "" }], bindings: [] };
}
function ConsumerDialog({ workspaceId, consumer, onClose, onSaved }: { workspaceId: string; consumer?: UsageConsumer; onClose: () => void; onSaved: (consumer: UsageConsumer) => void }) {
  const id = useId();
  const [baseline, setBaseline] = useState(consumer);
  const [draft, setDraft] = useState(() => consumerDraft(consumer));
  const [labels, setLabels] = useState<Record<string, string>>(() => Object.fromEntries(consumer?.bindings.map((binding) => [binding.id, binding.targetLabel]) ?? []));
  const [picking, setPicking] = useState<string | "new" | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [urlErrors, setUrlErrors] = useState<Record<string, string>>({});
  function changeBinding(bindingId: string, patch: Partial<UsageBindingInput>) { setDraft((current) => ({ ...current, bindings: current.bindings.map((binding) => binding.id === bindingId ? { ...binding, ...patch } : binding) })); }
  async function reload() {
    if (!baseline || pending) return;
    setPending(true);
    try {
      const fresh = await getKnownUsage(workspaceId, baseline.id);
      setBaseline(fresh); setDraft(consumerDraft(fresh)); setLabels(Object.fromEntries(fresh.bindings.map((binding) => [binding.id, binding.targetLabel]))); setConflict(false); setError(""); setUrlErrors({}); onSaved(fresh);
    } catch (cause) { setError(errorMessage(cause, "Reload failed; your draft is kept")); }
    finally { setPending(false); }
  }
  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || conflict) return;
    const invalid: Record<string, string> = {};
    for (const destination of draft.destinations) {
      try { const url = new URL(destination.url); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) invalid[destination.id] = "Enter a concrete HTTP(S) URL without credentials."; }
      catch { invalid[destination.id] = "Enter a concrete HTTP(S) URL."; }
    }
    setUrlErrors(invalid); if (Object.keys(invalid).length) return;
    setError(""); setPending(true);
    try {
      const input = { ...draft, name: draft.name.trim(), destinations: draft.destinations.map((destination) => ({ ...destination, label: destination.label.trim(), url: destination.url.trim() })) };
      const result = baseline ? await updateKnownUsage(workspaceId, baseline.id, baseline.revision, input) : await createKnownUsage(workspaceId, input);
      onSaved(result); toast.success(baseline ? "Consumer updated" : "Consumer registered"); onClose();
    } catch (cause) { setConflict(isUsageConflict(cause)); setError(errorMessage(cause, "Consumer could not save")); }
    finally { setPending(false); }
  }
  return <Dialog open onOpenChange={(open) => { if (!open && !pending) onClose(); }}><DialogContent size="xl" showCloseButton={!pending}>
    <DialogHeader><DialogTitle>{baseline ? "Edit consumer" : "Register consumer"}</DialogTitle><DialogDescription>Record known destinations and bound sources. Saved URLs are not fetched or checked automatically.</DialogDescription></DialogHeader>
    <form onSubmit={(event) => void submit(event)} className="flex min-w-0 flex-col gap-5">
      <FieldGroup>
        <Field><FieldLabel htmlFor={`${id}-name`}>Consumer name</FieldLabel><Input id={`${id}-name`} required minLength={1} maxLength={120} value={draft.name} disabled={pending} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} /></Field>
        <Field><FieldLabel id={`${id}-kind`}>Consumer type</FieldLabel><ToggleGroup aria-labelledby={`${id}-kind`} variant="outline" value={[draft.kind]} onValueChange={(values) => { const kind = values[0]; if (kind === "first_party" || kind === "selected_external") setDraft((current) => ({ ...current, kind })); }} disabled={pending}><ToggleGroupItem value="first_party">First-party</ToggleGroupItem><ToggleGroupItem value="selected_external">Selected external</ToggleGroupItem></ToggleGroup></Field>
        <FieldSet><FieldLegend>Destination URLs</FieldLegend><FieldDescription>Use concrete pages, applications, or endpoints where this consumer uses the source.</FieldDescription><FieldGroup>
          {draft.destinations.map((destination, index) => <FieldSet key={destination.id}><FieldLegend variant="label">Destination {index + 1}</FieldLegend><FieldGroup>
            <Field><FieldLabel htmlFor={`${id}-label-${destination.id}`}>Destination label {index + 1}</FieldLabel><Input id={`${id}-label-${destination.id}`} required maxLength={120} value={destination.label} disabled={pending} onChange={(event) => setDraft((current) => ({ ...current, destinations: current.destinations.map((record) => record.id === destination.id ? { ...record, label: event.target.value } : record) }))} /></Field>
            <Field data-invalid={Boolean(urlErrors[destination.id])}><FieldLabel htmlFor={`${id}-url-${destination.id}`}>Destination URL {index + 1}</FieldLabel><Input id={`${id}-url-${destination.id}`} type="url" required maxLength={2048} value={destination.url} disabled={pending} aria-invalid={Boolean(urlErrors[destination.id])} aria-describedby={urlErrors[destination.id] ? `${id}-url-error-${destination.id}` : undefined} onChange={(event) => { setDraft((current) => ({ ...current, destinations: current.destinations.map((record) => record.id === destination.id ? { ...record, url: event.target.value } : record) })); setUrlErrors((current) => ({ ...current, [destination.id]: "" })); }} />{urlErrors[destination.id] ? <FieldError id={`${id}-url-error-${destination.id}`}>{urlErrors[destination.id]}</FieldError> : null}</Field>
            {draft.destinations.length > 1 ? <Button variant="outline" type="button" disabled={pending} onClick={() => setDraft((current) => ({ ...current, destinations: current.destinations.filter((record) => record.id !== destination.id), bindings: current.bindings.filter((binding) => binding.destinationId !== destination.id) }))}><Trash2Icon data-icon="inline-start" />Remove destination {index + 1} and its bindings</Button> : null}
          </FieldGroup></FieldSet>)}
          <Button variant="outline" type="button" disabled={pending || draft.destinations.length >= 20} onClick={() => setDraft((current) => ({ ...current, destinations: [...current.destinations, { id: crypto.randomUUID(), label: "", url: "" }] }))}><PlusIcon data-icon="inline-start" />Add destination</Button>
        </FieldGroup></FieldSet>
        <FieldSet><FieldLegend>Bound assets and Vard outputs</FieldLegend><FieldDescription>Each binding keeps its own source identity, destination, and delivery preference.</FieldDescription><FieldGroup>
          {draft.bindings.map((binding, index) => <FieldSet key={binding.id}><FieldLegend variant="label">Binding {index + 1}: {labels[binding.id] ?? "Source"}</FieldLegend><FieldGroup>
            <Field><FieldLabel>Source</FieldLabel><div className="flex min-w-0 flex-wrap items-center gap-2"><span className="min-w-0 break-all">{labels[binding.id] ?? "Source"}{binding.target.kind === "vard_output" ? ` · ${binding.target.outputPath}` : ""}</span><Button variant="outline" type="button" disabled={pending} onClick={() => setPicking(binding.id)}>Change source {index + 1}</Button></div></Field>
            <Field><FieldLabel htmlFor={`${id}-destination-${binding.id}`}>Binding destination {index + 1}</FieldLabel><NativeSelect id={`${id}-destination-${binding.id}`} value={binding.destinationId} disabled={pending} onChange={(event) => changeBinding(binding.id, { destinationId: event.target.value })}>{draft.destinations.map((destination, destinationIndex) => <NativeSelectOption key={destination.id} value={destination.id}>{destination.label || `Destination ${destinationIndex + 1}`}</NativeSelectOption>)}</NativeSelect></Field>
            <Field><FieldLabel id={`${id}-mode-${binding.id}`}>Delivery mode {index + 1}</FieldLabel><div className="-m-1 overflow-x-auto p-1"><ToggleGroup aria-labelledby={`${id}-mode-${binding.id}`} variant="outline" value={[binding.mode]} disabled={pending} onValueChange={(values) => { const mode = values[0] as UsageMode | undefined; if (mode && Object.hasOwn(modeLabels, mode)) changeBinding(binding.id, { mode }); }}>{Object.entries(modeLabels).map(([mode, label]) => <ToggleGroupItem key={mode} value={mode}>{label}</ToggleGroupItem>)}</ToggleGroup></div><FieldDescription>{modeHelp[binding.mode]}</FieldDescription></Field>
            <Button variant="outline" type="button" disabled={pending} onClick={() => setDraft((current) => ({ ...current, bindings: current.bindings.filter((record) => record.id !== binding.id) }))}><Trash2Icon data-icon="inline-start" />Remove binding {index + 1}</Button>
          </FieldGroup></FieldSet>)}
          <Button variant="outline" type="button" disabled={pending || draft.bindings.length >= 100} onClick={() => setPicking("new")}><PlusIcon data-icon="inline-start" />Add binding</Button>
        </FieldGroup></FieldSet>
      </FieldGroup>
      <MutationError error={error} conflict={conflict} reload={() => void reload()} pending={pending} />
      <DialogFooter><Button type="button" variant="outline" disabled={pending} onClick={onClose}>Cancel</Button><Button type="submit" disabled={pending || conflict}>{pending ? <Spinner data-icon="inline-start" /> : null}{baseline ? "Save consumer" : "Register consumer"}</Button></DialogFooter>
    </form>
    {picking ? <UsageTargetPicker workspaceId={workspaceId} onClose={() => setPicking(null)} onPick={(target, label) => {
      const bindingId = picking === "new" ? crypto.randomUUID() : picking;
      if (picking === "new") setDraft((current) => ({ ...current, bindings: [...current.bindings, { id: bindingId, target, destinationId: current.destinations[0]!.id, mode: "live_url" }] }));
      else changeBinding(bindingId, { target });
      setLabels((current) => ({ ...current, [bindingId]: label })); setPicking(null);
    }} /> : null}
  </DialogContent></Dialog>;
}

function DeleteConsumerDialog({ workspaceId, consumer, onClose, onDeleted }: { workspaceId: string; consumer: UsageConsumer; onClose: () => void; onDeleted: () => void }) {
  const [baseline, setBaseline] = useState(consumer);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  async function remove() {
    if (pending || conflict) return;
    setPending(true); setError("");
    try { await deleteKnownUsage(workspaceId, baseline.id, baseline.revision); onDeleted(); toast.success("Consumer deleted"); onClose(); }
    catch (cause) { setConflict(isUsageConflict(cause)); setError(errorMessage(cause, "Consumer could not delete")); }
    finally { setPending(false); }
  }
  async function reload() {
    setPending(true);
    try { setBaseline(await getKnownUsage(workspaceId, baseline.id)); setConflict(false); setError(""); }
    catch (cause) { setError(errorMessage(cause, "Reload failed")); }
    finally { setPending(false); }
  }
  return <Dialog open onOpenChange={(open) => { if (!open && !pending) onClose(); }}><DialogContent showCloseButton={!pending}><DialogHeader><DialogTitle>Delete consumer</DialogTitle><DialogDescription>Delete {baseline.name}, its destination bindings, and its manual check history?</DialogDescription></DialogHeader><MutationError error={error} conflict={conflict} pending={pending} reload={() => void reload()} /><DialogFooter><Button variant="outline" disabled={pending} onClick={onClose}>Cancel</Button><Button variant="destructive" disabled={pending || conflict} onClick={() => void remove()}>{pending ? <Spinner data-icon="inline-start" /> : null}Delete consumer</Button></DialogFooter></DialogContent></Dialog>;
}

function CheckDialog({ workspaceId, consumer, binding, onClose, onSaved }: { workspaceId: string; consumer: UsageConsumer; binding: UsageBinding; onClose: () => void; onSaved: (consumer: UsageConsumer) => void }) {
  const id = useId();
  const [baseline, setBaseline] = useState({ consumer, binding });
  const [dateReset, setDateReset] = useState(0);
  const [version, setVersion] = useState("");
  const [commitRef, setCommitRef] = useState("");
  const [releaseRef, setReleaseRef] = useState("");
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const versions = useInfiniteQuery({
    queryKey: ["usage-report-versions", workspaceId, baseline.binding.target.assetId],
    queryFn: ({ pageParam, signal }) => listUsageVersionPage(workspaceId, baseline.binding.target.assetId, pageParam, signal),
    initialPageParam: null as number | null,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    retry: false,
  });
  const ready = [...new Map(versions.data?.pages.flatMap((page) => page.versions).filter((record) => record.status === "ready").map((record) => [record.id, record]) ?? []).values()];
  const versionLoadFailed = versions.isError && !versions.data;
  const destination = baseline.consumer.destinations.find((record) => record.id === baseline.binding.destinationId);
  async function reload() {
    if (pending) return;
    setPending(true);
    try {
      const fresh = await getKnownUsage(workspaceId, baseline.consumer.id);
      const freshBinding = fresh.bindings.find((record) => record.id === baseline.binding.id);
      if (!freshBinding) throw new Error("This binding was removed. Close this dialog and reload usage.");
      setBaseline({ consumer: fresh, binding: freshBinding }); setDateReset((current) => current + 1); setVersion(""); setCommitRef(""); setReleaseRef(""); setNote(""); setConflict(false); setError(""); onSaved(fresh);
      await versions.refetch();
    } catch (cause) { setError(errorMessage(cause, "Reload failed; your draft is kept")); }
    finally { setPending(false); }
  }
  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    // Let the native date editor retain intermediate/committed values across
    // sibling renders; read only the explicit entered value at submission.
    const date = String(new FormData(event.currentTarget).get("checkedAt") ?? "");
    if (pending || conflict || !baseline.binding.current.resolved || !date || !version) return;
    setPending(true); setError("");
    try {
      const result = await recordUsageCheck(workspaceId, baseline.consumer.id, baseline.binding.id, {
        expectedRevision: baseline.consumer.revision, expectedScopeToken: baseline.binding.current.scopeToken, checkedAt: new Date(date).toISOString(), reportedVersionId: version,
        ...(commitRef.trim() ? { commitRef: commitRef.trim() } : {}), ...(releaseRef.trim() ? { releaseRef: releaseRef.trim() } : {}), ...(note.trim() ? { note: note.trim() } : {}),
      });
      onSaved(result); toast.success("Manual check recorded"); onClose();
    } catch (cause) { setConflict(isUsageConflict(cause)); setError(errorMessage(cause, "Manual check could not save")); }
    finally { setPending(false); }
  }
  return <Dialog open onOpenChange={(open) => { if (!open && !pending) onClose(); }}><DialogContent size="lg" showCloseButton={!pending}><DialogHeader><DialogTitle>Record manual check</DialogTitle><DialogDescription>A human report about this destination. Recording it does not verify deployment, fetch the URL, or inspect a lockfile.</DialogDescription></DialogHeader>
    <div className="flex min-w-0 flex-col gap-1 text-sm"><span className="font-medium">{baseline.binding.targetLabel}</span><span className="break-all">{destination?.url}</span><span className="text-muted-foreground">Current resolved version: {baseline.binding.current.source ? `Version ${baseline.binding.current.source.number}` : "Unresolved"}</span></div>
    <form className="flex flex-col gap-5" onSubmit={(event) => void submit(event)}><FieldGroup>
      <Field><FieldLabel htmlFor={`${id}-date`}>Date and time checked</FieldLabel><Input key={dateReset} id={`${id}-date`} name="checkedAt" type="datetime-local" required defaultValue="" disabled={pending} aria-describedby={`${id}-date-help`} /><FieldDescription id={`${id}-date-help`}>Enter when you manually checked the destination, in your local time.</FieldDescription></Field>
      <Field><FieldLabel htmlFor={`${id}-version`}>Reported checked version</FieldLabel>{versions.isPending ? <output className="flex items-center gap-2"><Spinner />Loading source versions…</output> : versionLoadFailed ? <RequestFailure title="Versions could not load" error={versions.error} retry={() => void versions.refetch()} pending={versions.isFetching} /> : <NativeSelect id={`${id}-version`} required value={version} disabled={pending || !baseline.binding.current.resolved} onChange={(event) => setVersion(event.target.value)}><NativeSelectOption value="">Select the version you observed</NativeSelectOption>{ready.map((record) => <NativeSelectOption key={record.id} value={record.id}>Version {record.number} · {record.filename}{record.id === baseline.binding.current.source?.versionId ? " · currently resolved" : ""}</NativeSelectOption>)}</NativeSelect>}<FieldDescription>Choose what you observed. The current source version is not assumed to be in use.</FieldDescription>
        {versions.isFetchNextPageError ? <RequestFailure title="Older versions could not load" error={versions.error} retry={() => void versions.fetchNextPage({ cancelRefetch: false })} pending={versions.isFetching} /> : versions.hasNextPage ? <div><Button type="button" variant="outline" disabled={pending || versions.isFetching} onClick={() => void versions.fetchNextPage({ cancelRefetch: false })}>{versions.isFetchingNextPage ? <Spinner data-icon="inline-start" /> : null}Older versions</Button></div> : null}
      </Field>
      <Field><FieldLabel htmlFor={`${id}-commit`}>Commit reference (optional)</FieldLabel><Input id={`${id}-commit`} value={commitRef} maxLength={200} disabled={pending} onChange={(event) => setCommitRef(event.target.value)} /></Field>
      <Field><FieldLabel htmlFor={`${id}-release`}>Release reference (optional)</FieldLabel><Input id={`${id}-release`} value={releaseRef} maxLength={200} disabled={pending} onChange={(event) => setReleaseRef(event.target.value)} /></Field>
      <Field><FieldLabel htmlFor={`${id}-note`}>Check note (optional)</FieldLabel><Textarea id={`${id}-note`} value={note} maxLength={2000} disabled={pending} onChange={(event) => setNote(event.target.value)} /></Field>
    </FieldGroup>{!baseline.binding.current.resolved ? <Alert><AlertTitle>Source is unresolved</AlertTitle><AlertDescription>{resolutionReason(baseline.binding.current.reason)}</AlertDescription></Alert> : null}<MutationError error={error} conflict={conflict} reload={() => void reload()} pending={pending} /><DialogFooter><Button type="button" variant="outline" disabled={pending} onClick={onClose}>Cancel</Button><Button type="submit" disabled={pending || conflict || versions.isPending || versionLoadFailed || !ready.length || !baseline.binding.current.resolved}>{pending ? <Spinner data-icon="inline-start" /> : null}Record manual check</Button></DialogFooter></form>
  </DialogContent></Dialog>;
}
function EvidenceReport({ evidence }: { evidence: UsageEvidence }) {
  return <Card><CardHeader><CardTitle>Reported version {evidence.source.number}</CardTitle><CardDescription>Manually checked {dateLabel(evidence.checkedAt)}</CardDescription></CardHeader><CardContent><div className="flex min-w-0 flex-col gap-2 text-sm"><p className="break-all">Recorded by {evidence.actor} on {dateLabel(evidence.recordedAt)}</p><p className="break-all">Destination at check: {evidence.scope.destination.label ? `${evidence.scope.destination.label} · ` : ""}{evidence.scope.destination.url}</p><p>Delivery preference at check: {modeLabels[evidence.scope.mode]}</p><p className="break-all">Source at check: {evidence.scope.targetLabel}{evidence.scope.target.kind === "vard_output" ? ` · ${evidence.scope.target.outputPath}` : ""}</p>{evidence.commitRef ? <p className="break-all">Reported commit: {evidence.commitRef}</p> : null}{evidence.releaseRef ? <p className="break-all">Reported release: {evidence.releaseRef}</p> : null}{evidence.note ? <p className="whitespace-pre-wrap break-words">{evidence.note}</p> : null}</div></CardContent></Card>;
}
function HistoryDialog({ workspaceId, consumer, binding, onClose }: { workspaceId: string; consumer: UsageConsumer; binding: UsageBinding; onClose: () => void }) {
  const [after, setAfter] = useState<string | null>(null);
  const checks = useQuery({ queryKey: ["usage-checks", workspaceId, consumer.id, binding.id, after], queryFn: () => listUsageChecks(workspaceId, consumer.id, binding.id, after), retry: false });
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}><DialogContent size="lg"><DialogHeader><DialogTitle>Manual check history</DialogTitle><DialogDescription>{binding.targetLabel}. These are recorded human reports; current deployment is not verified.</DialogDescription></DialogHeader>{checks.isPending ? <PageSkeleton /> : checks.isError ? <RequestFailure title="Checks could not load" error={checks.error} retry={() => void checks.refetch()} pending={checks.isFetching} /> : <div className="flex flex-col gap-4">{checks.data.checks.map((evidence) => <EvidenceReport key={evidence.id} evidence={evidence} />)}{!checks.data.checks.length ? <Empty><EmptyHeader><EmptyTitle>No recorded checks</EmptyTitle></EmptyHeader></Empty> : null}<div className="flex flex-wrap gap-2">{after ? <Button variant="outline" onClick={() => setAfter(null)}>Latest checks</Button> : null}{checks.data.nextCursor ? <Button variant="outline" onClick={() => setAfter(checks.data.nextCursor)}>Older checks</Button> : null}</div></div>}<DialogFooter><Button variant="outline" onClick={onClose}>Close</Button></DialogFooter></DialogContent></Dialog>;
}
