#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  supportedMimeTypes,
  type SyncAsset,
  type VardDefinition,
  type VardEditorDefinition,
  type VardFolderRule,
  type VardManifest,
} from "@vardum/shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ── CLI / env helpers ──────────────────────────────────────────────────────

let VERSION = "0.0.0";
try {
  VERSION = JSON.parse(
    readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "..", "package.json"),
      "utf8",
    ),
  ).version;
} catch {
  // The version is cosmetic; a missing package.json must not stop the server.
}

function parseArgs() {
  const args = process.argv.slice(2);
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--api-key" || arg === "--server") {
      result[arg.slice(2)] = args[++i] ?? "";
    }
  }
  return result;
}

// Answered before anything else needs configuring: a client that cannot even
// start the binary has no way to see an error that only appears after auth.
if (process.argv.slice(2).some((arg) => arg === "--version" || arg === "-v")) {
  console.log(VERSION);
  process.exit(0);
}
if (process.argv.slice(2).some((arg) => arg === "--help" || arg === "-h")) {
  console.log(`Vardum MCP server v${VERSION}

Usage:
  vardum-mcp [--server URL] [--api-key KEY]

Environment:
  VARDUM_SERVER   Vardum instance to talk to (default https://vardum.com)
  VARDUM_API_KEY  workspace API key; create one in Settings // API keys

The server speaks MCP over stdio, so it is started by the client, not by hand.`);
  process.exit(0);
}

// ── HTTP client ────────────────────────────────────────────────────────────

const cli = parseArgs();
const SERVER = cli.server ?? process.env.VARDUM_SERVER ?? "https://vardum.com";
const API_KEY = cli["api-key"] ?? process.env.VARDUM_API_KEY ?? "";

const headers: Record<string, string> = {
  "user-agent": `vardum-mcp/${VERSION}`,
};
if (API_KEY) headers["x-api-key"] = API_KEY;

class VardumHttpError extends Error {
  constructor(
    readonly responseError: string,
    readonly status: number,
    readonly code?: string,
    readonly currentRevision?: string,
  ) {
    super(`${responseError} (${status})`);
  }
}

async function api<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const merged = new Headers(
    init.headers as Record<string, string> | undefined,
  );
  for (const [k, v] of Object.entries(headers)) merged.set(k, v);
  if (init.body && !merged.has("content-type"))
    merged.set("content-type", "application/json");

  const res = await fetch(new URL(path, `${SERVER}/`), {
    ...init,
    headers: merged,
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!res.ok) {
    let msg = text || res.statusText;
    let code: string | undefined;
    let currentRevision: string | undefined;
    try {
      const parsed = JSON.parse(text) as { error?: string; message?: string; code?: unknown; currentRevision?: unknown };
      if (typeof parsed.code === "string") code = parsed.code;
      if (typeof parsed.currentRevision === "string") currentRevision = parsed.currentRevision;
      msg = parsed.message ?? parsed.error ?? msg;
    } catch {
      /* use body text */
    }
    throw new VardumHttpError(msg, res.status, code, currentRevision);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error("Invalid JSON response");
  }
}

const vardRevision = (value: unknown): value is string => typeof value === "string" && /^v1:[a-f0-9]{64}$/.test(value);
const editorUuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);

async function requireVardEditRevision() {
  const capabilities = await api<unknown>("/api/capabilities");
  if (!capabilities || typeof capabilities !== "object" ||
      (capabilities as Record<string, unknown>).vardEditRevision !== 1)
    throw new Error("This server does not support revision-guarded Vard editing (vardEditRevision: 1); upgrade the server before editing Vards");
}

