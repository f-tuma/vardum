#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ── CLI / env helpers ──────────────────────────────────────────────────────

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

// ── HTTP client ────────────────────────────────────────────────────────────

const cli = parseArgs();
const SERVER =
  cli.server ?? process.env.VARDUM_SERVER ?? "https://app.vardum.dev";
const API_KEY =
  cli["api-key"] ?? process.env.VARDUM_API_KEY ?? "";

const headers: Record<string, string> = { "user-agent": "vardum-mcp/0.1.0" };
if (API_KEY) headers["x-api-key"] = API_KEY;

async function api<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const merged = new Headers(init.headers as Record<string, string> | undefined);
  for (const [k, v] of Object.entries(headers)) merged.set(k, v);
  if (init.body && !merged.has("content-type"))
    merged.set("content-type", "application/json");

  const res = await fetch(new URL(path, `${SERVER}/`), { ...init, headers: merged });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!res.ok) {
    let msg = text || res.statusText;
    try {
      const parsed = JSON.parse(text) as { error?: string; message?: string };
      msg = parsed.message ?? parsed.error ?? msg;
    } catch { /* use body text */ }
    throw new Error(`${msg} (${res.status})`);
  }
  try { return JSON.parse(text) as T; } catch { throw new Error("Invalid JSON response"); }
}

// ── Server ─────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "Vardum",
  version: "0.1.0",
});

// ── Resources ──────────────────────────────────────────────────────────────

server.resource("constraints", "vardum://constraints", () => ({
  contents: [{
    uri: "vardum://constraints",
    text: `# Vardum Constraints

## Slug immutability
Organization, workspace and Vard slugs are set at creation time and **cannot be changed**.
Each slug must match \`[a-z0-9][a-z0-9._-]*\`.

## Asset key rules
Every asset has a unique key scoped to a workspace. Rules:
- Must match \`[a-z0-9][a-z0-9._-]*(\\/[a-z0-9][a-z0-9._-]*)*\`
- Max 255 characters
- Only lowercase letters, digits, \`-\`, \`_\`, \`.\` and \`/\`
- The \`/\` separator creates virtual folders

## Upload limits
- Image types: AVIF, GIF, JPEG, PNG, SVG, TIFF, WebP
- Max 100 megapixels per upload
- Storage backend caps at 100 MiB per upload

## Writable outputs
Only Vard items explicitly marked "Writable" in the UI can be pushed to.
Pinned and transformed outputs are always read-only.`,
  }],
}));

server.resource("best-practices", "vardum://best-practices", () => ({
  contents: [{
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

A workspace API key carries the permissions of whoever created it, nothing more.`,
  }],
}));

server.resource("roles", "vardum://roles", () => ({
  contents: [{
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
A workspace API key inherits the permissions of the person who created it.
A key can never grant more access than its creator has. Self-revocation
(\`vardum logout\`) is available to CLI keys without workspace admin access.`,
  }],
}));

// ── Tools: Workspace ────────────────────────────────────────────────────────

server.tool(
  "list_organizations",
  "List all organizations the authenticated user belongs to.",
  {},
  async () => {
    const data = await api<{ organizations: Array<{ id: string; name: string; slug: string; role: string }> }>("/api/organizations");
    return { content: [{ type: "text", text: JSON.stringify(data.organizations, null, 2) }] };
  },
);

server.tool(
  "create_workspace",
  "Create a new workspace inside an organization.",
  {
    organizationId: z.string().describe("Organization ID"),
    name: z.string().min(1).max(64).describe("Display name for the workspace"),
    slug: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/).describe("URL-safe slug (cannot be changed later)"),
  },
  async ({ organizationId, name, slug }) => {
    const data = await api<{ id: string; name: string; slug: string }>(
      `/api/organizations/${encodeURIComponent(organizationId)}/workspaces`,
      { method: "POST", body: JSON.stringify({ name, slug }) },
    );
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "get_workspace",
  "Retrieve workspace details including name, slug, and member count.",
  { workspaceId: z.string().describe("Workspace ID") },
  async ({ workspaceId }) => {
    const [members, overview] = await Promise.all([
      api<{ members: Array<{ id: string; name: string | null; email: string; role: string }> }>(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/members`,
      ),
      api<{ name: string; slug: string; storageUsed: number; assetCount: number }>(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/overview`,
      ),
    ]);
    return {
      content: [{ type: "text", text: JSON.stringify({ ...overview, members: members.members }, null, 2) }],
    };
  },
);

