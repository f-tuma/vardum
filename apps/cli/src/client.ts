import { uploadLimitFor } from "@vardum/shared";
import type {
  SyncAsset,
  UploadLimits,
  VardItem,
  VardManifest,
} from "@vardum/shared";
import { checkUploadSize, validateUploadLimits } from "./upload-file.js";

export type Manifest = VardManifest;
export type ManifestItem = VardItem;
export type { SyncAsset };

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

  createAsset(workspaceId: string, key: string, displayName: string) {
    return this.request<{ id: string; key: string; displayName: string }>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/assets`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key, displayName }),
      },
    );
  }

  deleteAsset(workspaceId: string, assetId: string) {
    return this.request<void>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/assets/${encodeURIComponent(assetId)}`,
      { method: "DELETE" },
    );
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
      try {
        const parsed = JSON.parse(text) as { error?: string; message?: string };
        if (parsed.message) message = parsed.message;
        else if (parsed.error) message = parsed.error;
      } catch {
        // Keep the response body.
      }
      throw new Error(`${message} (${response.status})`);
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
