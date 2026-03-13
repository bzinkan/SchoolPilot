CREATE TABLE "student_attendance" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" text NOT NULL,
	"student_id" text NOT NULL,
	"date" text NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"notes" text,
	"marked_by" text NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dismissal_overrides" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" text NOT NULL,
	"student_id" text NOT NULL,
	"original_type" text NOT NULL,
	"override_type" text NOT NULL,
	"reason" text,
	"changed_by" text NOT NULL,
	"changed_by_role" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "dismissal_overrides_session_student_unique" UNIQUE("session_id","student_id")
);
--> statement-breakpoint
CREATE TABLE "homeroom_teachers" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"homeroom_id" text NOT NULL,
	"teacher_id" text NOT NULL,
	"role" text DEFAULT 'primary' NOT NULL,
	"assigned_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "homeroom_teachers_unique" UNIQUE("homeroom_id","teacher_id")
);
--> statement-breakpoint
CREATE TABLE "daily_usage" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" text NOT NULL,
	"student_id" text NOT NULL,
	"date" text NOT NULL,
	"total_seconds" integer DEFAULT 0 NOT NULL,
	"heartbeat_count" integer DEFAULT 0 NOT NULL,
	"top_domains" jsonb,
	"first_seen" timestamp,
	"last_seen" timestamp,
	"computed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "group_teachers" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" text NOT NULL,
	"teacher_id" text NOT NULL,
	"role" text DEFAULT 'primary' NOT NULL,
	"assigned_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "group_teachers_unique" UNIQUE("group_id","teacher_id")
);
--> statement-breakpoint
ALTER TABLE "school_memberships" ADD COLUMN "gopilot_role" text;--> statement-breakpoint
ALTER TABLE "schools" ADD COLUMN "tax_exempt_status" text;--> statement-breakpoint
ALTER TABLE "schools" ADD COLUMN "tax_exempt_cert_url" text;--> statement-breakpoint
ALTER TABLE "schools" ADD COLUMN "tax_exempt_cert_requested_at" timestamp;--> statement-breakpoint
ALTER TABLE "schools" ADD COLUMN "tax_exempt_cert_uploaded_at" timestamp;--> statement-breakpoint
ALTER TABLE "students" ADD COLUMN "afterschool_reason" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "auto_block_unsafe_urls" boolean DEFAULT true;--> statement-breakpoint
ALTER TABLE "trial_requests" ADD COLUMN "school_start_time" text;--> statement-breakpoint
ALTER TABLE "trial_requests" ADD COLUMN "school_end_time" text;--> statement-breakpoint
CREATE UNIQUE INDEX "student_attendance_student_date_unique" ON "student_attendance" USING btree ("student_id","date");--> statement-breakpoint
CREATE INDEX "student_attendance_school_date_idx" ON "student_attendance" USING btree ("school_id","date");--> statement-breakpoint
CREATE INDEX "student_attendance_student_id_idx" ON "student_attendance" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "student_attendance_school_id_idx" ON "student_attendance" USING btree ("school_id");--> statement-breakpoint
CREATE INDEX "dismissal_overrides_session_id_idx" ON "dismissal_overrides" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "dismissal_overrides_student_id_idx" ON "dismissal_overrides" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "homeroom_teachers_homeroom_id_idx" ON "homeroom_teachers" USING btree ("homeroom_id");--> statement-breakpoint
CREATE INDEX "homeroom_teachers_teacher_id_idx" ON "homeroom_teachers" USING btree ("teacher_id");--> statement-breakpoint
CREATE INDEX "daily_usage_school_date_idx" ON "daily_usage" USING btree ("school_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "daily_usage_student_date_unique" ON "daily_usage" USING btree ("student_id","date");--> statement-breakpoint
CREATE INDEX "daily_usage_school_student_date_idx" ON "daily_usage" USING btree ("school_id","student_id","date");--> statement-breakpoint
CREATE INDEX "group_teachers_group_id_idx" ON "group_teachers" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "group_teachers_teacher_id_idx" ON "group_teachers" USING btree ("teacher_id");