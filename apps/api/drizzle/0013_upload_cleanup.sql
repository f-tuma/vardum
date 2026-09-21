ALTER TABLE "asset_version" ADD COLUMN "upload_expired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "asset_version" ADD COLUMN "upload_cleaned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "asset_version" ADD COLUMN "upload_sweep_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "asset_version_pending_idx" ON "asset_version" USING btree ("workspace_id","created_at") WHERE "asset_version"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "asset_version_cleanup_idx" ON "asset_version" USING btree ("workspace_id","upload_sweep_at") WHERE "asset_version"."upload_expired_at" IS NOT NULL;