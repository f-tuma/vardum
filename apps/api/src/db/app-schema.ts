import type {
  Destination,
  StoredBinding,
  Source,
  EvidenceScope,
} from "../known-usage-model.js";
import type { Transformation } from "../transformation.js";
import type { VardFolderRule } from "@vardum/shared";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { organization } from "./auth-schema.js";

export const assetVersionStatus = pgEnum("asset_version_status", [
  "pending",
  "processing",
  "ready",
  "failed",
]);
export const auditActorType = pgEnum("audit_actor_type", [
  "user",
  "api_key",
  "system",
]);

const tenantPolicy = (column: AnyPgColumn) =>
  pgPolicy("workspace_isolation", {
    for: "all",
    using: sql`${column} = current_setting('app.workspace_id', true)`,
    withCheck: sql`${column} = current_setting('app.workspace_id', true)`,
  });

// Global operational liveness only; no tenant identifiers or job payloads.
export const workerHeartbeat = pgTable(
  "worker_heartbeat",
  {
    id: uuid("id").primaryKey(),
    seenAt: timestamp("seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("worker_heartbeat_seen_idx").on(table.seenAt)],
);

export const workspace = pgTable(
  "workspace",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    uploadCleanupAt: timestamp("upload_cleanup_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdBy: text("created_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    updatedBy: text("updated_by").notNull(),
  },
  (table) => [
    index("workspace_organization_idx").on(table.organizationId),
    index("workspace_upload_cleanup_idx").on(
      table.uploadCleanupAt.asc().nullsFirst(),
      table.id,
    ),
  ],
);

export const workspaceSettings = pgTable(
  "workspace_settings",
  {
    workspaceId: text("workspace_id")
      .primaryKey()
      .references(() => workspace.id, { onDelete: "cascade" }),
    customDomain: text("custom_domain").unique(),
    customDomainVerificationToken: text("custom_domain_verification_token"),
    customDomainVerifiedAt: timestamp("custom_domain_verified_at", {
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdBy: text("created_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    updatedBy: text("updated_by").notNull(),
  },
  (table) => [
    tenantPolicy(table.workspaceId),
    pgPolicy("verified_custom_domain_lookup", {
      for: "select",
      using: sql`${table.customDomainVerifiedAt} is not null`,
    }),
  ],
).enableRLS();

export const vard = pgTable(
  "vard",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    isPublic: boolean("is_public").default(false).notNull(),
    folderRules: jsonb("folder_rules")
      .$type<VardFolderRule[]>()
      .default([])
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdBy: text("created_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    updatedBy: text("updated_by").notNull(),
  },
  (table) => [
    uniqueIndex("vard_workspace_name_uidx").on(table.workspaceId, table.name),
    unique("vard_workspace_id_unique").on(table.workspaceId, table.id),
    index("vard_workspace_idx").on(table.workspaceId),
    check(
      "vard_name_length_check",
      sql`length(${table.name}) between 1 and 80`,
    ),
    tenantPolicy(table.workspaceId),
    pgPolicy("public_vard_lookup", {
      for: "select",
      using: sql`${table.isPublic} = true`,
    }),
  ],
).enableRLS();

export const assetFolder = pgTable(
  "asset_folder",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    prefix: text("prefix").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdBy: text("created_by").notNull(),
  },
  (table) => [
    uniqueIndex("asset_folder_workspace_prefix_uidx").on(
      table.workspaceId,
      table.prefix,
    ),
    index("asset_folder_workspace_idx").on(table.workspaceId),
    check(
      "asset_folder_prefix_check",
      sql`length(${table.prefix}) between 2 and 255 and ${table.prefix} ~ '^(?:[a-z0-9][a-z0-9._-]*/)+$'`,
    ),
    tenantPolicy(table.workspaceId),
  ],
).enableRLS();

export const asset = pgTable(
  "asset",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    displayName: text("display_name").notNull(),
    isPublic: boolean("is_public").default(false).notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    currentVersionId: uuid("current_version_id").references(
      (): AnyPgColumn => assetVersion.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdBy: text("created_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    updatedBy: text("updated_by").notNull(),
  },
  (table) => [
    uniqueIndex("asset_workspace_key_uidx").on(table.workspaceId, table.key),
    unique("asset_workspace_id_unique").on(table.workspaceId, table.id),
    index("asset_workspace_idx").on(table.workspaceId),
    check(
      "asset_key_length_check",
      sql`length(${table.key}) between 1 and 255`,
    ),
    tenantPolicy(table.workspaceId),
  ],
).enableRLS();

// A library use owns only placement/settings. Bytes, history and visibility
// belong to its direct source, enforced within the same tenant by the FK.
export const assetUse = pgTable(
  "asset_use",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspace.id, { onDelete: "cascade" }),
    sourceAssetId: uuid("source_asset_id").notNull(),
    key: text("key").notNull(),
    displayName: text("display_name").notNull(),
    transformation: jsonb("transformation").$type<Transformation | null>(),
    outputMimeType: text("output_mime_type").notNull(),
    revision: integer("revision").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: text("created_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
    updatedBy: text("updated_by").notNull(),
  },
  (table) => [
    uniqueIndex("asset_use_workspace_key_uidx").on(table.workspaceId, table.key),
    index("asset_use_source_idx").on(table.workspaceId, table.sourceAssetId, table.key),
    foreignKey({ name: "asset_use_source_fk", columns: [table.workspaceId, table.sourceAssetId], foreignColumns: [asset.workspaceId, asset.id] }),
    check("asset_use_revision_check", sql`${table.revision} > 0`),
    check("asset_use_key_check", sql`length(${table.key}) between 1 and 255 and ${table.key} ~ '^[a-z0-9][a-z0-9._-]*(/[a-z0-9][a-z0-9._-]*)*$'`),
    check("asset_use_name_check", sql`length(${table.displayName}) between 1 and 255`),
    tenantPolicy(table.workspaceId),
  ],
).enableRLS();

export const assetVersion = pgTable(
  "asset_version",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    assetId: uuid("asset_id").notNull(),
    number: integer("number").notNull(),
    status: assetVersionStatus("status").default("pending").notNull(),
    storageKey: text("storage_key").notNull().unique(),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    checksum: text("checksum"),
    expectedChecksum: text("expected_checksum"),
    width: integer("width"),
    height: integer("height"),
    error: text("error"),
    ingestJobId: uuid("ingest_job_id"),
    ingestAttemptId: uuid("ingest_attempt_id"),
    retryable: boolean("retryable").default(false).notNull(),
    uploadExpiredAt: timestamp("upload_expired_at", { withTimezone: true }),
    uploadCleanedAt: timestamp("upload_cleaned_at", { withTimezone: true }),
    uploadSweepAt: timestamp("upload_sweep_at", { withTimezone: true }),
    uploadCleanupAttemptAt: timestamp("upload_cleanup_attempt_at", {
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdBy: text("created_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    updatedBy: text("updated_by").notNull(),
  },
  (table) => [
    uniqueIndex("asset_version_number_uidx").on(table.assetId, table.number),
    unique("asset_version_workspace_id_unique").on(table.workspaceId, table.id),
    foreignKey({
      name: "asset_version_asset_fk",
      columns: [table.workspaceId, table.assetId],
      foreignColumns: [asset.workspaceId, asset.id],
    }).onDelete("cascade"),
    index("asset_version_workspace_idx").on(table.workspaceId),
    index("asset_version_asset_idx").on(table.assetId),
    index("asset_version_processing_idx")
      .on(table.workspaceId, table.id)
      .where(sql`${table.status} = 'processing'`),
    index("asset_version_pending_idx")
      .on(table.workspaceId, table.createdAt)
      .where(sql`${table.status} = 'pending'`),
    index("asset_version_cleanup_idx")
      .on(table.workspaceId, table.uploadSweepAt)
      .where(sql`${table.uploadExpiredAt} IS NOT NULL`),
    index("asset_version_cleanup_attempt_idx")
      .on(
        table.workspaceId,
        table.uploadCleanupAttemptAt.asc().nullsFirst(),
        table.createdAt,
        table.id,
      )
      .where(
        sql`${table.status} = 'pending' OR (${table.status} = 'failed' AND ${table.uploadExpiredAt} IS NOT NULL)`,
      ),
    check("asset_version_number_check", sql`${table.number} > 0`),
    check("asset_version_size_check", sql`${table.size} > 0`),
    check("asset_version_expected_checksum_check", sql`${table.expectedChecksum} IS NULL OR ${table.expectedChecksum} ~ '^[a-f0-9]{64}$'`),
    tenantPolicy(table.workspaceId),
  ],
).enableRLS();

export type VardTransformation = {
  w?: number;
  h?: number;
  fit?: "cover" | "contain" | "fill" | "inside" | "outside";
  format?: "avif" | "jpeg" | "png" | "webp" | "svg";
  q?: number;
  bg?: string;
  pad?: number;
  layer?: string;
  darkLayer?: string;
  darkColor?: string;
  render?: "v2";
};

export const vardItem = pgTable(
  "vard_item",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    vardId: uuid("vard_id").notNull(),
    assetId: uuid("asset_id").notNull(),
    versionId: uuid("version_id"),
    outputPath: text("output_path").notNull(),
    transformation: jsonb("transformation").$type<VardTransformation>(),
    writable: boolean("writable").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdBy: text("created_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    updatedBy: text("updated_by").notNull(),
  },
  (table) => [
    uniqueIndex("vard_item_output_uidx").on(table.vardId, table.outputPath),
    foreignKey({
      name: "vard_item_vard_fk",
      columns: [table.workspaceId, table.vardId],
      foreignColumns: [vard.workspaceId, vard.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "vard_item_asset_fk",
      columns: [table.workspaceId, table.assetId],
      foreignColumns: [asset.workspaceId, asset.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "vard_item_version_fk",
      columns: [table.workspaceId, table.versionId],
      foreignColumns: [assetVersion.workspaceId, assetVersion.id],
    }),
    index("vard_item_workspace_idx").on(table.workspaceId),
    index("vard_item_vard_idx").on(table.vardId),
    check(
      "vard_item_output_path_check",
      sql`length(${table.outputPath}) between 1 and 500 and ${table.outputPath} !~ '(^/|\\\\|(^|/)\\.\\.?(/|$))'`,
    ),
    check(
      "vard_item_writable_check",
      sql`not (${table.writable} and (${table.versionId} is not null or ${table.transformation} is not null))`,
    ),
    tenantPolicy(table.workspaceId),
  ],
).enableRLS();

// Delivery events are successful content responses, not confirmed client downloads.
export const deliveryEvent = pgTable(
  "delivery_event",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    assetId: uuid("asset_id").references(() => asset.id, {
      onDelete: "set null",
    }),
    versionId: uuid("version_id").references(() => assetVersion.id, {
      onDelete: "set null",
    }),
    transformed: boolean("transformed").notNull(),
    cacheHit: boolean("cache_hit"),
    mimeType: text("mime_type").notNull(),
    bytes: bigint("bytes", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("delivery_event_workspace_created_idx").on(
      table.workspaceId,
      table.createdAt,
    ),
    index("delivery_event_created_idx").on(table.createdAt),
    index("delivery_event_asset_created_idx").on(
      table.assetId,
      table.createdAt,
    ),
    check("delivery_event_bytes_check", sql`${table.bytes} >= 0`),
    tenantPolicy(table.workspaceId),
  ],
).enableRLS();

// Audit events are append-only, so updatedAt and updatedBy intentionally do not exist.
export const auditEvent = pgTable(
  "audit_event",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    actorType: auditActorType("actor_type").notNull(),
    actorId: text("actor_id"),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    requestId: text("request_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("audit_event_workspace_created_idx").on(
      table.workspaceId,
      table.createdAt,
    ),
    index("audit_event_target_idx").on(table.targetType, table.targetId),
    tenantPolicy(table.workspaceId),
  ],
).enableRLS();

// Private declared usage inventory. Source identities deliberately have no FK:
// deleting an asset/Vard must preserve recognizable declarations and reports.
export const knownUsage = pgTable(
  "known_usage",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    destinations: jsonb("destinations").$type<Destination[]>().notNull(),
    bindings: jsonb("bindings").$type<StoredBinding[]>().notNull(),
    revision: integer("revision").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdBy: text("created_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    updatedBy: text("updated_by").notNull(),
  },
  (table) => [
    unique("known_usage_workspace_id_unique").on(table.workspaceId, table.id),
    index("known_usage_workspace_page_idx").on(table.workspaceId, table.id),
    check("known_usage_revision_check", sql`${table.revision} > 0`),
    check(
      "known_usage_kind_check",
      sql`${table.kind} in ('first_party', 'selected_external')`,
    ),
    check(
      "known_usage_bounds_check",
      sql`length(${table.name}) between 1 and 120 and jsonb_array_length(${table.destinations}) between 1 and 20 and jsonb_array_length(${table.bindings}) <= 100`,
    ),
    tenantPolicy(table.workspaceId),
  ],
).enableRLS();

// Append-only API and runtime grants; snapshots do not reference mutable sources.
export const knownUsageCheck = pgTable(
  "known_usage_check",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    consumerId: uuid("consumer_id").notNull(),
    bindingId: uuid("binding_id").notNull(),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    actor: text("actor").notNull(),
    source: jsonb("source").$type<Source>().notNull(),
    scope: jsonb("scope").$type<EvidenceScope>().notNull(),
    commitRef: text("commit_ref"),
    releaseRef: text("release_ref"),
    note: text("note"),
  },
  (table) => [
    foreignKey({
      name: "known_usage_check_consumer_fk",
      columns: [table.workspaceId, table.consumerId],
      foreignColumns: [knownUsage.workspaceId, knownUsage.id],
    }).onDelete("cascade"),
    index("known_usage_check_latest_idx").on(
      table.workspaceId,
      table.consumerId,
      table.bindingId,
      table.recordedAt,
      table.id,
    ),
    index("known_usage_check_page_idx").on(
      table.workspaceId,
      table.consumerId,
      table.bindingId,
      table.id,
    ),
    tenantPolicy(table.workspaceId),
  ],
).enableRLS();
