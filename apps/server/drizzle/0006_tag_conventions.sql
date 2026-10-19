CREATE TYPE "public"."version_source" AS ENUM('git_tags', 'commits');--> statement-breakpoint
ALTER TABLE "app_sources" ADD COLUMN "latest_tag_template" text;--> statement-breakpoint
ALTER TABLE "app_sources" ADD COLUMN "version_source" "version_source" DEFAULT 'git_tags' NOT NULL;--> statement-breakpoint
ALTER TABLE "app_sources" ADD COLUMN "commit_tag_template" text DEFAULT '{sha:8}' NOT NULL;