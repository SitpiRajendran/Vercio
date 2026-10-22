CREATE TABLE "totp_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"secret_enc" text NOT NULL,
	"last_step" integer,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "totp_devices" ADD CONSTRAINT "totp_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "totp_devices_user_idx" ON "totp_devices" USING btree ("user_id");--> statement-breakpoint
INSERT INTO "totp_devices" ("user_id", "name", "secret_enc", "last_step")
SELECT "id", 'Application d’authentification', "totp_secret_enc", "totp_last_step" FROM "users" WHERE "totp_secret_enc" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "totp_secret_enc";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "totp_last_step";