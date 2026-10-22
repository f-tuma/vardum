-- Existing definitions remain format 1. Capability is an exact, cooperating
-- binary declaration and must only ever be set transaction-locally by runtime.
ALTER TABLE "vard" ADD COLUMN "definition_schema" smallint DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "vard_item" ADD COLUMN "definition_schema" smallint DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "vard_item" ADD COLUMN "asset_use_id" uuid;
--> statement-breakpoint
ALTER TABLE "vard" ADD CONSTRAINT "vard_definition_schema_check" CHECK ("definition_schema" IN (1, 2));
--> statement-breakpoint
ALTER TABLE "vard_item" ADD CONSTRAINT "vard_item_definition_schema_check" CHECK ("definition_schema" IN (1, 2));
--> statement-breakpoint
ALTER TABLE "vard" ADD CONSTRAINT "vard_workspace_id_definition_unique" UNIQUE ("workspace_id", "id", "definition_schema");
--> statement-breakpoint
ALTER TABLE "asset_use" ADD CONSTRAINT "asset_use_workspace_id_source_unique" UNIQUE ("workspace_id", "id", "source_asset_id");
--> statement-breakpoint
-- This replaces, rather than duplicates, the parent's cascading reference.
ALTER TABLE "vard_item" DROP CONSTRAINT "vard_item_vard_fk";
--> statement-breakpoint
ALTER TABLE "vard_item" ADD CONSTRAINT "vard_item_vard_fk"
  FOREIGN KEY ("workspace_id", "vard_id", "definition_schema")
  REFERENCES "public"."vard" ("workspace_id", "id", "definition_schema")
  ON UPDATE CASCADE ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "vard_item" ADD CONSTRAINT "vard_item_use_fk"
  FOREIGN KEY ("workspace_id", "asset_use_id", "asset_id")
  REFERENCES "public"."asset_use" ("workspace_id", "id", "source_asset_id")
  ON UPDATE NO ACTION ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "vard_item_parent_definition_idx" ON "vard_item" ("workspace_id", "vard_id", "definition_schema");
--> statement-breakpoint
CREATE INDEX "vard_item_use_idx" ON "vard_item" ("workspace_id", "asset_use_id", "asset_id");
--> statement-breakpoint
ALTER TABLE "vard_item" ADD CONSTRAINT "vard_item_use_binding_check" CHECK (
  "asset_use_id" IS NULL OR ("definition_schema" = 2 AND "version_id" IS NULL
    AND "transformation" IS NULL AND "writable" = false)
);
--> statement-breakpoint
-- Row-local format validation only: no table lookup in a CHECK. The strict API
-- still owns the full folder-rule DSL and admission of future folder use opt-in.
CREATE FUNCTION public.vard_folder_rules_fit_definition(rules jsonb, marker smallint)
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
SET search_path = pg_catalog AS $$
  SELECT CASE WHEN jsonb_typeof(rules) = 'array' THEN NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(rules) AS r(rule)
    WHERE jsonb_typeof(rule) <> 'object'
      OR (rule ? 'includeUses' AND (
        jsonb_typeof(rule -> 'includeUses') IS DISTINCT FROM 'boolean'
        OR (marker = 1 AND rule -> 'includeUses' IS DISTINCT FROM 'false'::jsonb)
      ))
  ) ELSE false END;
$$;
--> statement-breakpoint
ALTER TABLE "vard" ADD CONSTRAINT "vard_folder_rules_definition_check"
  CHECK (public.vard_folder_rules_fit_definition("folder_rules", "definition_schema"));
--> statement-breakpoint
CREATE POLICY "vard_definition_capability" ON "vard" AS RESTRICTIVE FOR ALL TO public
  USING ("definition_schema" = 1 OR COALESCE(current_setting('vardum.vard_definition_schema', true), '') = '2')
  WITH CHECK ("definition_schema" = 1 OR COALESCE(current_setting('vardum.vard_definition_schema', true), '') = '2');
--> statement-breakpoint
CREATE POLICY "vard_definition_capability" ON "vard_item" AS RESTRICTIVE FOR ALL TO public
  USING ("definition_schema" = 1 OR COALESCE(current_setting('vardum.vard_definition_schema', true), '') = '2')
  WITH CHECK ("definition_schema" = 1 OR COALESCE(current_setting('vardum.vard_definition_schema', true), '') = '2');
--> statement-breakpoint
ALTER TABLE "vard" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "vard_item" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Referential actions bypass row policies, including under their owner context.
-- OLD/NEW row-local checks also protect destructive cascades after a parent has
-- disappeared. Never exempt owners, nested triggers or an absent tenant GUC.
CREATE FUNCTION public.guard_vard_definition_capability() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE needs_capability boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    needs_capability := NEW.definition_schema = 2;
  ELSIF TG_OP = 'DELETE' THEN
    needs_capability := OLD.definition_schema = 2;
  ELSE
    needs_capability := OLD.definition_schema = 2 OR NEW.definition_schema = 2;
  END IF;
  IF needs_capability AND current_setting('vardum.vard_definition_schema', true) IS DISTINCT FROM '2' THEN
    RAISE EXCEPTION 'Vard definition requires schema 2 capability'
      USING ERRCODE = '23514', CONSTRAINT = 'vard_definition_capability_guard';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "vard_definition_capability_guard" BEFORE INSERT OR UPDATE OR DELETE ON "vard"
  FOR EACH ROW EXECUTE FUNCTION public.guard_vard_definition_capability();
--> statement-breakpoint
CREATE TRIGGER "vard_item_definition_capability_guard" BEFORE INSERT OR UPDATE OR DELETE ON "vard_item"
  FOR EACH ROW EXECUTE FUNCTION public.guard_vard_definition_capability();
