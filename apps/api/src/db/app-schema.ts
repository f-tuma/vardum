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

export const workspace = pgTable(
  "workspace",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
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
  (table) => [index("workspace_organization_idx").on(table.organizationId)],
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
    width: integer("width"),
    height: integer("height"),
    error: text("error"),
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
    check("asset_version_number_check", sql`${table.number} > 0`),
    check("asset_version_size_check", sql`${table.size} > 0`),
    tenantPolicy(table.workspaceId),
  ],
).enableRLS();

export type VardTransformation = {
  w?: number;
  h?: number;
  fit?: "cover" | "contain" | "fill" | "inside" | "outside";
  format?: "avif" | "jpeg" | "png" | "webp";
  q?: number;
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
