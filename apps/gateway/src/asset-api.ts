import { mimeForFilename, uploadLimitFor } from "@vardum/shared";
import type {
  SyncAsset,
  Transformation as TransformationInput,
  UploadLimits,
  VardItem,
  VardManifest,
  VardDefinition,
  VardEditorDefinition,
  VardEditorItemInput,
  VardFolderRule,
} from "@vardum/shared";

export type {
  SyncAsset,
  TransformationInput,
  UploadLimits,
  VardItem,
  VardManifest,
};

export type VardMetadata = Pick<
  VardDefinition,
  "id" | "name" | "isPublic" | "updatedAt" | "folderRules"
>;

export type VardSummary = {
  id: string;
  name: string;
  isPublic: boolean;
  updatedAt: string;
  itemCount: number;
};

export type DeploymentCapabilities = {
  passwordRecovery: boolean;
  emailChange: boolean;
  invitations: boolean;
  vardEditRevision?: number;
};

export function getDeploymentCapabilities() {
  return request<DeploymentCapabilities>("/api/capabilities");
}

export type OrganizationDirectory = {
  canCreateOrganization: boolean;
  organizationCreation: {
    status: "allowed" | "not_allowed" | "email_verification_required";
    verificationEmailEnabled: boolean;
  };
  organizations: Array<{
    id: string;
    name: string;
    slug: string;
    role: "owner" | "editor" | "viewer";
    canCreateWorkspace: boolean;
    workspaces: Array<{ id: string; name: string; slug: string }>;
  }>;
};

export type AssetFolder = { name: string; prefix: string };

export type AssetVersion = {
  id: string;
  number: number;
  status: "pending" | "processing" | "ready" | "failed";
  filename: string;
  mimeType: string;
  size: number;
  width: number | null;
  height: number | null;
  checksum: string | null;
  error: string | null;
  retryable: boolean;
  createdAt: string;
  createdBy: string;
  current: boolean;
};

export type DeliverySummary = {
  requests30d: number;
  transformed30d: number;
  bytes30d: number;
  cacheHits30d: number;
  cacheHitRatio: number | null;
  days: Array<{
    date: string;
    requests: number;
    transformed: number;
    bytes: number;
    cacheHits: number;
    cacheMisses: number;
  }>;
};

export type AssetSummary = {
  isPublic: boolean;
  archivedAt?: string | null;
  hasUnfinishedUploads?: boolean;
  id: string;
  key: string;
  displayName: string;
  currentVersionId: string | null;
  latestVersionId: string | null;
  status: "pending" | "processing" | "ready" | "failed" | null;
  error: string | null;
  mimeType: string | null;
  size: number | null;
  width: number | null;
  height: number | null;
  thumbnailUrl: string | null;
  customDomain?: string | null;
  updatedAt: string;
};

// Private browser links must share the app cookie, never a custom-domain origin.
export function assetDeliveryPath(
  workspaceSlug: string,
  asset: Pick<AssetSummary, "key" | "isPublic" | "customDomain">,
) {
  const encodedKey = asset.key.split("/").map(encodeURIComponent).join("/");
  return asset.isPublic && asset.customDomain
    ? `https://${asset.customDomain}/w/${encodedKey}`
    : `/w/${encodeURIComponent(workspaceSlug)}/${encodedKey}`;
}

