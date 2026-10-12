export type UsageMode = "live_url" | "manual_frozen" | "opt_in_pr";
export type UsageDestination = { id: string; label: string; url: string };
export type UsageTarget =
  | { kind: "asset"; assetId: string }
  | { kind: "vard_output"; vardId: string; outputPath: string; assetId: string };
export type UsageBindingInput = {
  id: string;
  destinationId: string;
  mode: UsageMode;
  target: UsageTarget;
};
export type UsageConsumerInput = {
  name: string;
  kind: "first_party" | "selected_external";
  destinations: UsageDestination[];
  bindings: UsageBindingInput[];
};
export type UsageSource = {
  assetId: string;
  versionId: string;
  number: number;
  checksum: string | null;
  fingerprint: string;
};
export type UsageEvidence = {
  id: string;
  bindingId: string;
  checkedAt: string;
  recordedAt: string;
  actor: string;
  source: UsageSource;
  scope: {
    destination: UsageDestination;
    target: UsageTarget;
    mode: UsageMode;
    targetLabel: string;
    outputConfiguration: string;
  };
  commitRef: string | null;
  releaseRef: string | null;
  note: string | null;
};
export type UsageBinding = UsageBindingInput & {
  targetLabel: string;
  current: { resolved: boolean; reason: string | null; source: UsageSource | null; scopeToken: string };
  latestEvidence: UsageEvidence | null;
  status: "unknown" | "recorded_match" | "source_changed" | "scope_changed" | "unresolved";
};
export type UsageConsumer = Omit<UsageConsumerInput, "bindings"> & {
  id: string;
  revision: number;
  bindings: UsageBinding[];
  createdAt: string;
  updatedAt: string;
};
export type UsageCheckInput = {
  expectedRevision: number;
  expectedScopeToken: string;
  checkedAt: string;
  reportedVersionId: string;
  commitRef?: string;
  releaseRef?: string;
  note?: string;
};

export class UsageRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = "UsageRequestError";
  }
}
export function isUsageConflict(cause: unknown): cause is UsageRequestError {
  return cause instanceof UsageRequestError && cause.status === 409;
}
async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => null) as { error?: string; message?: string; code?: string } | null;
  if (!response.ok) throw new UsageRequestError(body?.message ?? body?.error ?? `Request failed (${response.status})`, response.status, body?.code);
  return body as T;
}
function root(workspaceId: string) {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/known-usages`;
}
function consumerPath(workspaceId: string, consumerId: string) {
  return `${root(workspaceId)}/${encodeURIComponent(consumerId)}`;
}
function json(method: string, body: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}
export function listKnownUsages(workspaceId: string, after: string | null = null, signal?: AbortSignal) {
  const query = new URLSearchParams({ limit: "50" });
  if (after !== null) query.set("after", after);
  return request<{ consumers: UsageConsumer[]; nextCursor: string | null }>(`${root(workspaceId)}?${query}`, { signal });
}
/** The server bounds the registered inventory to 200; count only complete reads. */
export async function getKnownUsageInventory(workspaceId: string, signal?: AbortSignal) {
  const consumers = new Map<string, UsageConsumer>();
  const cursors = new Set<string>();
  let after: string | null = null;
  // A resource-budgeted page may contain only one consumer. Allow every
  // registered consumer plus a final empty-page guard, without unbounded reads.
  for (let page = 0; page < 201; page += 1) {
    // Each cursor is returned by the preceding page.
    // oxlint-disable-next-line no-await-in-loop
    const result = await listKnownUsages(workspaceId, after, signal);
    const previousCount = consumers.size;
    for (const consumer of result.consumers) consumers.set(consumer.id, consumer);
    if (consumers.size > 200) throw new Error("Usage listing exceeded its consumer limit. Retry to reload the inventory.");
    if (!result.nextCursor) return { consumers: [...consumers.values()] };
    if (cursors.has(result.nextCursor)) throw new Error("Usage listing did not advance. Retry to reload the inventory.");
    if (consumers.size === previousCount) throw new Error("Usage listing made no progress. Retry to reload the inventory.");
    cursors.add(result.nextCursor);
    after = result.nextCursor;
  }
  throw new Error("Usage listing exceeded its limit. Retry to reload the inventory.");
}
export function getKnownUsage(workspaceId: string, consumerId: string) {
  return request<UsageConsumer>(consumerPath(workspaceId, consumerId));
}
export function createKnownUsage(workspaceId: string, input: UsageConsumerInput) {
  return request<UsageConsumer>(root(workspaceId), json("POST", input));
}
export function updateKnownUsage(workspaceId: string, consumerId: string, expectedRevision: number, input: UsageConsumerInput) {
  return request<UsageConsumer>(consumerPath(workspaceId, consumerId), json("PUT", { ...input, expectedRevision }));
}
export function deleteKnownUsage(workspaceId: string, consumerId: string, expectedRevision: number) {
  return request<void>(consumerPath(workspaceId, consumerId), json("DELETE", { expectedRevision }));
}
export function recordUsageCheck(workspaceId: string, consumerId: string, bindingId: string, input: UsageCheckInput) {
  return request<UsageConsumer>(`${consumerPath(workspaceId, consumerId)}/bindings/${encodeURIComponent(bindingId)}/checks`, json("POST", input));
}
export function listUsageChecks(workspaceId: string, consumerId: string, bindingId: string, after: string | null = null) {
  const query = new URLSearchParams({ limit: "20" });
  if (after !== null) query.set("after", after);
  return request<{ checks: UsageEvidence[]; nextCursor: string | null }>(`${consumerPath(workspaceId, consumerId)}/bindings/${encodeURIComponent(bindingId)}/checks?${query}`);
}

export type UsageVersion = {
  id: string;
  number: number;
  status: "pending" | "processing" | "ready" | "failed";
  filename: string;
};
export function listUsageVersionPage(workspaceId: string, assetId: string, before: number | null = null, signal?: AbortSignal) {
  const query = new URLSearchParams({ limit: "50" });
  if (before !== null) query.set("before", String(before));
  return request<{ currentVersionId: string | null; versions: UsageVersion[]; nextCursor: number | null }>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/assets/${encodeURIComponent(assetId)}/versions?${query}`,
    { signal },
  );
}
