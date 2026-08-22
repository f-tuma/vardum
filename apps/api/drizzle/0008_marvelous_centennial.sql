CREATE TABLE "vard" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"is_public" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	CONSTRAINT "vard_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "vard_name_length_check" CHECK (length("vard"."name") between 1 and 80)
);
--> statement-breakpoint
ALTER TABLE "vard" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "vard_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"vard_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"version_id" uuid,
	"output_path" text NOT NULL,
	"transformation" jsonb,
	"writable" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	CONSTRAINT "vard_item_output_path_check" CHECK (length("vard_item"."output_path") between 1 and 500 and "vard_item"."output_path" !~ '(^/|\\|(^|/)\.\.?(/|$))'),
	CONSTRAINT "vard_item_writable_check" CHECK (not ("vard_item"."writable" and ("vard_item"."version_id" is not null or "vard_item"."transformation" is not null)))
);
--> statement-breakpoint
ALTER TABLE "vard_item" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "vard" ADD CONSTRAINT "vard_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vard_item" ADD CONSTRAINT "vard_item_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vard_item" ADD CONSTRAINT "vard_item_vard_fk" FOREIGN KEY ("workspace_id","vard_id") REFERENCES "public"."vard"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vard_item" ADD CONSTRAINT "vard_item_asset_fk" FOREIGN KEY ("workspace_id","asset_id") REFERENCES "public"."asset"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vard_item" ADD CONSTRAINT "vard_item_version_fk" FOREIGN KEY ("workspace_id","version_id") REFERENCES "public"."asset_version"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "vard_workspace_name_uidx" ON "vard" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE INDEX "vard_workspace_idx" ON "vard" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vard_item_output_uidx" ON "vard_item" USING btree ("vard_id","output_path");--> statement-breakpoint
CREATE INDEX "vard_item_workspace_idx" ON "vard_item" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "vard_item_vard_idx" ON "vard_item" USING btree ("vard_id");--> statement-breakpoint
CREATE POLICY "workspace_isolation" ON "vard" AS PERMISSIVE FOR ALL TO public USING ("vard"."workspace_id" = current_setting('app.workspace_id', true)) WITH CHECK ("vard"."workspace_id" = current_setting('app.workspace_id', true));--> statement-breakpoint
CREATE POLICY "public_vard_lookup" ON "vard" AS PERMISSIVE FOR SELECT TO public USING ("vard"."is_public" = true);--> statement-breakpoint
CREATE POLICY "workspace_isolation" ON "vard_item" AS PERMISSIVE FOR ALL TO public USING ("vard_item"."workspace_id" = current_setting('app.workspace_id', true)) WITH CHECK ("vard_item"."workspace_id" = current_setting('app.workspace_id', true));