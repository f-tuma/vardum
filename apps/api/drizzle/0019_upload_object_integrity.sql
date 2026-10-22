CREATE TABLE "asset_upload" (
  "version_id" uuid PRIMARY KEY,
  "workspace_id" text NOT NULL,
  "asset_id" uuid NOT NULL,
  "storage_key" text NOT NULL UNIQUE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "sweep_at" timestamp with time zone,
  "sweep_attempt_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "asset_upload_cleanup_idx" ON "asset_upload" ("workspace_id", "sweep_attempt_at" ASC NULLS FIRST, "version_id");
--> statement-breakpoint
ALTER TABLE "asset_upload" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "workspace_isolation" ON "asset_upload" FOR ALL USING ("workspace_id" = current_setting('app.workspace_id', true)) WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));
--> statement-breakpoint
-- A private inventory must survive asset/workspace cascade. This narrow owner
-- view exposes only aggregated cleanup scheduling, including deleted workspaces.
-- GROUP BY also makes it structurally non-updatable, even if a broad default
-- table grant is accidentally applied before runtime-role provisioning.
CREATE VIEW "asset_upload_cleanup_scope" AS
  SELECT "workspace_id", bool_or("sweep_at" IS NULL) AS "has_unswept",
    min("sweep_at") AS "sweep_at", max("sweep_attempt_at") AS "sweep_attempt_at"
  FROM "asset_upload" GROUP BY "workspace_id";
--> statement-breakpoint
-- Held until the migration transaction commits: no old writer may insert or
-- finish a version between this snapshot and installation of the new guards.
LOCK TABLE "asset_version" IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
INSERT INTO "asset_upload" ("version_id", "workspace_id", "asset_id", "storage_key", "created_at")
  SELECT "id", "workspace_id", "asset_id", "storage_key", "created_at"
  FROM "asset_version" WHERE "status" <> 'ready';
--> statement-breakpoint
CREATE FUNCTION "track_asset_upload"() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  -- Deliberately no ON CONFLICT, including inserts already marked ready: a
  -- deleted UUID cannot revive a prefix that is still subject to cleanup.
  INSERT INTO public.asset_upload (version_id, workspace_id, asset_id, storage_key, created_at)
    VALUES (NEW.id, NEW.workspace_id, NEW.asset_id, NEW.storage_key, NEW.created_at);
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "asset_version_track_upload" AFTER INSERT ON "asset_version"
  FOR EACH ROW EXECUTE FUNCTION "track_asset_upload"();
--> statement-breakpoint
CREATE FUNCTION "guard_published_upload"() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.status = 'ready' AND ROW(NEW.id, NEW.workspace_id, NEW.asset_id,
      NEW.number, NEW.status, NEW.storage_key, NEW.checksum, NEW.size,
      NEW.mime_type, NEW.filename, NEW.width, NEW.height) IS DISTINCT FROM
      ROW(OLD.id, OLD.workspace_id, OLD.asset_id, OLD.number, OLD.status,
      OLD.storage_key, OLD.checksum, OLD.size, OLD.mime_type, OLD.filename, OLD.width, OLD.height) THEN
    RAISE EXCEPTION 'Published original identity and content are immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'ready' AND NEW.status = 'ready' THEN
    IF OLD.status <> 'processing' OR OLD.ingest_attempt_id IS NULL OR NEW.storage_key IS DISTINCT FROM
      ('originals/' || OLD.workspace_id || '/' || OLD.asset_id || '/' || OLD.id || '/sealed/' || OLD.ingest_attempt_id || '/source') THEN
      -- Old workers must fail closed during rolling upgrades, rather than
      -- publish the client-writable key while new code is being deployed.
      RAISE EXCEPTION 'Upload must be sealed by the current ingest attempt' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "asset_version_guard_publication" BEFORE UPDATE ON "asset_version"
  FOR EACH ROW EXECUTE FUNCTION "guard_published_upload"();
