CREATE TYPE "public"."auth_provider" AS ENUM('local', 'oidc');--> statement-breakpoint
CREATE TYPE "public"."compose_source" AS ENUM('inline', 'git');--> statement-breakpoint
CREATE TYPE "public"."deploy_strategy" AS ENUM('recreate', 'blue-green');--> statement-breakpoint
CREATE TYPE "public"."deployment_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'rolled_back', 'interrupted');--> statement-breakpoint
CREATE TYPE "public"."deployment_trigger" AS ENUM('user', 'webhook', 'rollback', 'auto_rollback');--> statement-breakpoint
CREATE TYPE "public"."git_provider_type" AS ENUM('gitlab', 'github');--> statement-breakpoint
CREATE TYPE "public"."host_type" AS ENUM('local', 'agent');--> statement-breakpoint
CREATE TYPE "public"."notification_type" AS ENUM('email', 'teams', 'webhook');--> statement-breakpoint
CREATE TYPE "public"."project_type" AS ENUM('compose', 'single');--> statement-breakpoint
CREATE TYPE "public"."registry_type" AS ENUM('gitlab', 'ghcr', 'oci');--> statement-breakpoint
CREATE TYPE "public"."version_mode" AS ENUM('tracking', 'locked');--> statement-breakpoint
CREATE TABLE "app_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"git_provider_id" uuid NOT NULL,
	"repository" text NOT NULL,
	"default_branch" text DEFAULT 'main' NOT NULL,
	"tag_pattern" text DEFAULT '^v\d+\.\d+(\.\d+)?$' NOT NULL,
	"latest_tag_name" text DEFAULT 'latest' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"username" text,
	"action" text NOT NULL,
	"target" text,
	"ip" text,
	"success" boolean NOT NULL,
	"details" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deployment_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"deployment_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"stream" text DEFAULT 'stdout' NOT NULL,
	"line" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deployments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment_id" uuid NOT NULL,
	"trigger" "deployment_trigger" NOT NULL,
	"user_id" uuid,
	"versions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"digests" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"compose_rendered" text,
	"status" "deployment_status" DEFAULT 'queued' NOT NULL,
	"error" text,
	"rollback_of_id" uuid,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "env_variables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"environment_id" uuid,
	"key" text NOT NULL,
	"value_enc" text NOT NULL,
	"secret" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "env_variables_scope_key_unique" UNIQUE NULLS NOT DISTINCT("project_id","environment_id","key")
);
--> statement-breakpoint
CREATE TABLE "environment_networks" (
	"environment_id" uuid NOT NULL,
	"shared_network_id" uuid NOT NULL,
	CONSTRAINT "environment_networks_environment_id_shared_network_id_pk" PRIMARY KEY("environment_id","shared_network_id")
);
--> statement-breakpoint
CREATE TABLE "environment_sources" (
	"environment_id" uuid NOT NULL,
	"app_source_id" uuid NOT NULL,
	"branch" text NOT NULL,
	"ref" text DEFAULT 'latest' NOT NULL,
	"mode" "version_mode" DEFAULT 'tracking' NOT NULL,
	"webhook_token_hash" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "environment_sources_environment_id_app_source_id_pk" PRIMARY KEY("environment_id","app_source_id"),
	CONSTRAINT "environment_sources_webhook_token_hash_unique" UNIQUE("webhook_token_hash")
);
--> statement-breakpoint
CREATE TABLE "environments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"host_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"strategy" "deploy_strategy" DEFAULT 'recreate' NOT NULL,
	"healthcheck_timeout_seconds" integer DEFAULT 120 NOT NULL,
	"webhook_ip_allowlist" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "git_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"type" "git_provider_type" NOT NULL,
	"api_url" text NOT NULL,
	"web_url" text NOT NULL,
	"token_enc" text NOT NULL,
	"ca_certificate" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "git_providers_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "hosts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"type" "host_type" DEFAULT 'local' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hosts_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "notification_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"type" "notification_type" NOT NULL,
	"config_enc" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_channels_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"type" "project_type" DEFAULT 'compose' NOT NULL,
	"compose_source" "compose_source" DEFAULT 'inline' NOT NULL,
	"compose_inline" text,
	"compose_app_source_id" uuid,
	"compose_path" text DEFAULT 'docker-compose.yml',
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "registries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"type" "registry_type" NOT NULL,
	"url" text NOT NULL,
	"username" text,
	"password_enc" text,
	"insecure" boolean DEFAULT false NOT NULL,
	"ca_certificate" text,
	"git_provider_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "registries_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"ip" text,
	"user_agent" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shared_networks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"exposed_by_environment_id" uuid NOT NULL,
	"alias" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shared_networks_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "tracked_services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"app_source_id" uuid NOT NULL,
	"registry_id" uuid NOT NULL,
	"service_name" text NOT NULL,
	"image_repository" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "auth_provider" NOT NULL,
	"subject" text NOT NULL,
	"username" text NOT NULL,
	"display_name" text NOT NULL,
	"email" text,
	"password_hash" text,
	"totp_secret_enc" text,
	"roles" text[] DEFAULT '{}'::text[] NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment_id" uuid,
	"app_source_id" uuid,
	"source" text NOT NULL,
	"ip" text,
	"payload" jsonb,
	"result" text NOT NULL,
	"reason" text,
	"deployment_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app_sources" ADD CONSTRAINT "app_sources_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_sources" ADD CONSTRAINT "app_sources_git_provider_id_git_providers_id_fk" FOREIGN KEY ("git_provider_id") REFERENCES "public"."git_providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_logs" ADD CONSTRAINT "deployment_logs_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "env_variables" ADD CONSTRAINT "env_variables_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "env_variables" ADD CONSTRAINT "env_variables_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_networks" ADD CONSTRAINT "environment_networks_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_networks" ADD CONSTRAINT "environment_networks_shared_network_id_shared_networks_id_fk" FOREIGN KEY ("shared_network_id") REFERENCES "public"."shared_networks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_sources" ADD CONSTRAINT "environment_sources_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_sources" ADD CONSTRAINT "environment_sources_app_source_id_app_sources_id_fk" FOREIGN KEY ("app_source_id") REFERENCES "public"."app_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_host_id_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."hosts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registries" ADD CONSTRAINT "registries_git_provider_id_git_providers_id_fk" FOREIGN KEY ("git_provider_id") REFERENCES "public"."git_providers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_networks" ADD CONSTRAINT "shared_networks_exposed_by_environment_id_environments_id_fk" FOREIGN KEY ("exposed_by_environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracked_services" ADD CONSTRAINT "tracked_services_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracked_services" ADD CONSTRAINT "tracked_services_app_source_id_app_sources_id_fk" FOREIGN KEY ("app_source_id") REFERENCES "public"."app_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracked_services" ADD CONSTRAINT "tracked_services_registry_id_registries_id_fk" FOREIGN KEY ("registry_id") REFERENCES "public"."registries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_app_source_id_app_sources_id_fk" FOREIGN KEY ("app_source_id") REFERENCES "public"."app_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "app_sources_project_name_idx" ON "app_sources" USING btree ("project_id","name");--> statement-breakpoint
CREATE INDEX "audit_logs_at_idx" ON "audit_logs" USING btree ("at");--> statement-breakpoint
CREATE INDEX "deployment_logs_deployment_idx" ON "deployment_logs" USING btree ("deployment_id","id");--> statement-breakpoint
CREATE INDEX "deployments_environment_created_idx" ON "deployments" USING btree ("environment_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "environments_project_slug_idx" ON "environments" USING btree ("project_id","slug");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tracked_services_project_service_idx" ON "tracked_services" USING btree ("project_id","service_name");--> statement-breakpoint
CREATE UNIQUE INDEX "users_provider_subject_idx" ON "users" USING btree ("provider","subject");--> statement-breakpoint
CREATE INDEX "webhook_events_environment_idx" ON "webhook_events" USING btree ("environment_id","created_at");