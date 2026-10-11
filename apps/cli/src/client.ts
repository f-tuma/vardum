import { uploadLimitFor } from "@vardum/shared";
import type {
  SyncAsset,
  UploadLimits,
  VardItem,
  VardEditorDefinition,
  VardEditorItemInput,
  VardFolderRule,
  VardManifest,
} from "@vardum/shared";
import { checkUploadSize, validateUploadLimits } from "./upload-file.js";

export type Manifest = VardManifest;
export type ManifestItem = VardItem;
export type { SyncAsset };

export type AssetIdentity = {
  id: string;
  key: string;
  displayName: string;
  latestVersionId?: string | null;
  status?: "pending" | "processing" | "ready" | "failed" | null;
  hasUnfinishedUploads?: boolean;
};

export type VardConfig = {
  schema: 1;
  server: string;
  workspace: string;
  vard: string;
};

type Upload = {
  id: string;
  upload: { method: "POST"; url: string; fields: Record<string, string> };
};

export type FolderVersion = {
  id: string;
  number: number;
  status: "pending" | "processing" | "ready" | "failed";
  checksum: string | null;
  expectedChecksum: string | null;
  filename: string;
  mimeType: string;
  size: number;
  retryable: boolean;
  error: string | null;
  expiresAt: string | null;
  upload?: Upload["upload"];
};

export type FolderVersionIntent = {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  expectedChecksum: string;
  expectedCurrentVersionId: string | null;
};

export type FolderImportFile = {
  assetId: string;
  key: string;
  outputPath: string;
  checksum: string;
  mimeType: string;
  size: number;
};
export type FolderImportPlanFile = FolderImportFile & {
  versionId: string | null;
  libraryAction: "new" | "update" | "skip";
  mappingAction: "add" | "keep";
  mappingId: string | null;
};
export type FolderImportReadyFile = FolderImportFile & { versionId: string };
export type FolderImportResultFile = Pick<FolderImportFile, "assetId" | "key" | "outputPath"> & {
  mappingId: string;
  mappingAction: "added" | "kept";
};

export class VardumHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly currentRevision?: string,
  ) {
    super(`${message} (${status})`);
  }
}

export class VardumClient {
  readonly server: string;

  constructor(
    server: string,
    private readonly apiKey = process.env.VARDUM_API_KEY,
  ) {
    this.server = server.replace(/\/$/, "");
  }

  get authenticated() {
    return Boolean(this.apiKey);
  }

  /** Server-configured ceilings; fetched once and reused for every upload. */
  private limits?: Promise<UploadLimits>;
  uploadLimits() {
    this.limits ??= this.request<unknown>("/api/upload-limits").then(
      validateUploadLimits,
    );
    return this.limits;
  }

  async requireFolderUploadResume(vardImport = false) {
    const capabilities = await this.request<unknown>("/api/capabilities");
    if (!capabilities || typeof capabilities !== "object" ||
        (capabilities as Record<string, unknown>).folderUploadResume !== 1)
      throw new Error("This server does not support resumable folder uploads (folderUploadResume: 1); upgrade the server before pushing this folder");
    if (vardImport && (capabilities as Record<string, unknown>).folderVardImport !== 1)
      throw new Error("This server does not support folder imports into Vards (folderVardImport: 1); upgrade the server before using --output");
  }

  /** Guarded editor calls require this exact capability; no legacy fallback. */
  async requireVardEditRevision() {
    const capabilities = await this.request<unknown>("/api/capabilities");
    if (!capabilities || typeof capabilities !== "object" ||
        (capabilities as Record<string, unknown>).vardEditRevision !== 1)
      throw new Error("This server does not support revision-guarded Vard editing (vardEditRevision: 1); upgrade the server before editing Vards");
  }

  /** Manual mappings and literal saved pins, with an opaque revision for later writes. */
  async vardEditor(workspaceId: string, vardId: string): Promise<VardEditorDefinition> {
    await this.requireVardEditRevision();
    return validateVardEditor(await this.request<unknown>(this.editorPath(workspaceId, vardId)));
  }

  /** The expected revision must be the caller's original editor revision. */
  async updateVardEditor(workspaceId: string, vardId: string, input: {
    expectedRevision: string;
    name?: string;
    isPublic?: boolean;
    folderRules?: VardFolderRule[];
  }): Promise<VardEditorDefinition> {
    validateVardRevision(input.expectedRevision);
    await this.requireVardEditRevision();
    return validateVardEditor(await this.request<unknown>(this.editorPath(workspaceId, vardId), {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
    }));
  }

