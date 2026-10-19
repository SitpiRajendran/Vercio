CREATE TYPE "public"."notification_delivery_status" AS ENUM('pending', 'sending', 'sent', 'failed', 'suppressed');--> statement-breakpoint
CREATE TABLE "notification_channel_projects" (
	"channel_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	CONSTRAINT "notification_channel_projects_channel_id_project_id_pk" PRIMARY KEY("channel_id","project_id")
);
--> statement-breakpoint
CREATE TABLE "notification_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" uuid NOT NULL,
	"event" text NOT NULL,
	"severity" text NOT NULL,
	"title" text NOT NULL,
	"message" jsonb NOT NULL,
	"group_key" text,
	"dedupe_key" text,
	"status" "notification_delivery_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone,
	"merged_into_id" uuid,
	"suppressed_count" integer DEFAULT 0 NOT NULL,
	"error" text,
	"status_code" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "notification_incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"kind" text NOT NULL,
	"environment_id" uuid,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurrences" integer DEFAULT 1 NOT NULL,
	"notified" boolean DEFAULT false NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "notification_channels" ADD COLUMN "groups" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_channels" ADD COLUMN "project_scope" text DEFAULT 'all' NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_channels" ADD COLUMN "environment_slugs" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_channels" ADD COLUMN "last_result" jsonb;--> statement-breakpoint
ALTER TABLE "notification_channels" ADD COLUMN "consecutive_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_channels" ADD COLUMN "failing_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notification_channels" ADD COLUMN "failure_notified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_channel_projects" ADD CONSTRAINT "notification_channel_projects_channel_id_notification_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."notification_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_channel_projects" ADD CONSTRAINT "notification_channel_projects_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_channel_id_notification_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."notification_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_incidents" ADD CONSTRAINT "notification_incidents_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_deliveries_queue_idx" ON "notification_deliveries" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "notification_deliveries_channel_idx" ON "notification_deliveries" USING btree ("channel_id","created_at");--> statement-breakpoint
CREATE INDEX "notification_deliveries_dedupe_idx" ON "notification_deliveries" USING btree ("channel_id","dedupe_key","created_at");--> statement-breakpoint
CREATE INDEX "notification_incidents_key_idx" ON "notification_incidents" USING btree ("key","kind","opened_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_incidents_open_idx" ON "notification_incidents" USING btree ("key","kind") WHERE resolved_at is null;