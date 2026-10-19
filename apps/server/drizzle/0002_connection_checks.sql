ALTER TABLE "git_providers" ADD COLUMN "last_check" jsonb;--> statement-breakpoint
ALTER TABLE "registries" ADD COLUMN "last_check" jsonb;