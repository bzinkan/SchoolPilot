CREATE TABLE "product_licenses" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" text NOT NULL,
	"product" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"activated_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "product_licenses_school_product_unique" UNIQUE("school_id","product")
);
--> statement-breakpoint
CREATE TABLE "school_memberships" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"school_id" text NOT NULL,
	"role" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"car_number" text,
	"kiosk_name" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "school_memberships_user_school_role_unique" UNIQUE("user_id","school_id","role")
);
--> statement-breakpoint
CREATE TABLE "schools" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"domain" text,
	"slug" text,
	"address" text,
	"phone" text,
	"status" text DEFAULT 'trial' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"plan_tier" text DEFAULT 'trial' NOT NULL,
	"plan_status" text DEFAULT 'active' NOT NULL,
	"active_until" timestamp,
	"trial_ends_at" timestamp,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"billing_email" text,
	"total_paid" integer DEFAULT 0 NOT NULL,
	"last_payment_amount" integer,
	"last_payment_date" timestamp,
	"max_teachers" integer DEFAULT 50,
	"max_licenses" integer DEFAULT 100,
	"used_licenses" integer DEFAULT 0 NOT NULL,
	"kiosk_enabled" boolean DEFAULT true NOT NULL,
	"kiosk_requires_approval" boolean DEFAULT false NOT NULL,
	"default_pass_duration" integer DEFAULT 5 NOT NULL,
	"kiosk_grade_id" varchar,
	"kiosk_activated_by_user_id" varchar,
	"active_grade_levels" text,
	"dismissal_time" text,
	"dismissal_mode" text DEFAULT 'no_app' NOT NULL,
	"max_students" integer,
	"tracking_start_hour" integer DEFAULT 7 NOT NULL,
	"tracking_end_hour" integer DEFAULT 17 NOT NULL,
	"is_24_hour_enabled" boolean DEFAULT false NOT NULL,
	"disabled_at" timestamp,
	"disabled_reason" text,
	"last_activity_at" timestamp,
	"school_timezone" text DEFAULT 'America/New_York' NOT NULL,
	"school_session_version" integer DEFAULT 1 NOT NULL,
	"settings" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	CONSTRAINT "schools_domain_unique" UNIQUE("domain"),
	CONSTRAINT "schools_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password" text,
	"google_id" text,
	"first_name" text DEFAULT '' NOT NULL,
	"last_name" text DEFAULT '' NOT NULL,
	"display_name" text,
	"phone" text,
	"profile_image_url" text,
	"is_super_admin" boolean DEFAULT false NOT NULL,
	"check_in_method" text DEFAULT 'app',
	"notification_prefs" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_login_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_google_id_unique" UNIQUE("google_id")
);
--> statement-breakpoint
CREATE TABLE "students" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" text NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"email" text,
	"email_lc" text,
	"google_user_id" text,
	"photo_url" text,
	"grade_level" text,
	"student_id_number" text,
	"grade_id" text,
	"homeroom_id" text,
	"dismissal_type" text DEFAULT 'car',
	"bus_route" text,
	"student_code" text,
	"external_id" text,
	"device_id" text,
	"student_status" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "grades" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" text NOT NULL,
	"name" text NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "passes" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" text NOT NULL,
	"student_id" text NOT NULL,
	"teacher_id" text,
	"grade_id" text,
	"destination" text NOT NULL,
	"custom_destination" text,
	"status" text DEFAULT 'active' NOT NULL,
	"issued_at" timestamp DEFAULT now() NOT NULL,
	"duration" integer DEFAULT 5 NOT NULL,
	"expires_at" timestamp NOT NULL,
	"returned_at" timestamp,
	"issued_via" text DEFAULT 'teacher' NOT NULL,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "teacher_grades" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"teacher_id" text NOT NULL,
	"grade_id" text NOT NULL,
	"assigned_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "teacher_grades_unique" UNIQUE("teacher_id","grade_id")
);
--> statement-breakpoint
CREATE TABLE "activity_log" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" text,
	"school_id" text NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"entity_type" text,
	"entity_id" text,
	"details" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "authorized_pickups" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_id" text NOT NULL,
	"added_by" text NOT NULL,
	"name" text NOT NULL,
	"relationship" text NOT NULL,
	"phone" text,
	"photo_url" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bus_routes" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" text NOT NULL,
	"route_number" text NOT NULL,
	"departure_time" text,
	"status" text DEFAULT 'waiting' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custody_alerts" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_id" text NOT NULL,
	"person_name" text NOT NULL,
	"alert_type" text NOT NULL,
	"notes" text,
	"court_order" text,
	"created_by" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dismissal_changes" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" text NOT NULL,
	"student_id" text NOT NULL,
	"requested_by" text NOT NULL,
	"from_type" text NOT NULL,
	"to_type" text NOT NULL,
	"bus_route" text,
	"note" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"reviewed_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"reviewed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "dismissal_queue" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" text NOT NULL,
	"student_id" text NOT NULL,
	"guardian_id" text,
	"guardian_name" text,
	"check_in_time" timestamp DEFAULT now(),
	"check_in_method" text,
	"status" text DEFAULT 'waiting' NOT NULL,
	"zone" text,
	"called_at" timestamp,
	"released_at" timestamp,
	"dismissed_at" timestamp,
	"hold_reason" text,
	"delayed_until" timestamp,
	"position" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dismissal_sessions" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" text NOT NULL,
	"date" date DEFAULT CURRENT_DATE NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"started_at" timestamp,
	"ended_at" timestamp,
	"stats" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "dismissal_sessions_school_date_unique" UNIQUE("school_id","date")
);
--> statement-breakpoint
CREATE TABLE "family_group_students" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_group_id" text NOT NULL,
	"student_id" text NOT NULL,
	CONSTRAINT "family_group_students_unique" UNIQUE("family_group_id","student_id")
);
--> statement-breakpoint
CREATE TABLE "family_groups" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" text NOT NULL,
	"car_number" text NOT NULL,
	"family_name" text,
	"invite_token" text,
	"claimed_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "family_groups_school_car_unique" UNIQUE("school_id","car_number")
);
--> statement-breakpoint
CREATE TABLE "homerooms" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" text NOT NULL,
	"teacher_id" text,
	"name" text NOT NULL,
	"grade" text NOT NULL,
	"room" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "parent_student" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parent_id" text NOT NULL,
	"student_id" text NOT NULL,
	"relationship" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'approved' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "parent_student_unique" UNIQUE("parent_id","student_id")
);
--> statement-breakpoint
CREATE TABLE "walker_zones" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'closed' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "block_lists" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" text NOT NULL,
	"teacher_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"blocked_domains" text[] DEFAULT '{}'::text[],
	"is_default" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" varchar NOT NULL,
	"sender_id" text NOT NULL,
	"sender_type" text NOT NULL,
	"recipient_id" text,
	"content" text NOT NULL,
	"message_type" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "check_ins" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_id" text NOT NULL,
	"mood" text NOT NULL,
	"message" text,
	"timestamp" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dashboard_tabs" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"teacher_id" text NOT NULL,
	"label" text NOT NULL,
	"filter_type" text NOT NULL,
	"filter_value" jsonb,
	"order" text DEFAULT '0' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"device_id" varchar PRIMARY KEY NOT NULL,
	"device_name" text,
	"school_id" text NOT NULL,
	"class_id" text NOT NULL,
	"registered_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" text NOT NULL,
	"student_id" text,
	"event_type" text NOT NULL,
	"metadata" jsonb,
	"timestamp" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "flight_paths" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" text NOT NULL,
	"teacher_id" text,
	"flight_path_name" text NOT NULL,
	"description" text,
	"allowed_domains" text[] DEFAULT '{}'::text[],
	"blocked_domains" text[] DEFAULT '{}'::text[],
	"is_default" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "group_students" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" text NOT NULL,
	"student_id" text NOT NULL,
	"assigned_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "groups" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" text NOT NULL,
	"teacher_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"period_label" text,
	"grade_level" text,
	"group_type" text DEFAULT 'teacher_created' NOT NULL,
	"parent_group_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "heartbeats" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" text NOT NULL,
	"student_id" text,
	"student_email" text,
	"school_id" text,
	"active_tab_title" text NOT NULL,
	"active_tab_url" text,
	"favicon" text,
	"screen_locked" boolean DEFAULT false,
	"flight_path_active" boolean DEFAULT false,
	"active_flight_path_name" text,
	"is_sharing" boolean DEFAULT false,
	"camera_active" boolean DEFAULT false,
	"timestamp" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_user_id" text,
	"to_student_id" text,
	"message" text NOT NULL,
	"is_announcement" boolean DEFAULT false,
	"timestamp" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "poll_responses" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"poll_id" varchar NOT NULL,
	"student_id" text NOT NULL,
	"device_id" text,
	"selected_option" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "polls" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" varchar NOT NULL,
	"teacher_id" text NOT NULL,
	"question" text NOT NULL,
	"options" text[] NOT NULL,
	"is_active" boolean DEFAULT true,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"closed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "rosters" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"class_id" text NOT NULL,
	"class_name" text NOT NULL,
	"device_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"uploaded_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_settings" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" varchar NOT NULL,
	"chat_enabled" boolean DEFAULT true,
	"raise_hand_enabled" boolean DEFAULT true,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "session_settings_session_id_unique" UNIQUE("session_id")
);
--> statement-breakpoint
CREATE TABLE "student_devices" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_id" text NOT NULL,
	"device_id" text NOT NULL,
	"first_seen_at" timestamp DEFAULT now() NOT NULL,
	"last_seen_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "student_devices_unique" UNIQUE("student_id","device_id")
);
--> statement-breakpoint
CREATE TABLE "student_groups" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" text NOT NULL,
	"teacher_id" text,
	"group_name" text NOT NULL,
	"description" text,
	"student_ids" text[] DEFAULT '{}'::text[],
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "student_sessions" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_id" text NOT NULL,
	"device_id" text NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"last_seen_at" timestamp DEFAULT now() NOT NULL,
	"ended_at" timestamp,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subgroup_members" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subgroup_id" varchar NOT NULL,
	"student_id" text NOT NULL,
	"assigned_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subgroups" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" varchar NOT NULL,
	"name" text NOT NULL,
	"color" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "teacher_settings" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"teacher_id" text NOT NULL,
	"max_tabs_per_student" text,
	"allowed_domains" text[] DEFAULT '{}'::text[],
	"blocked_domains" text[] DEFAULT '{}'::text[],
	"default_flight_path_id" text,
	"hand_raising_enabled" boolean DEFAULT true NOT NULL,
	"student_messaging_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "teacher_settings_teacher_id_unique" UNIQUE("teacher_id")
);
--> statement-breakpoint
CREATE TABLE "teacher_students" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"teacher_id" text NOT NULL,
	"student_id" text NOT NULL,
	"assigned_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "teaching_sessions" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" text NOT NULL,
	"teacher_id" text NOT NULL,
	"start_time" timestamp DEFAULT now() NOT NULL,
	"end_time" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" text NOT NULL,
	"user_id" text NOT NULL,
	"user_email" text,
	"user_role" text,
	"action" text NOT NULL,
	"entity_type" text,
	"entity_id" text,
	"entity_name" text,
	"changes" jsonb,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "classroom_course_students" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" text NOT NULL,
	"course_id" text NOT NULL,
	"student_id" text NOT NULL,
	"google_user_id" text,
	"student_email_lc" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_seen_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "classroom_course_students_enrollment_unique" UNIQUE("school_id","course_id","student_id")
);
--> statement-breakpoint
CREATE TABLE "classroom_courses" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" text NOT NULL,
	"google_course_id" text NOT NULL,
	"name" text NOT NULL,
	"section" text,
	"room" text,
	"description_heading" text,
	"owner_id" text,
	"grade_id" text,
	"last_synced_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"sid" varchar PRIMARY KEY NOT NULL,
	"sess" jsonb NOT NULL,
	"expire" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "google_oauth_tokens" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"refresh_token" text NOT NULL,
	"scope" text,
	"token_type" text,
	"expiry_date" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "google_oauth_tokens_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" text NOT NULL,
	"school_name" text NOT NULL,
	"ws_shared_key" text NOT NULL,
	"retention_hours" text DEFAULT '720' NOT NULL,
	"blocked_domains" text[] DEFAULT '{}'::text[],
	"allowed_domains" text[] DEFAULT '{}'::text[],
	"ip_allowlist" text[] DEFAULT '{}'::text[],
	"grade_levels" text[] DEFAULT '{6,7,8,9,10,11,12}'::text[],
	"max_tabs_per_student" text,
	"active_flight_path_id" text,
	"enable_tracking_hours" boolean DEFAULT false,
	"tracking_start_time" text DEFAULT '08:00',
	"tracking_end_time" text DEFAULT '15:00',
	"school_timezone" text DEFAULT 'America/New_York',
	"tracking_days" text[] DEFAULT '{Monday,Tuesday,Wednesday,Thursday,Friday}'::text[],
	"after_hours_mode" text DEFAULT 'off' NOT NULL,
	"hand_raising_enabled" boolean DEFAULT true,
	"student_messaging_enabled" boolean DEFAULT true,
	"ai_safety_emails_enabled" boolean DEFAULT true,
	CONSTRAINT "settings_school_id_unique" UNIQUE("school_id")
);
--> statement-breakpoint
CREATE TABLE "trial_requests" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_name" text NOT NULL,
	"domain" text,
	"contact_name" text NOT NULL,
	"contact_email" text NOT NULL,
	"admin_phone" text,
	"estimated_students" text,
	"estimated_teachers" text,
	"message" text,
	"zip_code" text,
	"product" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"notes" text,
	"school_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"processed_at" timestamp,
	"processed_by" text
);
--> statement-breakpoint
CREATE INDEX "product_licenses_school_id_idx" ON "product_licenses" USING btree ("school_id");--> statement-breakpoint
CREATE INDEX "school_memberships_user_id_idx" ON "school_memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "school_memberships_school_id_idx" ON "school_memberships" USING btree ("school_id");--> statement-breakpoint
CREATE UNIQUE INDEX "school_memberships_car_number_unique" ON "school_memberships" USING btree ("school_id","car_number") WHERE car_number IS NOT NULL;--> statement-breakpoint
CREATE INDEX "users_google_id_idx" ON "users" USING btree ("google_id");--> statement-breakpoint
CREATE INDEX "users_email_idx" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "students_school_id_idx" ON "students" USING btree ("school_id");--> statement-breakpoint
CREATE INDEX "students_grade_id_idx" ON "students" USING btree ("grade_id");--> statement-breakpoint
CREATE INDEX "students_homeroom_id_idx" ON "students" USING btree ("homeroom_id");--> statement-breakpoint
CREATE INDEX "students_school_email_idx" ON "students" USING btree ("school_id","email_lc");--> statement-breakpoint
CREATE INDEX "students_last_first_idx" ON "students" USING btree ("last_name","first_name");--> statement-breakpoint
CREATE UNIQUE INDEX "students_school_id_number_unique" ON "students" USING btree ("school_id","student_id_number") WHERE student_id_number IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "students_school_code_unique" ON "students" USING btree ("school_id","student_code") WHERE student_code IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "students_school_email_unique" ON "students" USING btree ("school_id","email_lc") WHERE email_lc IS NOT NULL;--> statement-breakpoint
CREATE INDEX "grades_school_id_idx" ON "grades" USING btree ("school_id");--> statement-breakpoint
CREATE INDEX "passes_school_id_idx" ON "passes" USING btree ("school_id");--> statement-breakpoint
CREATE INDEX "passes_student_id_idx" ON "passes" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "passes_teacher_id_idx" ON "passes" USING btree ("teacher_id");--> statement-breakpoint
CREATE INDEX "passes_status_idx" ON "passes" USING btree ("status");--> statement-breakpoint
CREATE INDEX "passes_issued_at_idx" ON "passes" USING btree ("issued_at");--> statement-breakpoint
CREATE INDEX "activity_log_session_id_idx" ON "activity_log" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "activity_log_school_date_idx" ON "activity_log" USING btree ("school_id","created_at");--> statement-breakpoint
CREATE INDEX "authorized_pickups_student_id_idx" ON "authorized_pickups" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "bus_routes_school_id_idx" ON "bus_routes" USING btree ("school_id");--> statement-breakpoint
CREATE INDEX "custody_alerts_student_id_idx" ON "custody_alerts" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "dismissal_changes_session_id_idx" ON "dismissal_changes" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "dismissal_changes_student_id_idx" ON "dismissal_changes" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "dismissal_queue_session_status_idx" ON "dismissal_queue" USING btree ("session_id","status");--> statement-breakpoint
CREATE INDEX "dismissal_queue_student_id_idx" ON "dismissal_queue" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "dismissal_sessions_school_id_idx" ON "dismissal_sessions" USING btree ("school_id");--> statement-breakpoint
CREATE UNIQUE INDEX "family_groups_invite_token_unique" ON "family_groups" USING btree ("invite_token") WHERE invite_token IS NOT NULL;--> statement-breakpoint
CREATE INDEX "family_groups_school_id_idx" ON "family_groups" USING btree ("school_id");--> statement-breakpoint
CREATE INDEX "homerooms_school_id_idx" ON "homerooms" USING btree ("school_id");--> statement-breakpoint
CREATE INDEX "homerooms_teacher_id_idx" ON "homerooms" USING btree ("teacher_id");--> statement-breakpoint
CREATE INDEX "parent_student_parent_id_idx" ON "parent_student" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "parent_student_student_id_idx" ON "parent_student" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "walker_zones_school_id_idx" ON "walker_zones" USING btree ("school_id");--> statement-breakpoint
CREATE INDEX "block_lists_school_id_idx" ON "block_lists" USING btree ("school_id");--> statement-breakpoint
CREATE INDEX "block_lists_teacher_id_idx" ON "block_lists" USING btree ("teacher_id");--> statement-breakpoint
CREATE INDEX "chat_messages_session_id_idx" ON "chat_messages" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "events_device_id_idx" ON "events" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "events_timestamp_idx" ON "events" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "flight_paths_school_id_idx" ON "flight_paths" USING btree ("school_id");--> statement-breakpoint
CREATE INDEX "flight_paths_teacher_id_idx" ON "flight_paths" USING btree ("teacher_id");--> statement-breakpoint
CREATE INDEX "group_students_group_id_idx" ON "group_students" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "group_students_student_id_idx" ON "group_students" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "groups_school_id_idx" ON "groups" USING btree ("school_id");--> statement-breakpoint
CREATE INDEX "groups_teacher_id_idx" ON "groups" USING btree ("teacher_id");--> statement-breakpoint
CREATE INDEX "heartbeats_timestamp_idx" ON "heartbeats" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "heartbeats_student_id_idx" ON "heartbeats" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "heartbeats_student_email_idx" ON "heartbeats" USING btree ("student_email");--> statement-breakpoint
CREATE INDEX "heartbeats_device_id_idx" ON "heartbeats" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "heartbeats_student_timestamp_idx" ON "heartbeats" USING btree ("student_id","timestamp");--> statement-breakpoint
CREATE INDEX "heartbeats_email_timestamp_idx" ON "heartbeats" USING btree ("student_email","timestamp");--> statement-breakpoint
CREATE INDEX "heartbeats_school_email_idx" ON "heartbeats" USING btree ("school_id","student_email");--> statement-breakpoint
CREATE INDEX "heartbeats_school_device_timestamp_idx" ON "heartbeats" USING btree ("school_id","device_id","timestamp");--> statement-breakpoint
CREATE INDEX "poll_responses_poll_id_idx" ON "poll_responses" USING btree ("poll_id");--> statement-breakpoint
CREATE INDEX "polls_session_id_idx" ON "polls" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "student_groups_school_id_idx" ON "student_groups" USING btree ("school_id");--> statement-breakpoint
CREATE UNIQUE INDEX "student_sessions_active_student_unique" ON "student_sessions" USING btree ("student_id") WHERE is_active = true;--> statement-breakpoint
CREATE UNIQUE INDEX "student_sessions_active_device_unique" ON "student_sessions" USING btree ("device_id") WHERE is_active = true;--> statement-breakpoint
CREATE INDEX "student_sessions_student_device_active_idx" ON "student_sessions" USING btree ("student_id","device_id","is_active");--> statement-breakpoint
CREATE INDEX "student_sessions_last_seen_active_idx" ON "student_sessions" USING btree ("last_seen_at","is_active");--> statement-breakpoint
CREATE INDEX "teaching_sessions_group_id_idx" ON "teaching_sessions" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "teaching_sessions_teacher_id_idx" ON "teaching_sessions" USING btree ("teacher_id");--> statement-breakpoint
CREATE INDEX "audit_logs_school_id_idx" ON "audit_logs" USING btree ("school_id");--> statement-breakpoint
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_action_idx" ON "audit_logs" USING btree ("action");--> statement-breakpoint
CREATE INDEX "audit_logs_user_id_idx" ON "audit_logs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "classroom_course_students_school_course_idx" ON "classroom_course_students" USING btree ("school_id","course_id");--> statement-breakpoint
CREATE INDEX "classroom_course_students_school_student_idx" ON "classroom_course_students" USING btree ("school_id","student_id");--> statement-breakpoint
CREATE INDEX "classroom_courses_school_id_idx" ON "classroom_courses" USING btree ("school_id");--> statement-breakpoint
CREATE UNIQUE INDEX "classroom_courses_school_google_unique" ON "classroom_courses" USING btree ("school_id","google_course_id");--> statement-breakpoint
CREATE INDEX "session_expire_idx" ON "session" USING btree ("expire");--> statement-breakpoint
CREATE INDEX "trial_requests_status_idx" ON "trial_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "trial_requests_email_idx" ON "trial_requests" USING btree ("contact_email");