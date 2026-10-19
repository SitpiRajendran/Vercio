ALTER TABLE "environment_networks" ADD COLUMN "services" jsonb;--> statement-breakpoint
ALTER TABLE "environment_networks" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_networks" ADD COLUMN "service" text NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_networks" ADD COLUMN "description" text;