  /** Preserve existing IDs and use pinnedVersionId as versionId, never the resolved versionId. */
  async replaceVardEditorItems(workspaceId: string, vardId: string, expectedRevision: string,
    items: VardEditorItemInput[]): Promise<VardEditorDefinition> {
    validateVardRevision(expectedRevision);
    if (items.some((item) => !(item.id === null || editorUuid(item.id)) ||
        !(item.versionId === null || editorUuid(item.versionId))))
      throw new Error("Vard editor items require an existing UUID or null id and an explicit UUID or null versionId copied from pinnedVersionId");
    await this.requireVardEditRevision();
    return validateVardEditor(await this.request<unknown>(this.editorPath(workspaceId, vardId) + "/items", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision, items }),
    }));
  }

  async deleteVardEditor(workspaceId: string, vardId: string, expectedRevision: string) {
    validateVardRevision(expectedRevision);
    await this.requireVardEditRevision();
    const query = new URLSearchParams({ expectedRevision });
    await this.request<void>(this.editorPath(workspaceId, vardId) + `?${query}`, { method: "DELETE" });
  }

  private editorPath(workspaceId: string, vardId: string) {
    return `/api/workspaces/${encodeURIComponent(workspaceId)}/vards/${encodeURIComponent(vardId)}/editor`;
  }

  async planFolderImport(config: VardConfig, files: FolderImportFile[]) {
    const result = await this.request<unknown>(this.importPath(config) + "-plan", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ files }),
    });
    return validateFolderImportPlan(result, files);
  }

  async applyFolderImport(config: VardConfig, files: FolderImportReadyFile[]) {
    const result = await this.request<unknown>(this.importPath(config), {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ files }),
    });
    return validateFolderImportResult(result, files);
  }

  private importPath(config: VardConfig) {
    return `/api/workspaces/${encodeURIComponent(config.workspace)}/vards/${encodeURIComponent(config.vard)}/items/import`;
  }

  /** Revokes the key this client is holding. */
  async revokeCliKey(workspaceId: string) {
    await this.request<void>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/cli-keys`,
      { method: "DELETE" },
    );
  }

  manifest(config: VardConfig, requireAuthentication = false) {
    if (this.apiKey || requireAuthentication)
      return this.request<Manifest>(
        `/api/workspaces/${encodeURIComponent(config.workspace)}/vards/${encodeURIComponent(config.vard)}/manifest`,
      );
    return this.request<Manifest>(`/v/${encodeURIComponent(config.vard)}`);
  }

  async syncAssets(workspaceId: string, prefix = "") {
    const assets: SyncAsset[] = [];
    let cursor: string | null = null;
    let workspaceSlug = "";
    do {
      const query = new URLSearchParams({ prefix, limit: "500" });
      if (cursor) query.set("cursor", cursor);
      const page = await this.request<{
        workspaceSlug: string;
        assets: SyncAsset[];
        nextCursor: string | null;
      }>(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/sync/assets?${query}`,
      );
      workspaceSlug = page.workspaceSlug;
      assets.push(...page.assets);
      cursor = page.nextCursor;
    } while (cursor);
    return { workspaceSlug, assets };
  }

  /** Identity lookup includes empty/pending assets, unlike the ready-only sync feed. */
  async assetIdentities(workspaceId: string, prefixes: string[]) {
    const assets: AssetIdentity[] = [];
    for (const prefix of new Set(prefixes)) {
      let cursor: string | null = null;
      do {
        const query = new URLSearchParams({ prefix, pagination: "cursor", limit: "100" });
        if (cursor) query.set("cursor", cursor);
        const page = await this.request<{
          assets: AssetIdentity[];
          nextCursor: string | null;
        }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/assets?${query}`);
        assets.push(...page.assets);
        cursor = page.nextCursor;
      } while (cursor);
    }
    return assets;
  }

  createAsset(workspaceId: string, key: string, displayName: string, id?: string) {
    return this.request<{ id: string; key: string; displayName: string }>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/assets`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key, displayName, ...(id ? { id } : {}) }),
      },
    );
  }

  deleteAsset(workspaceId: string, assetId: string) {
    return this.request<void>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/assets/${encodeURIComponent(assetId)}`,
      { method: "DELETE" },
    );
  }

  async createFolderVersion(workspaceId: string, assetId: string, intent: FolderVersionIntent) {
    checkUploadSize(intent.filename, intent.size, uploadLimitFor(await this.uploadLimits(), intent.mimeType));
    return validateFolderVersion(await this.request<unknown>(this.versionPath(workspaceId, assetId), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(intent),
    }));
  }

  async folderVersion(workspaceId: string, assetId: string, versionId: string) {
    return validateFolderVersion(await this.request<unknown>(this.versionPath(workspaceId, assetId, versionId)));
  }

  finalizeVersion(workspaceId: string, assetId: string, versionId: string) {
    return this.request(this.versionPath(workspaceId, assetId, versionId) + "/finalize", { method: "POST" });
  }

  retryVersion(workspaceId: string, assetId: string, versionId: string) {
    return this.request(this.versionPath(workspaceId, assetId, versionId) + "/retry", { method: "POST" });
  }

  private versionPath(workspaceId: string, assetId: string, versionId?: string) {
    return `/api/workspaces/${encodeURIComponent(workspaceId)}/assets/${encodeURIComponent(assetId)}/versions${versionId ? `/${encodeURIComponent(versionId)}` : ""}`;
  }

  async storeVersion(upload: Upload["upload"], filename: string, mimeType: string, bytes: Uint8Array) {
    checkUploadSize(filename, bytes.byteLength, uploadLimitFor(await this.uploadLimits(), mimeType));
    const form = new FormData();
    for (const [key, value] of Object.entries(upload.fields)) form.append(key, value);
    const body = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(body).set(bytes);
    form.append("file", new Blob([body], { type: mimeType }), filename);
    const stored = await fetch(safeHttpUrl(upload.url), {
      method: upload.method,
      redirect: "error",
      body: form,
    });
    if (!stored.ok) throw new Error(`Storage upload failed (${stored.status})`);
  }

  async uploadVersion(
    workspaceId: string,
    assetId: string,
    filename: string,
    mimeType: string,
    bytes: Uint8Array,
  ) {
    // Keep a final guard for every caller, including those supplying bytes directly.
    const limit = uploadLimitFor(await this.uploadLimits(), mimeType);
    checkUploadSize(filename, bytes.byteLength, limit);
    const upload = await this.request<Upload>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/assets/${encodeURIComponent(assetId)}/versions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ filename, mimeType, size: bytes.byteLength }),
      },
    );
    const form = new FormData();
    for (const [key, value] of Object.entries(upload.upload.fields))
      form.append(key, value);
    const body = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(body).set(bytes);
    form.append("file", new Blob([body], { type: mimeType }), filename);
    const uploadUrl = safeHttpUrl(upload.upload.url);
    const stored = await fetch(uploadUrl, {
      method: upload.upload.method,
      body: form,
    });
    if (!stored.ok) throw new Error(`Storage upload failed (${stored.status})`);
    await this.request(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/assets/${encodeURIComponent(assetId)}/versions/${encodeURIComponent(upload.id)}/finalize`,
      { method: "POST" },
    );
    return upload.id;
  }

  async download(path: string) {
    const downloadUrl = safeDownloadUrl(path, this.server);
    const response = await fetch(downloadUrl, {
      redirect: "error",
      headers: this.headers(),
    });
    if (!response.ok)
      throw new Error(
        `Download failed (${response.status} ${response.statusText})`,
      );
    return new Uint8Array(await response.arrayBuffer());
  }

  private async request<T = unknown>(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    for (const [key, value] of Object.entries(this.headers()))
      headers.set(key, value);
    const response = await fetch(new URL(path, `${this.server}/`), {
      ...init,
      redirect: "error",
      headers,
    });
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    if (!response.ok) {
      let message = text || response.statusText;
      let code: string | undefined;
      let currentRevision: string | undefined;
      try {
        const parsed = JSON.parse(text) as { error?: string; message?: string; code?: unknown; currentRevision?: unknown };
        if (typeof parsed.code === "string") code = parsed.code;
        if (typeof parsed.currentRevision === "string") currentRevision = parsed.currentRevision;
        if (parsed.message) message = parsed.message;
        else if (parsed.error) message = parsed.error;
      } catch {
        // Keep the response body.
      }
      throw new VardumHttpError(message, response.status, code, currentRevision);
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error("Vardum returned an invalid JSON response");
    }
  }

  private headers(): Record<string, string> {
    return this.apiKey ? { "x-api-key": this.apiKey } : {};
  }
}

const editorUuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const editorRevision = (value: unknown): value is string => typeof value === "string" && /^v1:[a-f0-9]{64}$/.test(value);

function validateVardRevision(value: unknown): asserts value is string {
  if (!editorRevision(value))
    throw new Error("A valid original expectedRevision is required; reload the Vard editor before saving");
}

function validateVardEditor(value: unknown): VardEditorDefinition {
  const invalid = () => new Error("Vardum returned an invalid Vard editor definition; upgrade the server and reload before editing");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const definition = value as Record<string, unknown>;
  if (definition.schema !== 1 || !editorRevision(definition.revision) ||
      typeof definition.id !== "string" || typeof definition.workspaceId !== "string" ||
      typeof definition.name !== "string" || typeof definition.isPublic !== "boolean" ||
      typeof definition.updatedAt !== "string" || !Array.isArray(definition.folderRules) ||
      !Array.isArray(definition.items) || definition.items.some((item: unknown) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return true;
        const mapping = item as Record<string, unknown>;
        return !editorUuid(mapping.id) || !(mapping.pinnedVersionId === null || editorUuid(mapping.pinnedVersionId));
      })) throw invalid();
  return value as VardEditorDefinition;
}

function safeHttpUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Upload URL is invalid");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("Upload URL must be HTTP(S) without embedded credentials");
  return url;
}

