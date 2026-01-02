-- Add organization_id column to api_key table for tenant isolation
ALTER TABLE "api_key" ADD COLUMN "organization_id" text;
--> statement-breakpoint
-- Add foreign key constraint to organization table
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Create index for organization_id and type for faster queries
CREATE INDEX "api_key_org_type_idx" ON "api_key" USING btree ("organization_id","type");
