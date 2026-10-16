# Disposable synthetic ClassPilot reliability environment. Use only the
# external isolated workspace created by prepare-classpilot-staging.ps1.
# Bootstrap overrides: staging_bootstrap=true, ecs_desired_count=0,
# worker_desired_count=0. Serving requires api_image_digest from reviewed ECR.
project     = "schoolpilot"
environment = "staging"
aws_region  = "us-east-1"
domain      = "school-pilot.net"

vpc_cidr                    = "10.0.0.0/16"
az_count                    = 2
ecs_tasks_in_public_subnets = true
enable_nat_gateway          = false

db_instance_class        = "db.t4g.medium"
db_multi_az              = false
db_allocated_storage     = 100
db_max_allocated_storage = 100
db_name                  = "schoolpilot_staging"
db_username              = "schoolpilot_admin"
redis_node_type          = "cache.t4g.micro"
redis_replica_count      = 0

api_alb_health_check_path   = "/readyz"
ecs_desired_count           = 3
ecs_cpu                     = 1024
ecs_memory                  = 2048
worker_desired_count        = 1
worker_cpu                  = 512
worker_memory               = 1024
api_max_capacity            = 6
enable_api_arrival_capacity = false
api_autoscaling_suspended   = true
enable_container_insights   = false
# Match observed production env; runtime clamps main pools to API16/worker2.
db_pool_max           = 20
scheduler_db_pool_max = 5

cookie_name                            = "schoolpilot.staging.sid"
cookie_domain                          = ""
provider_secrets_enabled               = false
google_client_id                       = ""
staging_classpilot_reliability_enabled = true
mydesk_mode                            = "off"
mydesk_seating_mode                    = "off"
mydesk_ai_import_mode                  = "off"
student_information_ai_import_mode     = "off"
enable_classpilot_turn                 = false
route53_measure_latency                = false

waf_api_rate_limit           = 50000
waf_device_ingest_rate_limit = 100000
waf_rate_rule_action         = "block"

# Fresh schema is migrated and verified before either service is started.
# Exact current 129-table private-chat lifecycle admission; not production state.
rls_enabled_tables = "activity_log,audit_logs,block_lists,bus_routes,chat_messages,classpilot_active_hands,classpilot_ai_decisions,classpilot_classroom_states,classpilot_command_targets,classpilot_commands,classpilot_coverage_assignments,classpilot_coverage_scope_group_members,classpilot_coverage_scope_groups,classpilot_scheduled_conflicts,classpilot_session_students,classpilot_session_usage,classpilot_supervision_contexts,classpilot_supervision_students,classroom_course_students,classroom_courses,daily_usage,dashboard_tabs,devices,dismissal_sessions,email_alerts,email_scan_log,error_logs,evidence_artifacts,family_groups,flight_paths,google_roster_connectors,grades,groups,heartbeats,homerooms,import_runs,mailpilot_watches,messages,parent_student,passes,security_events,settings,student_attendance,student_groups,student_safety_cases,student_timeline_events,students,subgroups,teacher_students,teaching_sessions,walker_zones,classpilot_session_summary_deliveries,passpilot_grade_students,authorized_pickups,custody_alerts,dismissal_changes,dismissal_overrides,dismissal_queue,family_group_students,homeroom_teachers,classpilot_monitoring_events,classpilot_session_reports,classpilot_session_staff,classpilot_session_student_reports,classpilot_student_control_states,classpilot_schedule_change_pairs,classpilot_schedule_changes,classpilot_schedule_change_legs,classpilot_chat_deliveries,poll_responses,polls,session_settings,classpilot_evidence_capture_requests,passpilot_kiosk_devices,passpilot_kiosk_sessions,student_safety_alerts,student_safety_case_events,safety_url_exceptions,safety_notification_outbox,classpilot_school_schedules,roster_integration_connections,roster_integration_runs,roster_integration_identities,roster_integration_memberships,classpilot_school_website_policies,classpilot_school_website_deliveries,classpilot_monitoring_expectations,classpilot_monitoring_interruptions,classpilot_monitoring_interruption_settings,classpilot_monitoring_interruption_digests,classpilot_coverage_group_categories,classpilot_supervision_report_segments,classpilot_supervision_student_reports,classpilot_supervision_summary_deliveries,classpilot_timers,classpilot_lesson_activities,classpilot_lesson_progress,classpilot_questions,classpilot_picker_rounds,classpilot_tool_templates,classpilot_routine_runs,classpilot_tool_history,passpilot_teacher_kiosk_settings,mydesk_attachments,mydesk_notes,mydesk_seating_charts,mydesk_import_assets,mydesk_import_items,mydesk_imports,mydesk_preferences,school_discipline_records,school_discipline_versions,school_discipline_attachments,school_discipline_access,student_contact_profiles,student_contact_profile_versions,student_information_imports,student_information_import_items,student_information_import_assets,classpilot_teacher_preferences,import_processing_stages,passpilot_destination_policies,passpilot_pass_limits,passpilot_encounter_restrictions,passpilot_pass_denials,classpilot_usage_rollups,classpilot_usage_rollup_days,passpilot_appointments,classpilot_private_chat_threads"
