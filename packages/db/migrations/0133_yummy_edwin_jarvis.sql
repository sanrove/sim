CREATE TABLE "tenant_config" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"base_url" text NOT NULL,
	"description" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_config_tenant_id_unique" UNIQUE("tenant_id")
);
--> statement-breakpoint
CREATE INDEX "tenant_config_tenant_id_idx" ON "tenant_config" USING btree ("tenant_id");