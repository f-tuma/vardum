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

/** Literal recursive inclusion of ready current originals; empty prefixes mean root. */
export type VardFolderRule = {
 sourcePrefix: string;
 outputPrefix: string;
};

/** Editable configuration: items are manual mappings only, never expanded outputs. */
export type VardDefinition = VardManifest & {
 folderRules: VardFolderRule[];
};

export type SyncAsset = {
 id: string;
 key: string;
 displayName: string;
 isPublic: boolean;
 versionId: string;
 checksum: string | null;
 mimeType: string;
 size: number;
 width: number | null;
 height: number | null;
 updatedAt: string;
};
