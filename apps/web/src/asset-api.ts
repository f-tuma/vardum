export type AssetFolder = { name: string; prefix: string };

export type AssetSummary = {
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
  updatedAt: string;
};

type CreatedAsset = Pick<AssetSummary, "id" | "key" | "displayName">;
type UploadVersion = {
  id: string;
  upload: { method: "POST"; url: string; fields: Record<string, string> };
};
export type TransformationInput = {
  w?: number;
  h?: number;
  fit?: "cover" | "contain" | "fill" | "inside" | "outside";
  format?: "avif" | "jpeg" | "png" | "webp";
  q?: number;
};
export type WorkspaceMember = {
  id: string;
  userId: string;
  role: "owner" | "editor" | "viewer";
  createdAt: string;
  name: string;
  email: string;
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
  activity: Array<{
    id: string;
    action: string;
    targetType: string;
    targetId: string;
    createdAt: string;
  }>;
};

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

export function listAssets(workspaceId: string, prefix = "") {
  const query = new URLSearchParams({ prefix });
  return request<{ folders: AssetFolder[]; assets: AssetSummary[] }>(
    `/api/workspaces/${workspaceId}/assets?${query}`,
  );
}

export function getAsset(workspaceId: string, assetId: string) {
  return request<AssetSummary>(
    `/api/workspaces/${workspaceId}/assets/${assetId}`,
  );
}

export function deleteAsset(workspaceId: string, assetId: string) {
  return request<void>(`/api/workspaces/${workspaceId}/assets/${assetId}`, {
    method: "DELETE",
  });
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

export async function uploadVersion(
  workspaceId: string,
  assetId: string,
  file: File,
) {
  const version = await request<UploadVersion>(
    `/api/workspaces/${workspaceId}/assets/${assetId}/versions`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: file.name,
        mimeType: file.type || "application/octet-stream",
        size: file.size,
      }),
    },
  );

  const form = new FormData();
  for (const [key, value] of Object.entries(version.upload.fields))
    form.append(key, value);
  form.append("file", file);
  const uploaded = await fetch(validateUploadUrl(version.upload.url), {
    method: version.upload.method,
    body: form,
  });
  if (!uploaded.ok)
    throw new Error(`Storage upload failed (${uploaded.status})`);

  await request(
    `/api/workspaces/${workspaceId}/assets/${assetId}/versions/${version.id}/finalize`,
    { method: "POST" },
  );
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

  const configured = String(import.meta.env.VITE_UPLOAD_ORIGINS ?? "")
    .split(",")
    .filter(Boolean);
  const allowedOrigins = new Set([window.location.origin, ...configured]);
  if (import.meta.env.DEV) allowedOrigins.add("http://localhost:9000");
  if (!allowedOrigins.has(url.origin))
    throw new Error("Storage upload origin is not allowed");
  if (import.meta.env.DEV && url.origin === "http://localhost:9000") {
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
  } | null;
  if (!response.ok)
    throw new Error(body?.error ?? `Request failed (${response.status})`);
  return body as T;
}
