CREATE TABLE "asset_use" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"source_asset_id" uuid NOT NULL,
	"key" text NOT NULL,
	"display_name" text NOT NULL,
	"transformation" jsonb,
	"output_mime_type" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	CONSTRAINT "asset_use_revision_check" CHECK ("asset_use"."revision" > 0),
	CONSTRAINT "asset_use_key_check" CHECK (length("asset_use"."key") between 1 and 255 and "asset_use"."key" ~ '^[a-z0-9][a-z0-9._-]*(/[a-z0-9][a-z0-9._-]*)*$'),
	CONSTRAINT "asset_use_name_check" CHECK (length("asset_use"."display_name") between 1 and 255)
);
--> statement-breakpoint
ALTER TABLE "asset_use" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "asset_use" ADD CONSTRAINT "asset_use_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_use" ADD CONSTRAINT "asset_use_source_fk" FOREIGN KEY ("workspace_id","source_asset_id") REFERENCES "public"."asset"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "asset_use_workspace_key_uidx" ON "asset_use" USING btree ("workspace_id","key");--> statement-breakpoint
CREATE INDEX "asset_use_source_idx" ON "asset_use" USING btree ("workspace_id","source_asset_id","key");--> statement-breakpoint
CREATE POLICY "workspace_isolation" ON "asset_use" AS PERMISSIVE FOR ALL TO public USING ("asset_use"."workspace_id" = current_setting('app.workspace_id', true)) WITH CHECK ("asset_use"."workspace_id" = current_setting('app.workspace_id', true));--> statement-breakpoint
ALTER TABLE "asset_use" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Same transaction guard as API content mutations. Keep legacy source paths
-- intact; new linked paths must be disjoint from every file/folder namespace.
CREATE FUNCTION public.guard_asset_use_namespace() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE conflict boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(74122, hashtext(NEW.workspace_id));
  IF TG_TABLE_NAME = 'asset_use' THEN
    IF TG_OP = 'UPDATE' AND (NEW.id, NEW.workspace_id, NEW.key, NEW.source_asset_id)
      IS DISTINCT FROM (OLD.id, OLD.workspace_id, OLD.key, OLD.source_asset_id) THEN
      RAISE EXCEPTION 'Linked use identity and path are immutable' USING ERRCODE = '23514';
    END IF;
    SELECT EXISTS (
      SELECT 1 FROM public.asset a WHERE a.workspace_id = NEW.workspace_id AND
        (a.key = NEW.key OR starts_with(a.key, NEW.key || '/') OR starts_with(NEW.key, a.key || '/'))
      UNION ALL
      SELECT 1 FROM public.asset_use u WHERE u.workspace_id = NEW.workspace_id AND u.id <> NEW.id AND
        (u.key = NEW.key OR starts_with(u.key, NEW.key || '/') OR starts_with(NEW.key, u.key || '/'))
      UNION ALL
      SELECT 1 FROM public.asset_folder f WHERE f.workspace_id = NEW.workspace_id AND starts_with(f.prefix, NEW.key || '/')
    ) INTO conflict;
  ELSIF TG_TABLE_NAME = 'asset' THEN
    SELECT EXISTS (SELECT 1 FROM public.asset_use u WHERE u.workspace_id = NEW.workspace_id AND
      (u.key = NEW.key OR starts_with(u.key, NEW.key || '/') OR starts_with(NEW.key, u.key || '/')))
      INTO conflict;
  ELSE
    SELECT EXISTS (SELECT 1 FROM public.asset_use u WHERE u.workspace_id = NEW.workspace_id
      AND starts_with(NEW.prefix, u.key || '/')) INTO conflict;
  END IF;
  IF conflict THEN
    RAISE EXCEPTION 'Path conflicts with an existing library item or folder' USING ERRCODE = '23505', CONSTRAINT = 'asset_use_namespace';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER asset_use_namespace_guard BEFORE INSERT OR UPDATE ON public.asset_use FOR EACH ROW EXECUTE FUNCTION public.guard_asset_use_namespace();
--> statement-breakpoint
CREATE TRIGGER asset_namespace_guard BEFORE INSERT OR UPDATE OF key ON public.asset FOR EACH ROW EXECUTE FUNCTION public.guard_asset_use_namespace();
--> statement-breakpoint
CREATE TRIGGER asset_folder_namespace_guard BEFORE INSERT OR UPDATE OF prefix ON public.asset_folder FOR EACH ROW EXECUTE FUNCTION public.guard_asset_use_namespace();