function editorPath(workspaceId: string, vardId: string) {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/vards/${encodeURIComponent(vardId)}/editor`;
}

function validateVardEditor(value: unknown): VardEditorDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid Vard editor definition; upgrade the server and reload before editing");
  const definition = value as Record<string, unknown>;
  if (definition.schema !== 1 || !vardRevision(definition.revision) ||
      typeof definition.id !== "string" || typeof definition.workspaceId !== "string" ||
      typeof definition.name !== "string" || typeof definition.isPublic !== "boolean" ||
      typeof definition.updatedAt !== "string" || !Array.isArray(definition.folderRules) ||
      !Array.isArray(definition.items) || definition.items.some((item: unknown) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return true;
        const mapping = item as Record<string, unknown>;
        return !editorUuid(mapping.id) || !(mapping.pinnedVersionId === null || editorUuid(mapping.pinnedVersionId));
      }))
    throw new Error("Invalid Vard editor definition or missing revision/literal pins; upgrade the server and reload before editing");
  return value as VardEditorDefinition;
}

async function editorResult(action: () => Promise<unknown>) {
  try {
    const data = await action();
    return { content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] };
  } catch (error) {
    if (error instanceof VardumHttpError && error.status === 409 && error.code === "vard_revision_conflict") {
      const data = {
        status: error.status,
        code: error.code,
        error: error.responseError,
        currentRevision: error.currentRevision,
        instruction: "Reload with get_vard, review the current definition, and reapply the intended edit with its revision. Do not retry the stale save.",
      };
      return {
        isError: true,
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
        structuredContent: data,
      };
    }
    throw error;
  }
}

// ── Server ─────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "Vardum",
  version: VERSION,
});

// ── Resources ──────────────────────────────────────────────────────────────

server.resource("constraints", "vardum://constraints", () => ({
  contents: [
    {
      uri: "vardum://constraints",
      text: `# Vardum Constraints

## Slug immutability
Organization and workspace slugs are set at creation time and **cannot be changed**.
Each slug must match \`[a-z0-9][a-z0-9._-]*\`.

## Asset key rules
Every asset has a unique key scoped to a workspace. Rules:
- Must match \`[a-z0-9][a-z0-9._-]*(\\/[a-z0-9][a-z0-9._-]*)*\`
- Max 255 characters
- Only lowercase letters, digits, \`-\`, \`_\`, \`.\` and \`/\`
- The \`/\` separator creates virtual folders

## Upload limits
- Image types: AVIF, GIF, JPEG, PNG, SVG, TIFF, WebP
- Video types: MP4, WebM, MOV, AVI, MPEG
- Max 100 megapixels per image; videos are stored as-is (no transcode)
- Per-upload size ceiling is set by the server, and differs for images and videos (the API rejects anything over it)
- Video assets cannot be resized or transformed into variants (images only)

## Asset visibility
New assets are private. Use set_asset_visibility with publish permission to change visibility.
Public assets expose every ready version and its variants without authentication.
A public Vard does not publish its assets: anonymous manifests require all mapped assets to be public.
Making an asset private cannot revoke previously downloaded or cached copies.

## Folder inclusion
Vards support up to 64 literal recursive sourcePrefix → outputPrefix rules (255 characters each).
Example: brand/ → assets/brand/. Empty prefixes mean root; empty/nonexistent folders are valid.
Only ready current originals are included; pending files wait until ready. Generated outputs are
read-only, unpinned, and untransformed. No globs or excludes. Manual + generated outputs must
not collide (including case/Unicode or file/directory overlaps) and total at most 1000.
get_vard returns editable manual items and folderRules, even if resolution fails. Use
get_vard with resolved=true for a separate live preview; never persist expanded items.
get_vard supplies an opaque revision and literal pinnedVersionId for each manual item.
update_vard, replace_vard_items and delete_vard require the original expectedRevision; a stale
revision returns vard_revision_conflict. Reload and review before reapplying; never retry blindly.
replace_vard_items requires each existing manual UUID or null for a new item. Copy the stored
pinnedVersionId to versionId, including unavailable pins; resolved versionId is not the saved pin.
These editor tools require vardEditRevision: 1; unsupported servers are refused without legacy writes.
update_vard replaces only supplied fields; folderRules: [] removes rules without changing manual items.
A new private folder member makes the whole anonymous public manifest unavailable.
Normal vardum pull intentionally updates membership; --frozen consumes the committed snapshot.
There is no background sync. Choose --delete on the membership-updating pull: without it,
stale files remain but lose tracking, requiring deliberate manual cleanup later.

## Writable outputs
Only Vard items explicitly marked "Writable" in the UI can be pushed to.
Pinned and transformed outputs are always read-only.`,
    },
  ],
}));

