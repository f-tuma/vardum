CREATE TABLE "workspace" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	CONSTRAINT "workspace_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "asset" DROP CONSTRAINT "asset_workspace_id_organization_id_fk";
--> statement-breakpoint
ALTER TABLE "asset_folder" DROP CONSTRAINT "asset_folder_workspace_id_organization_id_fk";
--> statement-breakpoint
ALTER TABLE "asset_version" DROP CONSTRAINT "asset_version_workspace_id_organization_id_fk";
--> statement-breakpoint
ALTER TABLE "audit_event" DROP CONSTRAINT "audit_event_workspace_id_organization_id_fk";
--> statement-breakpoint
ALTER TABLE "delivery_event" DROP CONSTRAINT "delivery_event_workspace_id_organization_id_fk";
--> statement-breakpoint
ALTER TABLE "workspace_settings" DROP CONSTRAINT "workspace_settings_workspace_id_organization_id_fk";
--> statement-breakpoint
ALTER TABLE "workspace" ADD CONSTRAINT "workspace_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
INSERT INTO "workspace" ("id", "organization_id", "name", "slug", "created_at", "created_by", "updated_at", "updated_by")
SELECT "id", "id", "name", "slug", "created_at", 'system:migration', "created_at", 'system:migration'
FROM "organization";--> statement-breakpoint
CREATE INDEX "workspace_organization_idx" ON "workspace" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "asset" ADD CONSTRAINT "asset_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_folder" ADD CONSTRAINT "asset_folder_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_version" ADD CONSTRAINT "asset_version_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_event" ADD CONSTRAINT "delivery_event_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_settings" ADD CONSTRAINT "workspace_settings_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;