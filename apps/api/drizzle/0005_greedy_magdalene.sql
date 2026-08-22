CREATE TABLE "delivery_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"asset_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"transformed" boolean NOT NULL,
	"cache_hit" boolean,
	"mime_type" text NOT NULL,
	"bytes" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_event_bytes_check" CHECK ("delivery_event"."bytes" >= 0)
);
--> statement-breakpoint
ALTER TABLE "delivery_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "delivery_event" ADD CONSTRAINT "delivery_event_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_event" ADD CONSTRAINT "delivery_event_asset_fk" FOREIGN KEY ("workspace_id","asset_id") REFERENCES "public"."asset"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_event" ADD CONSTRAINT "delivery_event_version_fk" FOREIGN KEY ("workspace_id","version_id") REFERENCES "public"."asset_version"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "delivery_event_workspace_created_idx" ON "delivery_event" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "delivery_event_created_idx" ON "delivery_event" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "delivery_event_asset_created_idx" ON "delivery_event" USING btree ("asset_id","created_at");--> statement-breakpoint
CREATE POLICY "workspace_isolation" ON "delivery_event" AS PERMISSIVE FOR ALL TO public USING ("delivery_event"."workspace_id" = current_setting('app.workspace_id', true)) WITH CHECK ("delivery_event"."workspace_id" = current_setting('app.workspace_id', true));