server.tool(
  "update_workspace",
  "Update the display name of a workspace. The slug cannot be changed.",
  {
    workspaceId: z.string().describe("Workspace ID"),
    name: z.string().min(1).max(64).describe("New display name"),
  },
  async ({ workspaceId, name }) => {
    const data = await api<{ id: string; name: string; slug: string }>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}`,
      { method: "PATCH", body: JSON.stringify({ name }) },
    );
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

// ── Tools: Members & Invitations ────────────────────────────────────────────

server.tool(
  "list_members",
  "List all members of a workspace with their roles.",
  { workspaceId: z.string().describe("Workspace ID") },
  async ({ workspaceId }) => {
    const data = await api<{ members: Array<{ id: string; name: string | null; email: string; role: string }> }>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/members`,
    );
    return { content: [{ type: "text", text: JSON.stringify(data.members, null, 2) }] };
  },
);

server.tool(
  "change_member_role",
  "Change a member's role in the workspace.",
  {
    workspaceId: z.string().describe("Workspace ID"),
    memberId: z.string().describe("Member ID"),
    role: z.enum(["owner", "editor", "viewer"]).describe("New role"),
  },
  async ({ workspaceId, memberId, role }) => {
    await api(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(memberId)}`,
      { method: "PATCH", body: JSON.stringify({ role }) },
    );
    return { content: [{ type: "text", text: `Role changed to ${role}.` }] };
  },
);

server.tool(
  "list_invitations",
  "List pending invitations for a workspace.",
  { workspaceId: z.string().describe("Workspace ID") },
  async ({ workspaceId }) => {
    const data = await api<{ invitations: Array<{ id: string; email: string; role: string; expiresAt: string }> }>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/invitations`,
    );
    return { content: [{ type: "text", text: JSON.stringify(data.invitations, null, 2) }] };
  },
);

server.tool(
  "create_invitation",
  "Invite someone by email to join a workspace with a specific role.",
  {
    workspaceId: z.string().describe("Workspace ID"),
    email: z.string().email().describe("Recipient email address"),
    role: z.enum(["editor", "viewer"]).describe("Role to assign (owner cannot be invited directly)"),
  },
  async ({ workspaceId, email, role }) => {
    await api<{ id: string }>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/invitations`,
      { method: "POST", body: JSON.stringify({ email, role }) },
    );
    return { content: [{ type: "text", text: `Invitation sent to ${email} (${role}).` }] };
  },
);

server.tool(
  "revoke_invitation",
  "Revoke a pending invitation before it expires.",
  {
    workspaceId: z.string().describe("Workspace ID"),
    invitationId: z.string().describe("Invitation ID"),
  },
  async ({ workspaceId, invitationId }) => {
    await api(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/invitations/${encodeURIComponent(invitationId)}`,
      { method: "DELETE" },
    );
    return { content: [{ type: "text", text: "Invitation revoked." }] };
  },
);

// ── Tools: API Keys ─────────────────────────────────────────────────────────

server.tool(
  "list_api_keys",
  "List all API keys for a workspace.",
  { workspaceId: z.string().describe("Workspace ID") },
  async ({ workspaceId }) => {
    const data = await api<{ keys: Array<{ id: string; name: string | null; start: string; access: string; createdAt: string }> }>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/api-keys`,
    );
    return { content: [{ type: "text", text: JSON.stringify(data.keys, null, 2) }] };
  },
);

server.tool(
  "create_api_key",
  "Create a new API key for a workspace. The full key is shown only once.",
  {
    workspaceId: z.string().describe("Workspace ID"),
    name: z.string().min(1).max(32).describe("Human-readable label for the key"),
    access: z.enum(["read", "write"]).describe("Access level: read-only or read-write"),
  },
  async ({ workspaceId, name, access }) => {
    const data = await api<{ id: string; name: string; key: string; access: string }>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/api-keys`,
      { method: "POST", body: JSON.stringify({ name, access }) },
    );
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "revoke_api_key",
  "Revoke (delete) an API key by ID.",
  {
    workspaceId: z.string().describe("Workspace ID"),
    keyId: z.string().describe("API key ID to revoke"),
  },
  async ({ workspaceId, keyId }) => {
    await api(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/api-keys/${encodeURIComponent(keyId)}`,
      { method: "DELETE" },
    );
    return { content: [{ type: "text", text: "API key revoked." }] };
  },
);

// ── Tools: Assets ───────────────────────────────────────────────────────────

server.tool(
  "list_assets",
  "List assets in a workspace, optionally filtered by prefix (virtual folder).",
  {
    workspaceId: z.string().describe("Workspace ID"),
    prefix: z.string().optional().describe("Prefix filter (e.g. 'icons/' to list only that folder)"),
  },
  async ({ workspaceId, prefix = "" }) => {
    const data = await api<{ workspaceSlug: string; assets: Array<{ id: string; key: string; displayName: string; versionId: string; checksum: string | null; mimeType: string; size: number }> }>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/sync/assets?prefix=${encodeURIComponent(prefix)}&limit=500`,
    );
    return { content: [{ type: "text", text: JSON.stringify(data.assets, null, 2) }] };
  },
);