/** Pin browser previews to current bytes without changing the shareable URL. */
export function assetPreviewUrl(
  workspaceSlug: string,
  asset: Pick<AssetSummary, "key" | "isPublic" | "customDomain" | "currentVersionId" | "thumbnailUrl">,
  url: string | null | undefined = asset.thumbnailUrl,
) {
  if (!url || !asset.currentVersionId) return null;
  const suffixAt = url.search(/[?#]/);
  const path = suffixAt === -1 ? url : url.slice(0, suffixAt);
  const suffix = suffixAt === -1 ? "" : url.slice(suffixAt);
  const stablePath = assetDeliveryPath(workspaceSlug, asset);
  // Existing immutable links can intentionally refer to a pinned old version.
  if (path !== stablePath) return url;
  const encodedKey = asset.key.split("/").map(encodeURIComponent).join("/");
  const prefix = stablePath.slice(0, stablePath.length - encodedKey.length);
  return `${prefix}__v/${encodeURIComponent(asset.currentVersionId)}/${encodedKey}${suffix}`;
}

type CreatedAsset = Pick<AssetSummary, "id" | "key" | "displayName">;
type UploadVersion = {
  id: string;
  upload: { method: "POST"; url: string; fields: Record<string, string> };
};
export type WorkspaceDomain = {
  domain: string | null;
  status: "unconfigured" | "pending" | "verified";
  verifiedAt: string | null;
  target: string | null;
  verification: { name: string; value: string } | null;
  checks?: { txt: boolean; cname: boolean };
};
export type WorkspaceMember = {
  id: string;
  userId: string;
  role: "owner" | "editor" | "viewer";
  createdAt: string;
  name: string;
  email: string;
};
export type WorkspaceInvitation = {
  id: string;
  email: string;
  role: "owner" | "editor" | "viewer";
  status: "pending";
  expiresAt: string;
  createdAt: string;
};
export type WorkspaceApiKey = {
  id: string;
  name: string | null;
  start: string | null;
  enabled: boolean | null;
  access: "read" | "write";
  createdAt: string;
  lastRequest: string | null;
};
export type WorkspaceOverview = {
  assets: number;
  versions: number;
  storageBytes: number;
  delivery: DeliverySummary;
  activity: Array<{
    id: string;
    action: string;
    targetType: string;
    targetId: string;
    metadata: Record<string, unknown>;
    actor: {
      type: "user" | "api_key" | "system";
      id: string | null;
      name: string;
      email: string | null;
    };
    createdAt: string;
  }>;
};

export function getOrganizationDirectory() {
  return request<OrganizationDirectory>("/api/organizations");
}

export function createOrganizationWorkspace(
  organizationId: string,
  input: { name: string; slug: string },
) {
  return request<{
    id: string;
    organizationId: string;
    name: string;
    slug: string;
  }>(`/api/organizations/${organizationId}/workspaces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function listVards(workspaceId: string) {
  return request<{ vards: VardSummary[] }>(
    `/api/workspaces/${workspaceId}/vards`,
  );
}

export function createVard(
  workspaceId: string,
  input: { name: string; isPublic: boolean; folderRules?: VardFolderRule[] },
) {
  return request<VardMetadata>(`/api/workspaces/${workspaceId}/vards`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function getVard(workspaceId: string, vardId: string) {
  return request<VardDefinition>(
    `/api/workspaces/${workspaceId}/vards/${vardId}`,
  );
}

export function getVardManifest(workspaceId: string, vardId: string) {
  return request<VardManifest>(
    `/api/workspaces/${workspaceId}/vards/${vardId}/manifest`,
  );
}

export function updateVard(
  workspaceId: string,
  vardId: string,
  input: { name?: string; isPublic?: boolean; folderRules?: VardFolderRule[] },
) {
  return request<VardMetadata>(
    `/api/workspaces/${workspaceId}/vards/${vardId}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
}

export function replaceVardItems(
  workspaceId: string,
  vardId: string,
  items: Array<{
    assetId: string;
    versionId: string | null;
    outputPath: string;
    transformation: TransformationInput | null;
    writable: boolean;
  }>,
) {
  return request<VardDefinition>(
    `/api/workspaces/${workspaceId}/vards/${vardId}/items`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items }),
    },
  );
}

export function deleteVard(workspaceId: string, vardId: string) {
  return request<void>(`/api/workspaces/${workspaceId}/vards/${vardId}`, {
    method: "DELETE",
  });
}

// Editor writes exclusively use dedicated guarded routes. Old replicas fail closed.
export class ApiRequestError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly currentRevision?: string;

  constructor(message: string, status: number, code?: string, currentRevision?: string) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
    this.currentRevision = currentRevision;
  }
}

export class VardEditorUnavailableError extends Error {
  constructor() {
    super("This server did not supply a valid Vard revision. Editing is unavailable until the server is updated.");
    this.name = "VardEditorUnavailableError";
  }
}

export function isVardRevisionConflict(cause: unknown): cause is ApiRequestError {
  return cause instanceof ApiRequestError && cause.status === 409 && cause.code === "vard_revision_conflict";
}

export function hasVardRevision(definition: VardDefinition): definition is VardDefinition & { revision: string } {
  return typeof definition.revision === "string" && /^v1:[a-f0-9]{64}$/.test(definition.revision);
}

