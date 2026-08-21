CREATE TYPE "public"."asset_version_status" AS ENUM('pending', 'processing', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "public"."audit_actor_type" AS ENUM('user', 'api_key', 'system');--> statement-breakpoint
CREATE TABLE "asset" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"key" text NOT NULL,
	"display_name" text NOT NULL,
	"current_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	CONSTRAINT "asset_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "asset_key_length_check" CHECK (length("asset"."key") between 1 and 255)
);
--> statement-breakpoint
ALTER TABLE "asset" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "asset_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"asset_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"status" "asset_version_status" DEFAULT 'pending' NOT NULL,
	"storage_key" text NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"size" bigint NOT NULL,
	"checksum" text,
	"width" integer,
	"height" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	CONSTRAINT "asset_version_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "asset_version_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "asset_version_number_check" CHECK ("asset_version"."number" > 0),
	CONSTRAINT "asset_version_size_check" CHECK ("asset_version"."size" > 0)
);
--> statement-breakpoint
ALTER TABLE "asset_version" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "audit_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"actor_type" "audit_actor_type" NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"request_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "workspace_settings" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"custom_domain" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	CONSTRAINT "workspace_settings_custom_domain_unique" UNIQUE("custom_domain")
);
--> statement-breakpoint
ALTER TABLE "workspace_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "asset" ADD CONSTRAINT "asset_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset" ADD CONSTRAINT "asset_current_version_id_asset_version_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."asset_version"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_version" ADD CONSTRAINT "asset_version_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_version" ADD CONSTRAINT "asset_version_asset_fk" FOREIGN KEY ("workspace_id","asset_id") REFERENCES "public"."asset"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_settings" ADD CONSTRAINT "workspace_settings_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "asset_workspace_key_uidx" ON "asset" USING btree ("workspace_id","key");--> statement-breakpoint
CREATE INDEX "asset_workspace_idx" ON "asset" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "asset_version_number_uidx" ON "asset_version" USING btree ("asset_id","number");--> statement-breakpoint
CREATE INDEX "asset_version_workspace_idx" ON "asset_version" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "asset_version_asset_idx" ON "asset_version" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "audit_event_workspace_created_idx" ON "audit_event" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_event_target_idx" ON "audit_event" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE POLICY "workspace_isolation" ON "asset" AS PERMISSIVE FOR ALL TO public USING ("asset"."workspace_id" = current_setting('app.workspace_id', true)) WITH CHECK ("asset"."workspace_id" = current_setting('app.workspace_id', true));--> statement-breakpoint
CREATE POLICY "workspace_isolation" ON "asset_version" AS PERMISSIVE FOR ALL TO public USING ("asset_version"."workspace_id" = current_setting('app.workspace_id', true)) WITH CHECK ("asset_version"."workspace_id" = current_setting('app.workspace_id', true));--> statement-breakpoint
CREATE POLICY "workspace_isolation" ON "audit_event" AS PERMISSIVE FOR ALL TO public USING ("audit_event"."workspace_id" = current_setting('app.workspace_id', true)) WITH CHECK ("audit_event"."workspace_id" = current_setting('app.workspace_id', true));--> statement-breakpoint
CREATE POLICY "workspace_isolation" ON "workspace_settings" AS PERMISSIVE FOR ALL TO public USING ("workspace_settings"."workspace_id" = current_setting('app.workspace_id', true)) WITH CHECK ("workspace_settings"."workspace_id" = current_setting('app.workspace_id', true));--> statement-breakpoint
ALTER TABLE "asset" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "asset_version" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_event" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workspace_settings" FORCE ROW LEVEL SECURITY;