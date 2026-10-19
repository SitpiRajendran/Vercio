CREATE TABLE "app_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "environment_sources" ADD COLUMN "webhook_token_enc" text;--> statement-breakpoint
ALTER TABLE "environment_sources" ADD COLUMN "webhook_secret_enc" text;