function checkedVardEditor(definition: VardDefinition): VardEditorDefinition {
  if (!hasVardRevision(definition) || definition.items.some((item) =>
    item.pinnedVersionId !== null && typeof item.pinnedVersionId !== "string"
  )) throw new VardEditorUnavailableError();
  return definition as VardEditorDefinition;
}

function requireVardRevision(revision: string) {
  if (!/^v1:[a-f0-9]{64}$/.test(revision)) throw new VardEditorUnavailableError();
}

export async function getVardEditor(workspaceId: string, vardId: string) {
  return checkedVardEditor(await request<VardDefinition>(
    `/api/workspaces/${workspaceId}/vards/${vardId}/editor`,
  ));
}

export async function updateVardEditor(
  workspaceId: string,
  vardId: string,
  expectedRevision: string,
  input: { name?: string; isPublic?: boolean; folderRules?: VardFolderRule[] },
) {
  requireVardRevision(expectedRevision);
  return checkedVardEditor(await request<VardDefinition>(
    `/api/workspaces/${workspaceId}/vards/${vardId}/editor`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...input, expectedRevision }),
    },
  ));
}

export async function replaceVardEditorItems(
  workspaceId: string,
  vardId: string,
  expectedRevision: string,
  items: VardEditorItemInput[],
) {
  requireVardRevision(expectedRevision);
  return checkedVardEditor(await request<VardDefinition>(
    `/api/workspaces/${workspaceId}/vards/${vardId}/editor/items`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision, items }),
    },
  ));
}

export function deleteVardEditor(workspaceId: string, vardId: string, expectedRevision: string) {
  requireVardRevision(expectedRevision);
  const query = new URLSearchParams({ expectedRevision });
  return request<void>(`/api/workspaces/${workspaceId}/vards/${vardId}/editor?${query}`, {
    method: "DELETE",
  });
}

export async function listSyncAssets(workspaceId: string) {
  const assets: SyncAsset[] = [];
  let workspaceSlug: string | undefined;
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams({ limit: "500" });
    if (cursor) query.set("cursor", cursor);
    // oxlint-disable-next-line no-await-in-loop -- each page needs the previous page's cursor
    const page = await request<{
      workspaceSlug: string;
      assets: SyncAsset[];
      nextCursor: string | null;
    }>(`/api/workspaces/${workspaceId}/sync/assets?${query}`);
    assets.push(...page.assets);
    workspaceSlug = page.workspaceSlug;
    cursor = page.nextCursor;
  } while (cursor);
  return { assets, workspaceSlug };
}

export type AuditEvent = WorkspaceOverview["activity"][number];
export type AuditFilters = {
  action?: string;
  actorType?: "user" | "api_key" | "system";
  cursor?: string;
};

export function listAuditEvents(workspaceId: string, filters: AuditFilters) {
  const query = new URLSearchParams({ limit: "50" });
  for (const [key, value] of Object.entries(filters))
    if (value) query.set(key, value);
  return request<{ events: AuditEvent[]; nextCursor: string | null }>(
    `/api/workspaces/${workspaceId}/audit?${query}`,
  );
}

export function createCliKey(
  workspaceId: string,
  input: { label: string; access: "read" | "write" },
) {
  return request<{ id: string; name: string; key: string; access: string }>(
    `/api/workspaces/${workspaceId}/cli-keys`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
}

export function getWorkspaceOverview(workspaceId: string) {
  return request<WorkspaceOverview>(`/api/workspaces/${workspaceId}/overview`);
}

export function updateWorkspace(workspaceId: string, name: string) {
  return request<{ id: string; name: string; slug: string }>(
    `/api/workspaces/${workspaceId}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    },
  );
}

export function getWorkspaceDomain(workspaceId: string) {
  return request<WorkspaceDomain>(`/api/workspaces/${workspaceId}/domain`);
}

export function configureWorkspaceDomain(workspaceId: string, domain: string) {
  return request<WorkspaceDomain>(`/api/workspaces/${workspaceId}/domain`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ domain }),
  });
}

export function verifyWorkspaceDomain(workspaceId: string) {
  return request<WorkspaceDomain>(
    `/api/workspaces/${workspaceId}/domain/verify`,
    { method: "POST" },
  );
}

export function removeWorkspaceDomain(workspaceId: string) {
  return request(`/api/workspaces/${workspaceId}/domain`, {
    method: "DELETE",
  });
}

export function deleteWorkspace(workspaceId: string, confirmation: string) {
  return request(`/api/workspaces/${workspaceId}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirmation }),
  });
}