server.tool(
  "create_asset",
  "Create a new asset record with a key. Use upload_version to attach image data.",
  {
    workspaceId: z.string().describe("Workspace ID"),
    key: z.string().regex(/^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/).max(255).describe("Asset key (use / for folder structure)"),
    displayName: z.string().min(1).describe("Human-readable filename"),
  },
  async ({ workspaceId, key, displayName }) => {
    const data = await api<{ id: string; key: string; displayName: string }>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/assets`,
      { method: "POST", body: JSON.stringify({ key, displayName }) },
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
  "Upload a new image version for an existing asset. Provide base64-encoded image data. The version gets processed asynchronously by the system.",
  {
    workspaceId: z.string().describe("Workspace ID"),
    assetId: z.string().describe("Asset ID to upload for"),
    filename: z.string().min(1).describe("Filename with extension (e.g. 'logo.avif')"),
    mimeType: z.string().describe("Image MIME type (image/avif, image/jpeg, image/png, image/webp, image/svg+xml)"),
    base64: z.string().describe("Base64-encoded image binary"),
  },
  async ({ workspaceId, assetId, filename, mimeType, base64 }) => {
    const bytes = Buffer.from(base64, "base64");
    // 1. Obtain a signed upload URL
    const upload = await api<{ id: string; upload: { method: "POST" | "PUT"; url: string; fields: Record<string, string> } }>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/assets/${encodeURIComponent(assetId)}/versions`,
      { method: "POST", body: JSON.stringify({ filename, mimeType, size: bytes.byteLength }) },
    );
    // 2. POST the file to the signed URL
    const form = new FormData();
    for (const [k, v] of Object.entries(upload.upload.fields)) form.append(k, v);
    form.append("file", new Blob([bytes], { type: mimeType }), filename);
    // pi-lens-ignore: identifier — server-signed upload URL, not user-controlled
    const stored = await fetch(upload.upload.url, { method: upload.upload.method, body: form });
    if (!stored.ok) throw new Error(`Storage upload failed (${stored.status})`);
    // 3. Finalize so the processing worker picks it up
    await api(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/assets/${encodeURIComponent(assetId)}/versions/${encodeURIComponent(upload.id)}/finalize`,
      { method: "POST" },
    );
    return { content: [{ type: "text", text: JSON.stringify({ versionId: upload.id, status: "processing", assetId }, null, 2) }] };
  },
);

// ── Tools: Vards ────────────────────────────────────────────────────────────

server.tool(
  "list_vards",
  "List all Vards in a workspace.",
  { workspaceId: z.string().describe("Workspace ID") },
  async ({ workspaceId }) => {
    const data = await api<{ vards: Array<{ id: string; name: string; slug: string; isPublic: boolean; updatedAt: string }> }>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/vards`,
    );
    return { content: [{ type: "text", text: JSON.stringify(data.vards, null, 2) }] };
  },
);

