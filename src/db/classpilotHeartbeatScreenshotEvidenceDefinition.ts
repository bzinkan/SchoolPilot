// Immutable version-one snapshot. Change by a new migration, never by regenerating this file.
export const CLASSPILOT_HEARTBEAT_SCREENSHOT_EVIDENCE_SIGNATURE =
  "public.classpilot_heartbeat_screenshot_evidence_v1(text,text,text,text)";

export const CLASSPILOT_HEARTBEAT_SCREENSHOT_EVIDENCE_SQL = String.raw`CREATE FUNCTION public.classpilot_heartbeat_screenshot_evidence_v1(p_school_id text,p_student_id text,p_session_id text,p_device_id text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER PARALLEL UNSAFE SET search_path=pg_catalog AS $body$
DECLARE v_session record; v_control record; v_candidate record; v_owners jsonb; v_result jsonb;
BEGIN
 SELECT * INTO v_session FROM (select "student_sessions"."id" as "id", "student_sessions"."started_at" as "startedAt", "student_sessions"."auth_kind" as "authKind", "student_sessions"."manual_lease_expires_at" as "manualLeaseExpiresAt" from public."student_sessions" inner join public."students" on ("students"."id" = "student_sessions"."student_id" and "students"."school_id" = p_school_id and "students"."status" = 'active') inner join public."devices" on ("devices"."device_id" = "student_sessions"."device_id" and "devices"."school_id" = p_school_id) where ("student_sessions"."id" = p_session_id and "student_sessions"."student_id" = p_student_id and "student_sessions"."device_id" = p_device_id and ("student_sessions"."is_active" = true and "student_sessions"."ended_at" is null and ("student_sessions"."auth_kind" <> 'manual_shared' or ("student_sessions"."manual_lease_expires_at" is not null and "student_sessions"."manual_lease_expires_at" > clock_timestamp())))) limit 1 for share) evidence_session;
 IF NOT FOUND THEN RETURN jsonb_build_object('stage','session_missing'); END IF;
 v_result := jsonb_build_object('stage','control','session',to_jsonb(v_session));
 SELECT * INTO v_control FROM (select "teaching_session_id" as "teachingSessionId", "supervision_context_id" as "supervisionContextId", "revision" as "revision", "scheduled_end_at" as "scheduledEndAt", "hard_expires_at" as "hardExpiresAt", "updated_at" as "updatedAt" from public."classpilot_student_control_states" where ("classpilot_student_control_states"."school_id" = p_school_id and "classpilot_student_control_states"."student_id" = p_student_id) limit 1 for share) evidence_control;
 IF NOT FOUND THEN RETURN v_result || jsonb_build_object('control',NULL); END IF;
 v_result := v_result || jsonb_build_object('control',to_jsonb(v_control));
 IF v_control."teachingSessionId" IS NULL OR v_control."supervisionContextId" IS NOT NULL OR v_control."hardExpiresAt" IS NULL THEN RETURN v_result; END IF;
 SELECT * INTO v_candidate FROM (select "teaching_sessions"."id" as "teachingSessionId", "teaching_sessions"."start_time" as "startTime", "teaching_sessions"."roster_snapshot_completed_at" as "rosterSnapshotCompletedAt", "teaching_sessions"."scheduled_end_at" as "teachingScheduledEndAt", "classpilot_student_control_states"."revision" as "controlRevision", "classpilot_student_control_states"."updated_at" as "controlUpdatedAt", "classpilot_student_control_states"."scheduled_end_at" as "controlScheduledEndAt", "classpilot_student_control_states"."hard_expires_at" as "controlHardExpiresAt" from public."classpilot_student_control_states" inner join public."teaching_sessions" on ("teaching_sessions"."id" = "classpilot_student_control_states"."teaching_session_id" and "teaching_sessions"."school_id" = p_school_id and "teaching_sessions"."session_mode" = 'live' and "teaching_sessions"."end_time" is null and "teaching_sessions"."roster_snapshot_completed_at" is not null) inner join public."classpilot_session_students" on ("classpilot_session_students"."school_id" = p_school_id and "classpilot_session_students"."teaching_session_id" = "teaching_sessions"."id" and "classpilot_session_students"."student_id" = p_student_id) where ("classpilot_student_control_states"."school_id" = p_school_id and "classpilot_student_control_states"."student_id" = p_student_id and "classpilot_student_control_states"."teaching_session_id" = v_control."teachingSessionId" and "classpilot_student_control_states"."supervision_context_id" is null and "classpilot_student_control_states"."hard_expires_at" is not null and "classpilot_student_control_states"."hard_expires_at" > now() and ("classpilot_student_control_states"."scheduled_end_at" is null or "classpilot_student_control_states"."scheduled_end_at" > now()) and ("teaching_sessions"."scheduled_end_at" is null or "teaching_sessions"."scheduled_end_at" > now())) limit 1 for share) evidence_candidate;
 IF NOT FOUND THEN RETURN v_result || jsonb_build_object('stage','candidate_missing'); END IF;
 SELECT jsonb_agg(to_jsonb(evidence_owner)) INTO v_owners FROM (
    WITH owner_candidates AS (
      SELECT session.id, session.control_updated_at, session.start_time, session.created_at
      FROM public."classpilot_session_students" roster
      INNER JOIN public."teaching_sessions" session ON session.id=roster.teaching_session_id
        AND session.session_mode='live'
        AND session.roster_snapshot_completed_at IS NOT NULL AND session.end_time IS NULL
      INNER JOIN public."groups" owner_group ON owner_group.id=session.group_id
      WHERE roster.school_id=p_school_id AND roster.student_id=p_student_id
        AND owner_group.school_id=p_school_id
      UNION ALL
      SELECT session.id, session.control_updated_at, session.start_time, session.created_at
      FROM public."group_students" roster
      INNER JOIN public."groups" owner_group ON owner_group.id=roster.group_id
      INNER JOIN public."teaching_sessions" session ON session.group_id=owner_group.id
        AND session.session_mode='live'
        AND session.roster_snapshot_completed_at IS NULL AND session.end_time IS NULL
      WHERE owner_group.school_id=p_school_id AND roster.student_id=p_student_id
    )
    SELECT EXISTS (
      SELECT 1 FROM public."classpilot_supervision_students" assignment
      INNER JOIN public."classpilot_supervision_contexts" context ON context.id=assignment.context_id
      INNER JOIN public."students" student ON student.id=assignment.student_id
        AND student.school_id=p_school_id AND student.status='active'
      WHERE assignment.school_id=p_school_id AND assignment.student_id=p_student_id
        AND assignment.released_at IS NULL AND context.school_id=p_school_id
        AND context.status='active' AND context.starts_at<=now()
        AND context.ends_at>now()
    ) AS "hasActiveSupervision", owner.id, owner.control_updated_at AS "controlUpdatedAt",
      owner.start_time AS "startTime", owner.created_at AS "createdAt"
    FROM (SELECT 1) anchor LEFT JOIN owner_candidates owner ON true
  ) evidence_owner;
 RETURN v_result || jsonb_build_object('stage','owner','candidate',to_jsonb(v_candidate),'owners',v_owners);
END $body$;
`;

export const CLASSPILOT_HEARTBEAT_SCREENSHOT_EVIDENCE_REVOKE_SQL =
  `REVOKE ALL ON FUNCTION ${CLASSPILOT_HEARTBEAT_SCREENSHOT_EVIDENCE_SIGNATURE} FROM PUBLIC`;

export const CLASSPILOT_HEARTBEAT_SCREENSHOT_EVIDENCE_BODY =
  CLASSPILOT_HEARTBEAT_SCREENSHOT_EVIDENCE_SQL.split("$body$")[1]!;
