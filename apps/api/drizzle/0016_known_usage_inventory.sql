CREATE TABLE "known_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"destinations" jsonb NOT NULL,
	"bindings" jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	CONSTRAINT "known_usage_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "known_usage_revision_check" CHECK ("known_usage"."revision" > 0),
	CONSTRAINT "known_usage_kind_check" CHECK ("known_usage"."kind" in ('first_party', 'selected_external')),
	CONSTRAINT "known_usage_bounds_check" CHECK (length("known_usage"."name") between 1 and 120 and jsonb_array_length("known_usage"."destinations") between 1 and 20 and jsonb_array_length("known_usage"."bindings") <= 100)
);
--> statement-breakpoint
ALTER TABLE "known_usage" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "known_usage_check" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"consumer_id" uuid NOT NULL,
	"binding_id" uuid NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text NOT NULL,
	"source" jsonb NOT NULL,
	"scope" jsonb NOT NULL,
	"commit_ref" text,
	"release_ref" text,
	"note" text
);
--> statement-breakpoint
ALTER TABLE "known_usage_check" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "known_usage" ADD CONSTRAINT "known_usage_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "known_usage_check" ADD CONSTRAINT "known_usage_check_consumer_fk" FOREIGN KEY ("workspace_id","consumer_id") REFERENCES "public"."known_usage"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "known_usage_workspace_page_idx" ON "known_usage" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE INDEX "known_usage_check_latest_idx" ON "known_usage_check" USING btree ("workspace_id","consumer_id","binding_id","recorded_at","id");--> statement-breakpoint
CREATE INDEX "known_usage_check_page_idx" ON "known_usage_check" USING btree ("workspace_id","consumer_id","binding_id","id");--> statement-breakpoint
CREATE POLICY "workspace_isolation" ON "known_usage" AS PERMISSIVE FOR ALL TO public USING ("known_usage"."workspace_id" = current_setting('app.workspace_id', true)) WITH CHECK ("known_usage"."workspace_id" = current_setting('app.workspace_id', true));--> statement-breakpoint
CREATE POLICY "workspace_isolation" ON "known_usage_check" AS PERMISSIVE FOR ALL TO public USING ("known_usage_check"."workspace_id" = current_setting('app.workspace_id', true)) WITH CHECK ("known_usage_check"."workspace_id" = current_setting('app.workspace_id', true));
--> statement-breakpoint
ALTER TABLE "known_usage" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "known_usage_check" FORCE ROW LEVEL SECURITY;
