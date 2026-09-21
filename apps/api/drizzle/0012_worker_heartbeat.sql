CREATE TABLE "worker_heartbeat" (
	"id" uuid PRIMARY KEY NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "worker_heartbeat_seen_idx" ON "worker_heartbeat" USING btree ("seen_at");