server.tool(
  "create_vard",
  "Create a new Vard in a workspace. The slug cannot be changed later.",
  {
    workspaceId: z.string().describe("Workspace ID"),
    name: z.string().min(1).max(128).describe("Display name"),
    slug: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/).describe("URL-safe slug (immutable)"),
    isPublic: z.boolean().optional().describe("Whether the Vard is publicly accessible"),
  },
  async ({ workspaceId, name, slug, isPublic }) => {
    const data = await api<{ id: string; name: string; slug: string; isPublic: boolean }>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/vards`,
      { method: "POST", body: JSON.stringify({ name, slug, isPublic }) },
    );
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "get_vard",
  "Retrieve a Vard and its full manifest (items, outputs, their versions and download URLs).",
  {
    workspaceId: z.string().describe("Workspace ID"),
    vardId: z.string().describe("Vard ID"),
  },
  async ({ workspaceId, vardId }) => {
    const data = await api<{
      id: string;
      name: string;
      isPublic: boolean;
      items: Array<{
        id: string;
        assetId: string;
        key: string;
        outputPath: string;
        writable: boolean;
        pinned: boolean;
        versionId: string | null;
        fingerprint: string | null;
        downloadUrl: string | null;
      }>;
    }>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/vards/${encodeURIComponent(vardId)}`,
    );
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "update_vard",
  "Update a Vard's metadata (name, public flag). The slug is immutable.",
  {
    workspaceId: z.string().describe("Workspace ID"),
    vardId: z.string().describe("Vard ID"),
    name: z.string().min(1).max(128).optional().describe("New display name"),
    isPublic: z.boolean().optional().describe("Public accessibility"),
  },
  async ({ workspaceId, vardId, name, isPublic }) => {
    const body: Record<string, unknown> = {};
    if (name !== undefined) body.name = name;
    if (isPublic !== undefined) body.isPublic = isPublic;
    const data = await api<{ id: string; name: string; isPublic: boolean }>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/vards/${encodeURIComponent(vardId)}`,
      { method: "PATCH", body: JSON.stringify(body) },
    );
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "delete_vard",
  "Delete a Vard and all its output configurations permanently.",
  {
    workspaceId: z.string().describe("Workspace ID"),
    vardId: z.string().describe("Vard ID"),
  },
  async ({ workspaceId, vardId }) => {
    await api(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/vards/${encodeURIComponent(vardId)}`,
      { method: "DELETE" },
    );
    return { content: [{ type: "text", text: "Vard deleted." }] };
  },
);

server.tool(
  "replace_vard_items",
  "Replace every item in a Vard with a new set of item definitions. Each item maps an asset to an output path and optional transformation settings.",
  {
    workspaceId: z.string().describe("Workspace ID"),
    vardId: z.string().describe("Vard ID"),
    items: z.array(z.object({
      assetId: z.string().describe("The asset ID to include"),
      outputPath: z.string().describe("Relative output path in the project"),
      writable: z.boolean().describe("Whether this output can be pushed back"),
      pinned: z.boolean().describe("Whether the version is pinned (read-only)"),
      transformation: z.record(z.unknown()).nullable().describe("Optional transformation parameters (w, h, fit, format, q) or null"),
    })).describe("Complete list of items to set (replaces all current items)"),
  },
  async ({ workspaceId, vardId, items }) => {
    const data = await api<{ id: string; items: Array<{ id: string; assetId: string; outputPath: string }> }>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/vards/${encodeURIComponent(vardId)}/items`,
      { method: "PUT", body: JSON.stringify({ items }) },
    );
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

// ── Domain ─────────────────────────────────────────────────────────────────

server.tool(
  "get_domain",
  "Get the current custom domain configuration for a workspace.",
  { workspaceId: z.string().describe("Workspace ID") },
  async ({ workspaceId }) => {
    const data = await api<{ domain: string | null; verified: boolean }>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/domain`,
    );
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "configure_domain",
  "Configure a custom domain for a workspace. Requires DNS verification (TXT + CNAME).",
  {
    workspaceId: z.string().describe("Workspace ID"),
    domain: z.string().describe("Domain name (e.g. assets.example.com)"),
  },
  async ({ workspaceId, domain }) => {
    const data = await api<{ domain: string; verified: boolean; txtRecord: string; cnameTarget: string }>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/domain`,
      { method: "PUT", body: JSON.stringify({ domain }) },
    );
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "verify_domain",
  "Trigger domain verification. The agent should first read the current domain config to show the required DNS records, then call this once they are in place.",
  { workspaceId: z.string().describe("Workspace ID") },
  async ({ workspaceId }) => {
    const data = await api<{ domain: string; verified: boolean }>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/domain/verify`,
      { method: "POST" },
    );
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  if (!API_KEY) {
    console.error("Vardum MCP server needs an API key. Set VARDUM_API_KEY or pass --api-key.");
    process.exit(1);
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});