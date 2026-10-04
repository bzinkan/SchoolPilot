import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  heartbeatSessionQuery, heartbeatControlQuery, heartbeatCandidateQuery, heartbeatTelemetryOwnerQuery,
} from "../../src/services/classpilotHeartbeatReadQueries.js";

/** Test-only regeneration. The migration stores immutable bytes rather than
 * importing these live builders, so future policy changes require a new version. */
export function canonicalHeartbeatScreenshotFunctionSql(): string {
  const mock = drizzle.mock();
  const aliases = new Proxy(mock, {
    get(target, key, receiver) {
      if (key === "select") return (fields: Record<string, SQLWrapper>) => target.select(
        Object.fromEntries(Object.entries(fields).map(([name, column]) => [name, sql`${column}`.as(name)]))
      );
      return Reflect.get(target, key, receiver);
    },
  });
  const parameters = { schoolId: sql.raw("p_school_id"), studentId: sql.raw("p_student_id"),
    studentSessionId: sql.raw("p_session_id"), deviceId: sql.raw("p_device_id") };
  function inline(query: SQL): string {
    const dialect = new PgDialect();
    dialect.escapeParam = index => `__fixed_constant_${index}__`;
    const compiled = dialect.sqlToQuery(query);
    let text = compiled.sql;
    for (const [index, value] of compiled.params.entries()) {
      if (value !== null && typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
        throw new TypeError("Unexpected screenshot function constant encoder");
      }
      const literal = value === null ? "NULL" : typeof value === "string" ? dialect.escapeString(value) : String(value);
      text = text.replaceAll(`__fixed_constant_${index}__`, literal);
    }
    if (text.includes("__fixed_constant_")) throw new Error("Unbound screenshot function constant");
    return text.replace(/\b(FROM|JOIN)\s+"([a-z_]+)"/gi, '$1 public."$2"');
  }
  const session = inline(heartbeatSessionQuery(aliases, parameters).getSQL());
  const control = inline(heartbeatControlQuery(aliases, parameters).getSQL());
  const candidate = inline(heartbeatCandidateQuery(aliases, { ...parameters,
    teachingSessionId: sql.raw('v_control."teachingSessionId"') }).getSQL());
  const owner = inline(heartbeatTelemetryOwnerQuery(parameters.schoolId, parameters.studentId, "transaction"));
  return `CREATE FUNCTION public.classpilot_heartbeat_screenshot_evidence_v1(p_school_id text,p_student_id text,p_session_id text,p_device_id text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER PARALLEL UNSAFE SET search_path=pg_catalog AS $body$
DECLARE v_session record; v_control record; v_candidate record; v_owners jsonb; v_result jsonb;
BEGIN
 SELECT * INTO v_session FROM (${session}) evidence_session;
 IF NOT FOUND THEN RETURN jsonb_build_object('stage','session_missing'); END IF;
 v_result := jsonb_build_object('stage','control','session',to_jsonb(v_session));
 SELECT * INTO v_control FROM (${control}) evidence_control;
 IF NOT FOUND THEN RETURN v_result || jsonb_build_object('control',NULL); END IF;
 v_result := v_result || jsonb_build_object('control',to_jsonb(v_control));
 IF v_control."teachingSessionId" IS NULL OR v_control."supervisionContextId" IS NOT NULL OR v_control."hardExpiresAt" IS NULL THEN RETURN v_result; END IF;
 SELECT * INTO v_candidate FROM (${candidate}) evidence_candidate;
 IF NOT FOUND THEN RETURN v_result || jsonb_build_object('stage','candidate_missing'); END IF;
 SELECT jsonb_agg(to_jsonb(evidence_owner)) INTO v_owners FROM (${owner}) evidence_owner;
 RETURN v_result || jsonb_build_object('stage','owner','candidate',to_jsonb(v_candidate),'owners',v_owners);
END $body$;
`;
}
