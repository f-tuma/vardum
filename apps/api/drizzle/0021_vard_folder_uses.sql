-- Stored marker 3 protects folder-use definitions from an A-only binary.
-- Wire/editor protocol and frozen-lock schema remain 2.
ALTER TABLE "vard" DROP CONSTRAINT "vard_definition_schema_check";
--> statement-breakpoint
ALTER TABLE "vard" ADD CONSTRAINT "vard_definition_schema_check" CHECK ("definition_schema" IN (1, 2, 3));
--> statement-breakpoint
ALTER TABLE "vard_item" DROP CONSTRAINT "vard_item_definition_schema_check";
--> statement-breakpoint
ALTER TABLE "vard_item" ADD CONSTRAINT "vard_item_definition_schema_check" CHECK ("definition_schema" IN (1, 2, 3));
--> statement-breakpoint
ALTER TABLE "vard_item" DROP CONSTRAINT "vard_item_use_binding_check";
--> statement-breakpoint
ALTER TABLE "vard_item" ADD CONSTRAINT "vard_item_use_binding_check" CHECK (
  "asset_use_id" IS NULL OR ("definition_schema" IN (2, 3) AND "version_id" IS NULL
    AND "transformation" IS NULL AND "writable" = false)
);
--> statement-breakpoint
ALTER POLICY "vard_definition_capability" ON "vard"
  USING ("definition_schema" = 1
    OR ("definition_schema" = 2 AND COALESCE(current_setting('vardum.vard_definition_schema', true), '') IN ('2', '3'))
    OR ("definition_schema" = 3 AND COALESCE(current_setting('vardum.vard_definition_schema', true), '') = '3'))
  WITH CHECK ("definition_schema" = 1
    OR ("definition_schema" = 2 AND COALESCE(current_setting('vardum.vard_definition_schema', true), '') IN ('2', '3'))
    OR ("definition_schema" = 3 AND COALESCE(current_setting('vardum.vard_definition_schema', true), '') = '3'));
--> statement-breakpoint
ALTER POLICY "vard_definition_capability" ON "vard_item"
  USING ("definition_schema" = 1
    OR ("definition_schema" = 2 AND COALESCE(current_setting('vardum.vard_definition_schema', true), '') IN ('2', '3'))
    OR ("definition_schema" = 3 AND COALESCE(current_setting('vardum.vard_definition_schema', true), '') = '3'))
  WITH CHECK ("definition_schema" = 1
    OR ("definition_schema" = 2 AND COALESCE(current_setting('vardum.vard_definition_schema', true), '') IN ('2', '3'))
    OR ("definition_schema" = 3 AND COALESCE(current_setting('vardum.vard_definition_schema', true), '') = '3'));
--> statement-breakpoint
-- Replace the exact-2 guard BEFORE declaring local3: the old function rejects
-- any OLD2 row under capability3. Cascades must inspect both OLD and NEW even
-- after their parent disappears, with no owner or trigger-depth exception.
CREATE OR REPLACE FUNCTION public.guard_vard_definition_capability() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  old_marker smallint := 0;
  new_marker smallint := 0;
  capability text := COALESCE(current_setting('vardum.vard_definition_schema', true), '');
BEGIN
  IF TG_OP <> 'INSERT' THEN old_marker := OLD.definition_schema; END IF;
  IF TG_OP <> 'DELETE' THEN new_marker := NEW.definition_schema; END IF;
  IF (old_marker = 3 OR new_marker = 3) AND capability IS DISTINCT FROM '3' THEN
    RAISE EXCEPTION 'Vard definition requires schema 3 capability'
      USING ERRCODE = '23514', CONSTRAINT = 'vard_definition_capability_guard';
  ELSIF (old_marker = 2 OR new_marker = 2)
      AND capability IS DISTINCT FROM '2' AND capability IS DISTINCT FROM '3' THEN
    RAISE EXCEPTION 'Vard definition requires schema 2 or 3 capability'
      USING ERRCODE = '23514', CONSTRAINT = 'vard_definition_capability_guard';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
SELECT set_config('vardum.vard_definition_schema', '3', true);
--> statement-breakpoint
-- PostgreSQL does not revalidate old rows when a CHECK's function changes.
ALTER TABLE "vard" DROP CONSTRAINT "vard_folder_rules_definition_check";
--> statement-breakpoint
-- A HTTP cannot create true rules, but historical/raw marker2 rows may exist.
-- The existing composite FK cascades the marker to every manual child; this
-- SQL intentionally leaves literal data and created/updated timestamps intact.
UPDATE "vard" SET "definition_schema" = 3
WHERE "definition_schema" = 2 AND EXISTS (
  SELECT 1 FROM jsonb_array_elements("folder_rules") AS r(rule)
  WHERE rule -> 'includeUses' = 'true'::jsonb
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.vard_folder_rules_fit_definition(rules jsonb, marker smallint)
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
SET search_path = pg_catalog AS $$
  SELECT CASE WHEN jsonb_typeof(rules) = 'array' THEN NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(rules) AS r(rule)
    WHERE jsonb_typeof(rule) <> 'object'
      OR (rule ? 'includeUses' AND (
        jsonb_typeof(rule -> 'includeUses') IS DISTINCT FROM 'boolean'
        OR (marker <> 3 AND rule -> 'includeUses' IS DISTINCT FROM 'false'::jsonb)
      ))
  ) ELSE false END;
$$;
--> statement-breakpoint
ALTER TABLE "vard" ADD CONSTRAINT "vard_folder_rules_definition_check"
  CHECK (public.vard_folder_rules_fit_definition("folder_rules", "definition_schema")) NOT VALID;
--> statement-breakpoint
ALTER TABLE "vard" VALIDATE CONSTRAINT "vard_folder_rules_definition_check";