server.resource("best-practices", "vardum://best-practices", () => ({
  contents: [
    {
      uri: "vardum://best-practices",
      text: `# Vardum Best Practices

## Prefer variants over multiple assets
Do **not** upload the same image in five sizes (logo.png, logo-small.png, logo@2x.png).
Upload one canonical source (preferably SVG) and use **on-the-fly variants**:

    ?w=800&format=avif&q=85

Variants are cached in S3 after first request — zero storage cost until used,
zero management overhead. The system handles resize, format conversion and
quality natively. Only a new upload should create a distinct asset key.

## SVG handling
SVG uploads are fully supported. When a variant is requested from an SVG source,
sharp rasterises it to **PNG** automatically via librsvg. Guidelines:
- Upload SVG at the ideal source dimensions (variant system only downscales)
- Upscaling an SVG loses quality — resize the SVG before upload if a larger
  physical size is needed
- SVGs without explicit viewBox or width/height can render at unexpected sizes;
  always include \`viewBox\` in the root element

## Folder organisation
Use the \`/\` separator in asset keys to create virtual folders:
    icons/logo.svg, icons/button.svg, marketing/banners/hero.avif

Folders exist only as key prefixes — no need to "create" them.

## Role awareness
- **viewer**: read-only access to everything
- **editor**: full CRUD on assets, Vards, and presets
- **owner**: workspace administration (members, API keys, domain, deletion)

MCP uses a workspace-scoped asset key. Members, invitations, keys, domains and workspace administration require a browser session and are managed in the web app.

## Video assets
MP4, WebM, MOV, AVI and MPEG are accepted. They are stored and delivered as-is —
Vardum does not transcode video, generate thumbnails, or offer video variants.
Use a purpose-built video platform for transcoding/streaming needs. For Vardum,
reference videos by their original key; the \`video\` element plays them directly
with browser support (H.264 MP4 and WebM have the widest coverage).`,
    },
  ],
}));

server.resource("roles", "vardum://roles", () => ({
  contents: [
    {
      uri: "vardum://roles",
      text: `# Vardum Roles

## Viewer
- Read assets, Vards, deliveries
- View workspace settings
- No mutations

## Editor
Everything a viewer can do, plus:
- Create, update, delete assets
- Upload new asset versions
- Create, update, delete Vards
- Manage Vard items and outputs
- Manage presets (transformations)
- Read domain settings

## Owner
Everything an editor can do, plus:
- Manage workspace members (invite, change roles, remove)
- Create and revoke API keys
- Manage workspace settings (name, deletion)
- Manage custom domains
- Full audit log access

## API key scoping
MCP exposes asset and Vard tools only. A read key can list/read; a write key adds
create, update, delete and publish. Keys are restricted to one workspace and do
not grant browser-session administration, even when created by an owner. Self-revocation
(\`vardum logout\`) is available to CLI keys without workspace admin access.`,
    },
  ],
}));

// ── Tools: Assets ───────────────────────────────────────────────────────────