function validateFolderVersion(value: unknown): FolderVersion {
  const invalid = () => new Error("Vardum returned an invalid resumable upload version response");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const version = value as Record<string, unknown>;
  const hash = (input: unknown) => input === null || typeof input === "string" && /^[a-f0-9]{64}$/.test(input);
  if (typeof version.id !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(version.id) ||
      !Number.isSafeInteger(version.number) || (version.number as number) < 1 ||
      !["pending", "processing", "ready", "failed"].includes(version.status as string) ||
      !hash(version.checksum) || !hash(version.expectedChecksum) ||
      typeof version.filename !== "string" || !version.filename ||
      typeof version.mimeType !== "string" || !version.mimeType ||
      !Number.isSafeInteger(version.size) || (version.size as number) <= 0 ||
      typeof version.retryable !== "boolean" ||
      !(version.error === null || typeof version.error === "string") ||
      !(version.expiresAt === null || typeof version.expiresAt === "string" && Number.isFinite(Date.parse(version.expiresAt))))
    throw invalid();
  if (version.upload !== undefined) {
    const upload = version.upload as Record<string, unknown> | null;
    if (version.status !== "pending" || !upload || upload.method !== "POST" ||
        typeof upload.url !== "string" || !upload.fields || typeof upload.fields !== "object" ||
        Array.isArray(upload.fields) || Object.values(upload.fields).some((field) => typeof field !== "string"))
      throw invalid();
    safeHttpUrl(upload.url);
  }
  return value as FolderVersion;
}

const importRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const importUuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const mappingId = (value: unknown): value is string => typeof value === "string" && Boolean(value.trim()) && !/[\x00-\x1f\x7f]/.test(value);

function importResponseFiles(value: unknown, request: FolderImportFile[], kind: string) {
  const invalid = () => new Error(`Vardum returned an invalid folder import ${kind} response`);
  if (!importRecord(value) || !Array.isArray(value.files) || value.files.length !== request.length) throw invalid();
  const wanted = new Map(request.map((file) => [file.key, file]));
  const found = new Map<string, Record<string, unknown>>();
  for (const file of value.files) {
    if (!importRecord(file) || typeof file.key !== "string" || found.has(file.key)) throw invalid();
    const original = wanted.get(file.key);
    if (!original || !importUuid(file.assetId) || file.assetId !== original.assetId || file.outputPath !== original.outputPath) throw invalid();
    found.set(file.key, file);
  }
  return { value, files: request.map((file) => found.get(file.key)!), invalid };
}

function validateFolderImportPlan(value: unknown, request: FolderImportFile[]): FolderImportPlanFile[] {
  const { files, invalid } = importResponseFiles(value, request, "plan");
  for (const [index, file] of files.entries()) {
    const original = request[index]!;
    if (file.checksum !== original.checksum || file.mimeType !== original.mimeType || file.size !== original.size ||
        !(file.versionId === null || importUuid(file.versionId)) ||
        !["new", "update", "skip"].includes(file.libraryAction as string) ||
        !["add", "keep"].includes(file.mappingAction as string) ||
        !(file.mappingAction === "add" ? file.mappingId === null : mappingId(file.mappingId)) ||
        file.libraryAction === "new" && file.versionId !== null ||
        file.libraryAction === "skip" && !importUuid(file.versionId)) throw invalid();
  }
  return files as FolderImportPlanFile[];
}

function validateFolderImportResult(value: unknown, request: FolderImportReadyFile[]) {
  const { value: response, files, invalid } = importResponseFiles(value, request, "apply");
  if (files.some((file) => !mappingId(file.mappingId) || !["added", "kept"].includes(file.mappingAction as string)) ||
      !Number.isSafeInteger(response.added) || !Number.isSafeInteger(response.kept) ||
      response.added !== files.filter((file) => file.mappingAction === "added").length ||
      response.kept !== files.filter((file) => file.mappingAction === "kept").length) throw invalid();
  return { files: files as FolderImportResultFile[], added: response.added as number, kept: response.kept as number };
}

/** Delivery is same-origin only; never send workspace keys to supplied hosts. */
export function safeDownloadUrl(value: string, server: string) {
  const url = new URL(value, `${server}/`);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.origin !== new URL(server).origin ||
    url.hash ||
    /[\\\x00-\x20\x7f]/.test(value)
  )
    throw new Error(
      "Download URL must be same-origin HTTP(S), without credentials or fragments",
    );
  return url;
}
