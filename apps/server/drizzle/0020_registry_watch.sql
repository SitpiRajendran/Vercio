ALTER TYPE "public"."deployment_trigger" ADD VALUE 'watch';--> statement-breakpoint
ALTER TABLE "environments" ADD COLUMN "registry_watch_minutes" integer;