server.tool(
  "list_assets",
  "List one page of ready assets and visibility, optionally filtered by prefix. Pass nextCursor as cursor to continue; null means the end.",
  {
    workspaceId: z.string().describe("Workspace ID"),
    prefix: z
      .string()
      .optional()
      .describe("Prefix filter (e.g. 'icons/' to list only that folder)"),
    cursor: z
      .string()
      .max(255)
      .optional()
      .describe("nextCursor from the previous page"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .describe("Page size, default 100"),
  },
  async ({ workspaceId, prefix = "", cursor, limit = 100 }) => {
    const query = new URLSearchParams({ prefix, limit: String(limit) });
    if (cursor !== undefined) query.set("cursor", cursor);
    const data = await api<{
      workspaceSlug: string;
      assets: SyncAsset[];
      nextCursor: string | null;
    }>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/sync/assets?${query}`,
    );
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  },
);

server.tool(
  "create_asset",
  "Create a private asset record with a key. Use upload_asset_version to attach media, then set_asset_visibility to publish explicitly.",
  {
    workspaceId: z.string().describe("Workspace ID"),
    key: z
      .string()
      .regex(/^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/)
      .max(255)
      .describe("Asset key (use / for folder structure)"),
    displayName: z.string().min(1).describe("Human-readable filename"),
  },
  async ({ workspaceId, key, displayName }) => {
    const data = await api<{
      id: string;
      key: string;
      displayName: string;
      isPublic: boolean;
    }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/assets`, {
      method: "POST",
      body: JSON.stringify({ key, displayName }),
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "set_asset_visibility",
  "Set asset visibility with publish permission. Public exposes every ready version and variant. Private requires workspace read access but cannot revoke downloaded or cached copies. Vard visibility is independent.",
  {
    workspaceId: z.string().min(1).describe("Workspace ID"),
    assetId: z.string().uuid().describe("Asset ID"),
    isPublic: z
      .boolean()
      .describe("True to publish; false to require workspace read access"),
  },
  async ({ workspaceId, assetId, isPublic }) => {
    const data = await api<{ isPublic: boolean }>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/assets/${encodeURIComponent(assetId)}/visibility`,
      { method: "PATCH", body: JSON.stringify({ isPublic }) },
    );
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "delete_asset",
  "Delete an asset and all its versions permanently.",
  {
    workspaceId: z.string().describe("Workspace ID"),
    assetId: z.string().describe("Asset ID to delete"),
  },
  async ({ workspaceId, assetId }) => {
    await api(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/assets/${encodeURIComponent(assetId)}`,
      { method: "DELETE" },
    );
    return { content: [{ type: "text", text: "Asset deleted." }] };
  },
);

server.tool(
  "upload_asset_version",
  "Upload a new image or video version for an existing asset. Provide base64-encoded data. The version gets processed asynchronously by the system.",
  {
    workspaceId: z.string().describe("Workspace ID"),
    assetId: z.string().describe("Asset ID to upload for"),
    filename: z
      .string()
      .min(1)
      .describe("Filename with extension (e.g. 'logo.avif')"),
    mimeType: z
      .string()
      .describe(`Image or video MIME type (${supportedMimeTypes.join(", ")})`),
    base64: z.string().describe("Base64-encoded image binary"),
  },
  async ({ workspaceId, assetId, filename, mimeType, base64 }) => {
    const bytes = Buffer.from(base64, "base64");
    // 1. Obtain a signed upload URL
    const upload = await api<{
      id: string;
      upload: {
        method: "POST" | "PUT";
        url: string;
        fields: Record<string, string>;
      };
    }>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/assets/${encodeURIComponent(assetId)}/versions`,
      {
        method: "POST",
        body: JSON.stringify({ filename, mimeType, size: bytes.byteLength }),
      },
    );
    // 2. POST the file to the signed URL
    const form = new FormData();
    for (const [k, v] of Object.entries(upload.upload.fields))
      form.append(k, v);
    form.append("file", new Blob([bytes], { type: mimeType }), filename);
    // pi-lens-ignore: identifier — server-signed upload URL, not user-controlled
    const stored = await fetch(upload.upload.url, {
      method: upload.upload.method,
      body: form,
    });
    if (!stored.ok) throw new Error(`Storage upload failed (${stored.status})`);
    // 3. Finalize so the processing worker picks it up
    await api(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/assets/${encodeURIComponent(assetId)}/versions/${encodeURIComponent(upload.id)}/finalize`,
      { method: "POST" },
    );
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { versionId: upload.id, status: "processing", assetId },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// ── Tools: Vards ────────────────────────────────────────────────────────────

server.tool(
  "list_vards",
  "List all Vards in a workspace.",
  { workspaceId: z.string().describe("Workspace ID") },
  async ({ workspaceId }) => {
    const data = await api<{
      vards: Array<{
        id: string;
        name: string;
        slug: string;
        isPublic: boolean;
        updatedAt: string;
      }>;
    }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/vards`);
    return {
      content: [{ type: "text", text: JSON.stringify(data.vards, null, 2) }],
    };
  },
);

const folderRulesInput = z
  .array(
    z
      .object({
        sourcePrefix: z
          .string()
          .max(255)
          .describe(
            "Literal recursive source directory, slash-terminated; empty means workspace root",
          ),
        outputPrefix: z
          .string()
          .max(255)
          .describe(
            "Relative destination directory, slash-terminated; empty means project root",
          ),
      })
      .strict(),
  )
  .max(64)
  .describe(
    "Complete folder rule list; [] removes all rules. API validates safe prefixes. Ready current originals only, no globs; 1000 combined outputs maximum.",
  );
type VardMetadata = Pick<
  VardDefinition,
  "id" | "name" | "isPublic" | "updatedAt" | "folderRules"
>;

server.tool(
  "create_vard",
  "Create a Vard with optional recursive folder rules, private by default. Rules generate read-only originals separately from manual items.",
  {
    workspaceId: z.string().describe("Workspace ID"),
    name: z.string().min(1).max(80).describe("Display name"),
    isPublic: z
      .boolean()
      .optional()
      .describe(
        "Public manifest; every resolved asset must also be public for anonymous access",
      ),
    folderRules: folderRulesInput.optional(),
  },
  async ({ workspaceId, name, isPublic, folderRules }) => {
    const body: {
      name: string;
      isPublic?: boolean;
      folderRules?: VardFolderRule[];
    } = { name };
    if (isPublic !== undefined) body.isPublic = isPublic;
    if (folderRules !== undefined) body.folderRules = folderRules;
    const data = await api<VardMetadata>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/vards`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    );
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

const expectedRevisionInput = z
  .string()
  .regex(/^v1:[a-f0-9]{64}$/)
  .describe("Original opaque revision from get_vard; reload and review after a conflict before reapplying the edit");

server.tool(
  "get_vard",
  "Retrieve editable Vard configuration with its revision, manual item IDs and literal pinnedVersionId, even when expansion fails. Requires vardEditRevision: 1. Set resolved=true for a separate live manifest preview without an editing revision; never write resolved items back as manual items.",
  {
    workspaceId: z.string().describe("Workspace ID"),
    vardId: z.string().describe("Vard ID"),
    resolved: z
      .boolean()
      .optional()
      .describe(
        "True: resolve current outputs, which may fail on collisions/limits. Omitted/false: editable definition and revision only.",
      ),
  },
  async ({ workspaceId, vardId, resolved }) => {
    if (resolved) {
      const data = await api<VardManifest>(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/vards/${encodeURIComponent(vardId)}/manifest`,
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
    await requireVardEditRevision();
    const data = validateVardEditor(await api<unknown>(editorPath(workspaceId, vardId)));
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "update_vard",
  "Update supplied metadata or folderRules using the caller's original expectedRevision; returns the full manual-only definition and revision. Omitted fields and manual IDs are preserved; folderRules: [] removes rules. Requires API read+update permission and vardEditRevision: 1. On conflict reload, review and reapply the intended edit; never retry a stale save automatically.",
  {
    workspaceId: z.string().describe("Workspace ID"),
    vardId: z.string().describe("Vard ID"),
    expectedRevision: expectedRevisionInput,
    name: z.string().min(1).max(80).optional().describe("New display name"),
    isPublic: z
      .boolean()
      .optional()
      .describe("Public manifest only; does not publish resolved assets"),
    folderRules: folderRulesInput.optional(),
  },
  async ({ workspaceId, vardId, expectedRevision, name, isPublic, folderRules }) => editorResult(async () => {
    const body: {
      expectedRevision: string;
      name?: string;
      isPublic?: boolean;
      folderRules?: VardFolderRule[];
    } = { expectedRevision };
    if (name !== undefined) body.name = name;
    if (isPublic !== undefined) body.isPublic = isPublic;
    if (folderRules !== undefined) body.folderRules = folderRules;
    await requireVardEditRevision();
    return validateVardEditor(await api<unknown>(editorPath(workspaceId, vardId), {
      method: "PATCH", body: JSON.stringify(body),
    }));
  }),
);

server.tool(
  "delete_vard",
  "Delete a Vard and all output configurations permanently using the caller's original expectedRevision. Requires API delete permission and vardEditRevision: 1. On conflict reload and review before deciding to delete again.",
  {
    workspaceId: z.string().describe("Workspace ID"),
    vardId: z.string().describe("Vard ID"),
    expectedRevision: expectedRevisionInput,
  },
  async ({ workspaceId, vardId, expectedRevision }) => editorResult(async () => {
    await requireVardEditRevision();
    const query = new URLSearchParams({ expectedRevision });
    await api(editorPath(workspaceId, vardId) + `?${query}`, { method: "DELETE" });
    return "Vard deleted.";
  }),
);

server.tool(
  "replace_vard_items",
  "Replace manual items using the caller's original expectedRevision; returns the full definition and revision. Keep existing manual IDs, use null for new IDs, and copy pinnedVersionId to versionId literally, including unavailable pins; never infer a pin from resolved versionId or pass expanded folder outputs. Requires API read+update permission and vardEditRevision: 1. On conflict reload, review and reapply the intended edit; never retry a stale list automatically.",
  {
    workspaceId: z.string().describe("Workspace ID"),
    vardId: z.string().describe("Vard ID"),
    expectedRevision: expectedRevisionInput,
    items: z
      .array(
        z
          .object({
            id: z
              .string()
              .uuid()
              .nullable()
              .describe("Existing manual item UUID to preserve identity, or null to create a new manual item"),
            assetId: z.string().describe("The asset ID to include"),
            outputPath: z
              .string()
              .describe("Relative output path in the project"),
            writable: z
              .boolean()
              .describe("Whether this output can be pushed back"),
            versionId: z
              .string()
              .uuid()
              .nullable()
              .describe(
                "Literal saved pin: copy pinnedVersionId from get_vard, never resolved versionId. Null follows latest. Pinned outputs must not be writable.",
              ),
            transformation: z
              .record(z.unknown())
              .nullable()
              .describe(
                "Optional transformation parameters (w, h, fit, format, q, bg) or null. bg is an opaque #rrggbb background and requires an explicit raster format.",
              ),
          })
          .strict(),
      )
      .describe(
        "Complete manual item list only; folderRules are preserved",
      ),
  },
  async ({ workspaceId, vardId, expectedRevision, items }) => editorResult(async () => {
    await requireVardEditRevision();
    return validateVardEditor(await api<unknown>(editorPath(workspaceId, vardId) + "/items", {
      method: "PUT", body: JSON.stringify({ expectedRevision, items }),
    }));
  }),
);

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  if (!API_KEY) {
    console.error(
      "Vardum MCP server needs an API key. Set VARDUM_API_KEY or pass --api-key.",
    );
    process.exit(1);
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