export function listWorkspaceMembers(workspaceId: string) {
  return request<{ members: WorkspaceMember[] }>(
    `/api/workspaces/${workspaceId}/members`,
  );
}

export function updateWorkspaceMemberRole(
  workspaceId: string,
  memberId: string,
  role: WorkspaceMember["role"],
) {
  return request<WorkspaceMember>(
    `/api/workspaces/${workspaceId}/members/${memberId}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role }),
    },
  );
}

export function listWorkspaceInvitations(workspaceId: string) {
  return request<{ invitations: WorkspaceInvitation[] }>(
    `/api/workspaces/${workspaceId}/invitations`,
  );
}

export function createWorkspaceInvitation(
  workspaceId: string,
  input: Pick<WorkspaceInvitation, "email" | "role">,
) {
  return request<WorkspaceInvitation & { emailSent: boolean }>(
    `/api/workspaces/${workspaceId}/invitations`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
}

export function resendWorkspaceInvitation(
  workspaceId: string,
  invitationId: string,
) {
  return request<{ expiresAt: string }>(
    `/api/workspaces/${workspaceId}/invitations/${invitationId}/resend`,
    { method: "POST" },
  );
}

export function revokeWorkspaceInvitation(
  workspaceId: string,
  invitationId: string,
) {
  return request(`/api/workspaces/${workspaceId}/invitations/${invitationId}`, {
    method: "DELETE",
  });
}

export function acceptWorkspaceInvitation(invitationId: string) {
  return request<{ workspaceId: string; workspaceName: string }>(
    `/api/invitations/${invitationId}/accept`,
    { method: "POST" },
  );
}

export function listWorkspaceApiKeys(workspaceId: string) {
  return request<{ keys: WorkspaceApiKey[] }>(
    `/api/workspaces/${workspaceId}/api-keys`,
  );
}

export function createWorkspaceApiKey(
  workspaceId: string,
  input: { name: string; access: WorkspaceApiKey["access"] },
) {
  return request<WorkspaceApiKey & { key: string }>(
    `/api/workspaces/${workspaceId}/api-keys`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
}

export function deleteWorkspaceApiKey(workspaceId: string, keyId: string) {
  return request<void>(`/api/workspaces/${workspaceId}/api-keys/${keyId}`, {
    method: "DELETE",
  });
}

export function createFolder(
  workspaceId: string,
  prefix: string,
  name: string,
) {
  return request<AssetFolder>(`/api/workspaces/${workspaceId}/folders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prefix, name }),
  });
}

export function deleteFolder(workspaceId: string, prefix: string) {
  const query = new URLSearchParams({ prefix });
  return request<void>(`/api/workspaces/${workspaceId}/folders?${query}`, {
    method: "DELETE",
  });
}

export function listAssets(workspaceId: string, prefix = "", search = "") {
  const query = new URLSearchParams({ prefix });
  // A search is workspace-wide, so it starts from the root and returns no folders.
  if (search) query.set("search", search);
  return request<{ folders: AssetFolder[]; assets: AssetSummary[] }>(
    `/api/workspaces/${workspaceId}/assets?${query}`,
  );
}

export type AssetUseSummary = {
  kind: "use";
  id: string;
  key: string;
  displayName: string;
  sourceAssetId: string;
  sourceKey: string;
  sourceDisplayName: string;
  sourceMimeType: string | null;
  sourceWidth: number | null;
  sourceHeight: number | null;
  sourceProcessing: boolean;
  currentVersionId: string | null;
  isPublic: boolean;
  transformation: TransformationInput | null;
  outputMimeType: string;
  revision: number;
  updatedAt: string;
  availabilityError: string | null;
  previewUrl: string | null;
};

export type AssetUsePage = { uses: AssetUseSummary[]; nextCursor: string | null };
export function listAssetUses(workspaceId: string, prefix: string, search: string, cursor: string | null,
  sourceAssetId?: string, signal?: AbortSignal) {
  const query = new URLSearchParams({ prefix, search, limit: "50" });
  if (cursor) query.set("cursor", cursor);
  if (sourceAssetId) query.set("sourceAssetId", sourceAssetId);
  return request<AssetUsePage>(`/api/workspaces/${workspaceId}/asset-uses?${query}`, { signal });
}

