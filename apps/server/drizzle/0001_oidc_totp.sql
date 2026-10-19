ALTER TABLE "sessions" ADD COLUMN "oidc_sid" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "id_token_enc" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_last_step" integer;--> statement-breakpoint
CREATE INDEX "sessions_oidc_sid_idx" ON "sessions" USING btree ("oidc_sid");