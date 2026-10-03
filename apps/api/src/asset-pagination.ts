import { createHmac, timingSafeEqual } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import {
  asset,
  assetFolder,
  assetVersion,
  workspace,
  workspaceSettings,
} from "./db/app-schema.js";

export const maximumAssetCursorLength = 4096;
const cursorDomain = "vardum:asset-browser:cursor:v1\0";
const scopeDomain = "vardum:asset-browser:scope:v1\0";
const orderVersion = "folders-first-c-v1";

export const assetPaginationQuery = {
  pagination: z.literal("cursor").optional(),
  cursor: z.string().min(1).max(maximumAssetCursorLength).optional(),
};

export type AssetPageScope = {
  workspaceId: string;
  prefix: string;
  search?: string;
  limit: number;
};

const positionSchema = z
  .object({
    kindRank: z.union([z.literal(0), z.literal(1)]),
    path: z.string().min(1).max(255),
    stableIdentity: z.string().min(1).max(255),
  })
  .strict();
export type AssetPagePosition = z.infer<typeof positionSchema>;
const payloadSchema = positionSchema
  .extend({
    version: z.literal(1),
    scope: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export function normalizedAssetSearch(search: string | undefined) {
  return search?.trim() || "";
}

export function literalAssetSearch(search: string) {
  return `%${search.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

function scopeSignature(scope: AssetPageScope, secret: string) {
  const search = normalizedAssetSearch(scope.search);
  return createHmac("sha256", secret)
    .update(scopeDomain)
    .update(
      JSON.stringify([
        scope.workspaceId,
        scope.prefix,
        search,
        scope.limit,
        "cursor",
        search ? "search" : "browse",
        orderVersion,
      ]),
    )
    .digest("hex");
}

function cursorSignature(payload: string, secret: string) {
  return createHmac("sha256", secret)
    .update(cursorDomain)
    .update(payload)
    .digest();
}

export function encodeAssetCursor(
  scope: AssetPageScope,
  position: AssetPagePosition,
  secret: string,
) {
  const payload = Buffer.from(
    JSON.stringify({
      version: 1,
      scope: scopeSignature(scope, secret),
      kindRank: position.kindRank,
      path: position.path,
      stableIdentity: position.stableIdentity,
    }),
  ).toString("base64url");
  return `${payload}.${cursorSignature(payload, secret).toString("base64url")}`;
}

export function decodeAssetCursor(
  cursor: string | undefined,
  scope: AssetPageScope,
  secret: string,
): AssetPagePosition | "invalid" | null {
  if (cursor === undefined) return null;
  if (cursor.length > maximumAssetCursorLength) return "invalid";
  const parts = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(cursor);
  if (!parts) return "invalid";
  const payload = parts[1]!;
  const signature = Buffer.from(parts[2]!, "base64url");
  if (
    signature.toString("base64url") !== parts[2] ||
    !timingSafeEqual(cursorSignature(payload, secret), signature)
  )
    return "invalid";
  try {
    const bytes = Buffer.from(payload, "base64url");
    if (bytes.toString("base64url") !== payload) return "invalid";
    const parsed = payloadSchema.safeParse(JSON.parse(bytes.toString("utf8")));
    if (!parsed.success) return "invalid";
    const value = parsed.data;
    if (
      value.scope !== scopeSignature(scope, secret) ||
      !value.path.startsWith(scope.prefix) ||
      (value.kindRank === 0
        ? !value.path.endsWith("/") || value.stableIdentity !== value.path
        : !z.uuid().safeParse(value.stableIdentity).success)
    )
      return "invalid";
    return {
      kindRank: value.kindRank,
      path: value.path,
      stableIdentity: value.stableIdentity,
    };
  } catch {
    return "invalid";
  }
}

export type AssetPageRow = AssetPagePosition & {
  id: string | null;
  key: string | null;
  displayName: string | null;
  isPublic: boolean | null;
  currentVersionId: string | null;
  mimeType: string | null;
  size: number | null;
  width: number | null;
  height: number | null;
  updatedAt: string | null;
  latestVersionId: string | null;
  status: "pending" | "processing" | "ready" | "failed" | null;
  error: string | null;
  slug: string | null;
  customDomain: string | null;
};

/**
 * One statement keeps candidate selection and hydration on the same snapshot.
 * The cursor identifies the last consumed candidate, even if it is a folder.
 * This is a live traversal: later insertions/renames after the tuple can appear;
 * changes before it are not revisited. Folder deduplication precedes LIMIT.
 */
export function assetPageSql(
  scope: AssetPageScope,
  position: AssetPagePosition | null,
): SQL {
  const { workspaceId, prefix, limit } = scope;
  const search = normalizedAssetSearch(scope.search);
  const needle = search ? literalAssetSearch(search) : null;
  const includeFolders = position?.kindRank !== 1;
  const folderCtes = !includeFolders
    ? sql``
    : needle
      ? sql`
    folder_sources AS (
      SELECT substring(key FROM length(${prefix}) + 1) AS remainder FROM scoped_assets
      UNION
      SELECT substring(f.prefix FROM length(${prefix}) + 1)
      FROM ${assetFolder} f
      WHERE f.workspace_id = ${workspaceId}
        AND starts_with(f.prefix, ${prefix}) AND f.prefix <> ${prefix}
    ),
    folders AS (
      SELECT DISTINCT ${prefix} || array_to_string(
        (string_to_array(source.remainder, '/'))[1:depth.value], '/'
      ) || '/' AS path
      FROM folder_sources source
      CROSS JOIN LATERAL generate_series(
        1, length(source.remainder) - length(replace(source.remainder, '/', ''))
      ) depth(value)
    ),
  `
      : sql`
    folders AS (
      SELECT ${prefix} || split_part(substring(key FROM length(${prefix}) + 1), '/', 1) || '/' AS path
      FROM scoped_assets
      WHERE position('/' IN substring(key FROM length(${prefix}) + 1)) > 0
      UNION
      SELECT ${prefix} || split_part(substring(f.prefix FROM length(${prefix}) + 1), '/', 1) || '/'
      FROM ${assetFolder} f
      WHERE f.workspace_id = ${workspaceId}
        AND starts_with(f.prefix, ${prefix}) AND f.prefix <> ${prefix}
    ),
  `;
  const folderCandidates = includeFolders
    ? sql`
    SELECT 0 AS kind_rank, path, path AS stable_identity, NULL::uuid AS asset_id
    FROM folders
    ${needle ? sql`WHERE path ILIKE ${needle} ESCAPE '\\'` : sql``}
    UNION ALL
  `
    : sql``;
  const after = position
    ? sql`
    WHERE (kind_rank, path COLLATE "C", stable_identity COLLATE "C") > (
      ${position.kindRank}, ${position.path} COLLATE "C", ${position.stableIdentity} COLLATE "C"
    )
  `
    : sql``;

  return sql`
    WITH scoped_assets AS NOT MATERIALIZED (
      SELECT id, key, display_name FROM ${asset}
      WHERE workspace_id = ${workspaceId} AND starts_with(key, ${prefix})
    ),
    ${folderCtes}
    candidates AS (
      ${folderCandidates}
      SELECT 1 AS kind_rank, key AS path, id::text AS stable_identity, id AS asset_id
      FROM scoped_assets
      WHERE ${
        needle
          ? sql`(key ILIKE ${needle} ESCAPE '\\' OR display_name ILIKE ${needle} ESCAPE '\\')`
          : sql`position('/' IN substring(key FROM length(${prefix}) + 1)) = 0`
      }
    ),
    candidate_page AS MATERIALIZED (
      SELECT * FROM candidates ${after}
      ORDER BY kind_rank, path COLLATE "C", stable_identity COLLATE "C"
      LIMIT ${limit + 1}
    ),
    consumed_page AS MATERIALIZED (
      SELECT * FROM candidate_page
      ORDER BY kind_rank, path COLLATE "C", stable_identity COLLATE "C"
      LIMIT ${limit}
    ),
    page_assets AS (
      SELECT a.id, a.key, a.display_name, a.is_public, a.current_version_id,
        current.mime_type, current.size::double precision AS size, current.width, current.height,
        a.updated_at, latest.id AS latest_version_id, latest.status, latest.error
      FROM consumed_page p
      JOIN ${asset} a ON p.kind_rank = 1 AND a.id = p.asset_id AND a.workspace_id = ${workspaceId}
      LEFT JOIN ${assetVersion} current
        ON current.id = a.current_version_id AND current.workspace_id = ${workspaceId}
      LEFT JOIN LATERAL (
        SELECT v.id, v.status, v.error FROM ${assetVersion} v
        WHERE v.asset_id = a.id AND v.workspace_id = ${workspaceId}
        ORDER BY v.number DESC LIMIT 1
      ) latest ON true
    ),
    workspace_info AS (
      SELECT w.slug, settings.custom_domain FROM ${workspace} w
      LEFT JOIN ${workspaceSettings} settings
        ON settings.workspace_id = w.id AND settings.custom_domain_verified_at IS NOT NULL
      WHERE w.id = ${workspaceId}
    )
    SELECT p.kind_rank AS "kindRank", p.path, p.stable_identity AS "stableIdentity",
      a.id, a.key, a.display_name AS "displayName", a.is_public AS "isPublic",
      a.current_version_id AS "currentVersionId", a.mime_type AS "mimeType", a.size,
      a.width, a.height, a.updated_at AS "updatedAt",
      a.latest_version_id AS "latestVersionId", a.status, a.error,
      w.slug, w.custom_domain AS "customDomain"
    FROM candidate_page p
    LEFT JOIN page_assets a ON a.id = p.asset_id
    LEFT JOIN workspace_info w ON true
    ORDER BY p.kind_rank, p.path COLLATE "C", p.stable_identity COLLATE "C"
  `;
}
