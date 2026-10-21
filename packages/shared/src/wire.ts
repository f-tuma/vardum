/**
 * Shapes the API sends over the wire, shared by every client (dashboard, CLI,
 * MCP). The API validates its own input with zod; these describe the JSON that
 * comes back, after serialization — dates are strings here.
 */
export type Transformation = {
 w?: number;
 h?: number;
 fit?: "cover" | "contain" | "fill" | "inside" | "outside";
 format?: "avif" | "jpeg" | "png" | "webp" | "svg";
 q?: number;
 /** Opaque output background, normalized to lowercase #rrggbb. Requires format. */
 bg?: string;
 /** Inset on each edge, as a percent (0–45, at most two decimal places) of the shorter final side.
  * Positive padding requires w, h, format and fit: "contain". */
 pad?: number;
 /** Geometric SVG group ID; keeps the original canvas and ancestor transforms. */
 layer?: string;
 /** Filled shapes in this SVG group use darkColor for a dark color scheme. */
 darkLayer?: string;
 /** Lowercase #rrggbb, paired with darkLayer; requires format: "svg". */
 darkColor?: string;
 /** Opt-in SVG-to-raster background renderer; omission retains legacy rendering. */
 render?: "v2";
};

export type VardItem = {
 id: string;
 assetId: string;
 key: string;
 outputPath: string;
 writable: boolean;
 pinned: boolean;
 /** Literal saved pin, supplied by the guarded editor even when the version is unavailable. */
 pinnedVersionId?: string | null;
 transformation: Transformation | null;
 versionId: string | null;
 sourceChecksum: string | null;
 /** Original selected version's type, before any output transformation. */
 sourceMimeType?: string | null;
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
 /** Opaque state-equivalence token supplied by guarded editor endpoints. */
 revision?: string;
};

/** The dedicated editor always supplies its revision and literal pin IDs. */
export type VardEditorDefinition = VardDefinition & {
 revision: string;
 items: (VardItem & { pinnedVersionId: string | null })[];
};

export type VardEditorItemInput = {
 /** Existing manual mapping ID, or null to allocate a new mapping. */
 id: string | null;
 assetId: string;
 versionId: string | null;
 outputPath: string;
 transformation: Transformation | null;
 writable: boolean;
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