export function createAssetUse(workspaceId: string, input: {
  key: string; displayName: string; sourceAssetId: string; transformation: TransformationInput | null;
}) {
  return request<{ id: string }>(`/api/workspaces/${workspaceId}/asset-uses`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  });
}

export function updateAssetUse(workspaceId: string, use: AssetUseSummary,
  settings: { displayName: string; transformation: TransformationInput | null }) {
  return request(`/api/workspaces/${workspaceId}/asset-uses/${use.id}`, {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...settings, expectedRevision: use.revision }),
  });
}

export function removeAssetUse(workspaceId: string, use: AssetUseSummary) {
  return request<void>(`/api/workspaces/${workspaceId}/asset-uses/${use.id}?expectedRevision=${use.revision}`, { method: "DELETE" });
}

export type AssetPage = {
  folders: AssetFolder[];
  assets: AssetSummary[];
  nextCursor: string | null;
};

export function listAssetPage(
  workspaceId: string,
  prefix: string,
  search: string,
  cursor: string | null,
  limit = 50,
  signal?: AbortSignal,
  archived = false,
) {
  const query = new URLSearchParams({ pagination: "cursor", prefix, limit: String(limit) });
  if (search.trim()) query.set("search", search.trim());
  if (cursor !== null) query.set("cursor", cursor);
  if (archived) query.set("archived", "true");
  return request<AssetPage>("/api/workspaces/" + workspaceId + "/assets?" + query, { signal });
}

export function setAssetArchived(workspaceId: string, asset: AssetSummary, archived: boolean) {
  return request<{ id: string; archivedAt: string | null }>(`/api/workspaces/${workspaceId}/assets/${asset.id}/archive`, {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ archived, expectedCurrentVersionId: asset.currentVersionId,
      expectedArchivedAt: asset.archivedAt ?? null }),
  });
}

export function listAssetVersions(workspaceId: string, assetId: string) {
  return request<{ currentVersionId: string | null; versions: AssetVersion[] }>(
    `/api/workspaces/${workspaceId}/assets/${assetId}/versions`,
  );
}

export function restoreAssetVersion(
  workspaceId: string,
  assetId: string,
  versionId: string,
) {
  return request<{ currentVersionId: string; number: number }>(
    `/api/workspaces/${workspaceId}/assets/${assetId}/versions/${versionId}/restore`,
    { method: "POST" },
  );
}

export function retryAssetVersion(
  workspaceId: string,
  assetId: string,
  versionId: string,
) {
  return request<{ id: string; status: "processing" }>(
    `/api/workspaces/${workspaceId}/assets/${assetId}/versions/${versionId}/retry`,
    { method: "POST" },
  );
}

export function getAssetDelivery(workspaceId: string, assetId: string) {
  return request<DeliverySummary>(
    `/api/workspaces/${workspaceId}/assets/${assetId}/delivery`,
  );
}

export function importAssets(
  workspaceId: string,
  input: { source: string; prefix: string; token?: string },
) {
  return request<{
    imported: number;
    skipped: number;
    nextToken: string | null;
  }>(`/api/workspaces/${workspaceId}/imports`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function getAsset(workspaceId: string, assetId: string) {
  return request<AssetSummary>(
    `/api/workspaces/${workspaceId}/assets/${assetId}`,
  );
}

export function setAssetVisibility(
  workspaceId: string,
  assetId: string,
  isPublic: boolean,
) {
  return request<{ isPublic: boolean }>(
    `/api/workspaces/${workspaceId}/assets/${assetId}/visibility`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ isPublic }),
    },
  );
}

