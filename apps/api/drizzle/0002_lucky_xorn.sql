CREATE TABLE "asset_folder" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"prefix" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	CONSTRAINT "asset_folder_prefix_check" CHECK (length("asset_folder"."prefix") between 2 and 255 and "asset_folder"."prefix" ~ '^(?:[a-z0-9][a-z0-9._-]*/)+$')
);
--> statement-breakpoint
ALTER TABLE "asset_folder" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "asset_folder" ADD CONSTRAINT "asset_folder_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "asset_folder_workspace_prefix_uidx" ON "asset_folder" USING btree ("workspace_id","prefix");--> statement-breakpoint
CREATE INDEX "asset_folder_workspace_idx" ON "asset_folder" USING btree ("workspace_id");--> statement-breakpoint
CREATE POLICY "workspace_isolation" ON "asset_folder" AS PERMISSIVE FOR ALL TO public USING ("asset_folder"."workspace_id" = current_setting('app.workspace_id', true)) WITH CHECK ("asset_folder"."workspace_id" = current_setting('app.workspace_id', true));--> statement-breakpoint
ALTER TABLE "asset_folder" FORCE ROW LEVEL SECURITY;