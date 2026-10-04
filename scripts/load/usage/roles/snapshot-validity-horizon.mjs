import assert from 'node:assert/strict';
// Called after restoration and again at a campaign's pre-cold gate. This is a
// read-only preflight; it never refreshes authority or changes immutable dates.
export async function verifySnapshotValidityHorizon(client,schools,horizonMs){
  assert.ok(Number.isSafeInteger(horizonMs)&&horizonMs>=120000&&horizonMs<=20*60*1000);
  assert.equal(schools.length,2);
  const rows=[];
  for(const school of schools){
    const row=(await client.query(`WITH boundary AS (SELECT clock_timestamp() AS now,clock_timestamp()+$2::bigint*interval '1 millisecond' AS until)
      SELECT boundary.now::text AS observed_at,boundary.until::text AS required_valid_until,
      (SELECT COUNT(*)::int FROM schools WHERE id=$1 AND active_until IS NOT NULL AND active_until<=boundary.until AT TIME ZONE 'UTC') AS school_expiries,
      (SELECT COUNT(*)::int FROM product_licenses WHERE school_id=$1 AND product='CLASSPILOT' AND expires_at IS NOT NULL AND expires_at<=boundary.until AT TIME ZONE 'UTC') AS license_expiries,
      (SELECT COUNT(*)::int FROM classpilot_student_control_states WHERE school_id=$1 AND hard_expires_at<=boundary.until) AS control_expiries,
      (SELECT COUNT(*)::int FROM teaching_sessions WHERE school_id=$1 AND end_time IS NULL AND scheduled_end_at IS NOT NULL AND scheduled_end_at<=boundary.until) AS teaching_expiries,
      (SELECT COUNT(*)::int FROM student_sessions ss JOIN students s ON s.id=ss.student_id WHERE s.school_id=$1 AND ss.is_active AND ss.ended_at IS NULL AND ss.auth_kind='manual_shared' AND ss.manual_lease_expires_at<=boundary.until) AS manual_session_expiries
      FROM boundary`,[school.id,horizonMs])).rows[0];
    for(const key of ['school_expiries','license_expiries','control_expiries','teaching_expiries','manual_session_expiries'])assert.equal(row[key],0,`Snapshot authority expires within required interval: ${key}`);
    rows.push({schoolIndex:school.index,...row});
  }
  return {schemaVersion:1,horizonMs,passed:true,rows,authorityRefreshed:false,credentialsRefreshed:false};
}
