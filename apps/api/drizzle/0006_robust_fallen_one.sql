ALTER TABLE "delivery_event" DROP CONSTRAINT "delivery_event_asset_fk";
--> statement-breakpoint
ALTER TABLE "delivery_event" DROP CONSTRAINT "delivery_event_version_fk";
--> statement-breakpoint
ALTER TABLE "delivery_event" ALTER COLUMN "asset_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_event" ALTER COLUMN "version_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_event" ADD CONSTRAINT "delivery_event_asset_id_asset_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."asset"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_event" ADD CONSTRAINT "delivery_event_version_id_asset_version_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."asset_version"("id") ON DELETE set null ON UPDATE no action;