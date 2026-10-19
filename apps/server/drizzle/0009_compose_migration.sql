ALTER TABLE "environments" ADD COLUMN "migrating_from" text;--> statement-breakpoint
ALTER TABLE "environments" ADD COLUMN "volume_map" jsonb DEFAULT '{}'::jsonb NOT NULL;