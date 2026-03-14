ALTER TABLE "schools" DROP CONSTRAINT "schools_domain_unique";--> statement-breakpoint
CREATE INDEX "schools_domain_idx" ON "schools" USING btree ("domain");--> statement-breakpoint
ALTER TABLE "schools" ADD CONSTRAINT "schools_domain_name_unique" UNIQUE("domain","name");