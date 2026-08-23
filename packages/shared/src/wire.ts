/**
 * Shapes the API sends over the wire, shared by every client (dashboard, CLI,
 * MCP). The API validates its own input with zod; these describe the JSON that
 * comes back, after serialization — dates are strings here.
 */
export type Transformation = {
  w?: number;
  h?: number;
  fit?: "cover" | "contain" | "fill" | "inside" | "outside";
  format?: "avif" | "jpeg" | "png" | "webp";
  q?: number;
};

export type VardItem = {
  id: string;
  assetId: string;
  key: string;
  outputPath: string;
  writable: boolean;
  pinned: boolean;
  transformation: Transformation | null;
  versionId: string | null;
  sourceChecksum: string | null;
  mimeType: string | null;
  size: number | null;
  fingerprint: string | null;
  downloadUrl: string | null;
};

export type VardManifest = {
  schema: 1;
  id: string;
  workspaceId: string;
  name: string;
  isPublic: boolean;
  updatedAt: string;
  items: VardItem[];
};

export type SyncAsset = {
  id: string;
  key: string;
  displayName: string;
  versionId: string;
  checksum: string | null;
  mimeType: string;
  size: number;
  width: number | null;
  height: number | null;
  updatedAt: string;
};