export function renameAsset(workspaceId: string, assetId: string, displayName: string, expectedDisplayName: string) {
  return request<{ id: string; displayName: string }>(
    `/api/workspaces/${workspaceId}/assets/${assetId}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName, expectedDisplayName }),
    },
  );
}

export function deleteAsset(workspaceId: string, assetId: string) {
  return request<void>(`/api/workspaces/${workspaceId}/assets/${assetId}`, {
    method: "DELETE",
  });
}

// Configuration, not data: fetched once and reused for every upload.
let uploadLimits: Promise<UploadLimits> | undefined;
export function getUploadLimits() {
  uploadLimits ??= request<UploadLimits>("/api/upload-limits");
  return uploadLimits;
}

export function formatUploadLimit(bytes: number) {
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

export function createAsset(
  workspaceId: string,
  input: { key: string; displayName: string },
) {
  return request<CreatedAsset>(`/api/workspaces/${workspaceId}/assets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function validateUploadFile(file: File) {
  const declaredType =
    mimeForFilename(file.name) || file.type || "application/octet-stream";
  const limit = uploadLimitFor(await getUploadLimits(), declaredType);
  if (file.size > limit)
    throw new Error(
      `${file.name} is ${formatUploadLimit(file.size)} — the limit for this file type is ${formatUploadLimit(limit)}`,
    );
  return declaredType;
}

export async function uploadVersion(
  workspaceId: string,
  assetId: string,
  file: File,
  onProgress?: (status: string, fraction?: number) => void,
) {
  const declaredType = await validateUploadFile(file);

  onProgress?.("Requesting upload…");
  const version = await request<UploadVersion>(
    `/api/workspaces/${workspaceId}/assets/${assetId}/versions`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: file.name,
        mimeType: declaredType,
        size: file.size,
      }),
    },
  );

  const form = new FormData();
  for (const [key, value] of Object.entries(version.upload.fields))
    form.append(key, value);
  // Wrap the file in a Blob with the declared MIME type so the S3 presigned
  // POST condition ("Content-Type" must match) is satisfied even when the
  // browser's File.type is empty (common for .mp4, .mov, etc.).
  const mimeType =
    version.upload.fields["Content-Type"] ??
    (file.type || "application/octet-stream");
  form.append("file", new Blob([file], { type: mimeType }), file.name);
  onProgress?.("Uploading…", 0);
  // XMLHttpRequest, not fetch: it is the only way to observe upload progress,
  // and a large video upload without a percentage looks stuck.
  await new Promise<void>((resolve, reject) => {
    const requestUrl = validateUploadUrl(version.upload.url);
    const upload = new XMLHttpRequest();
    upload.open(version.upload.method, requestUrl.href);
    upload.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable) return;
      onProgress?.("Uploading…", event.loaded / event.total);
    });
    upload.addEventListener("load", () =>
      upload.status >= 200 && upload.status < 300
        ? resolve()
        : reject(new Error(`Storage upload failed (${upload.status})`)),
    );
    upload.addEventListener("error", () => reject(new Error("Storage upload failed")));
    upload.addEventListener("abort", () => reject(new Error("Storage upload cancelled")));
    upload.send(form);
  });

  onProgress?.("Processing…");
  await request(
    `/api/workspaces/${workspaceId}/assets/${assetId}/versions/${version.id}/finalize`,
    { method: "POST" },
  );
  onProgress?.("Done");
}

export function createTransformationUrl(
  workspaceId: string,
  assetId: string,
  transformation: TransformationInput,
) {
  return request<{ url: string }>(
    `/api/workspaces/${workspaceId}/assets/${assetId}/transform-url`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(transformation),
    },
  );
}

function validateUploadUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Storage returned an invalid upload URL");
  }

  // In production, the S3 presigned URL points to the bucket endpoint, which
  // is a different origin from the app. Allow any HTTPS URL in production.
  if (!import.meta.env.DEV) {
    if (url.protocol !== "https:" && url.protocol !== "http:")
      throw new Error("Storage upload URL must be HTTP(S)");
    return url;
  }

  // In dev, restrict to localhost or configured origins so a crafted URL
  // can't exfiltrate data to an attacker's server.
  const configured = String(import.meta.env.VITE_UPLOAD_ORIGINS ?? "")
    .split(",")
    .filter(Boolean);
  const allowedOrigins = new Set([window.location.origin, ...configured]);
  allowedOrigins.add("http://localhost:9000");
  if (!allowedOrigins.has(url.origin))
    throw new Error("Storage upload origin is not allowed");
  if (url.origin === "http://localhost:9000") {
    return new URL(
      `/storage${url.pathname}${url.search}`,
      window.location.origin,
    );
  }
  return url;
}

async function request<T = unknown>(url: string, options?: RequestInit) {
  const response = await fetch(url, options);
  const body = (await response.json().catch(() => null)) as {
    error?: string;
    message?: string;
    code?: string;
    currentRevision?: string;
  } | null;
  if (!response.ok)
    throw new ApiRequestError(
      body?.message ?? body?.error ?? `Request failed (${response.status})`,
      response.status,
      typeof body?.code === "string" ? body.code : undefined,
      typeof body?.currentRevision === "string" ? body.currentRevision : undefined,
    );
  return body as T;
}
