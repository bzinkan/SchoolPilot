import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {loadSnapshot,snapshotHash} from './snapshot-contract.mjs';

export async function validateSnapshotDatabase(config) {
  const root=resolve(config.sourceDirectory),source=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
  assert.equal(execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim(),'');
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const bundle=loadSnapshot(config.snapshotDirectory,config.snapshotManifestSha256,{source,today});
  const {assertColdFixtureSnapshot}=await import(pathToFileURL(resolve(root,'scripts/load/usage/cold-open-loop-profile.mjs')));
  const {validateReleaseControlRows}=await import(pathToFileURL(resolve(root,'scripts/load/usage/prepare-release-control-ownership.mjs')));
  const {assertCompleteFixtureCatalog}=await import(pathToFileURL(resolve(root,'scripts/load/usage/fixture-rls-contract.mjs')));
  const time=await import(pathToFileURL(resolve(root,'dist/util/schoolTime.js')));
  const snapshot=bundle.data['cold-fixture-state.json'],contract=bundle.data['preparation-fixture-contract.json'],metrics=bundle.data['preparation-metrics.json'];
  const registry=readFileSync(resolve(root,'src/config/rlsRegistry.json'));
  assertColdFixtureSnapshot(snapshot,{sourceRevision:source,today,registrySha256:snapshotHash(registry),sourceHashes:Object.fromEntries(Object.keys(snapshot.sourceHashes).map(name=>{
    assert.ok(/^(?:src|scripts)\/[a-zA-Z0-9_./-]+$/.test(name)&&!name.includes('..'));return[name,snapshotHash(readFileSync(resolve(root,name)))];
  }))});
  const control=bundle.data['release-control-preparation.json'];assert.equal(control.sourceRevision,source);assert.equal(control.passed,true);assert.equal(control.poolsClosed,true);
  assert.equal(control.coldFixtureSha256,snapshotHash(readFileSync(resolve(bundle.root,'cold-fixture-state.json'))));
  assert.equal(control.scriptSha256,snapshotHash(readFileSync(resolve(root,'scripts/load/usage/prepare-release-control-ownership.mjs'))));
  const {Client}=createRequire(resolve(root,'package.json'))('pg');
  for(const key of ['adminUrl','appUrl']){const u=new URL(config[key]);assert.equal(u.protocol,'postgresql:');assert.equal(u.hostname,'127.0.0.1');assert.equal(u.port,'5437');assert.equal(u.search,'');assert.equal(u.hash,'');assert.match(u.pathname,/^\/schoolpilot_redesign_usage_(?:restore|scale)_[a-f0-9]{12}$/);}
  const admin=new Client({connectionString:config.adminUrl,connectionTimeoutMillis:5000,statement_timeout:60000});
  const app=new Client({connectionString:config.appUrl,connectionTimeoutMillis:5000,statement_timeout:60000});
  const result={schemaVersion:1,source,seedSource:bundle.manifest.source,snapshotManifestSha256:bundle.manifestSha256,startedAt:new Date().toISOString(),stage:'connect',passed:false,clientsClosed:false,schools:[],schemaComparedByOwner:false,measurementStarted:false};
  try {
    await admin.connect();await app.connect();
    const facts=(await admin.query("SELECT current_setting('server_version') AS version,current_setting('TimeZone') AS timezone,current_setting('server_encoding') AS encoding,(clock_timestamp() AT TIME ZONE 'America/New_York')::date::text AS today")).rows[0];
    assert.deepEqual(facts,{version:'16.15',timezone:'UTC',encoding:'UTF8',today});result.database=facts;
    const role=(await app.query("SELECT current_user,session_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows[0];
    assert.equal(role.current_user,role.session_user);assert.equal(role.rolsuper,false);assert.equal(role.rolbypassrls,false);assert.notEqual(role.current_user,bundle.manifest.credentials.restrictedRole);
    result.role={sameUser:true,superuser:false,bypassRls:false,freshCredentialRole:true};
    const {assertClasspilotHeartbeatScreenshotEvidence}=await import(pathToFileURL(resolve(root,'dist/db/classpilotHeartbeatScreenshotEvidenceInstallation.js')));
    await assertClasspilotHeartbeatScreenshotEvidence(app);
    result.screenshotEvidence={signature:'public.classpilot_heartbeat_screenshot_evidence_v1(text,text,text,text)',runtimeExecute:true,publicExecute:false,exactDefinition:true};
    const catalog=(await app.query("SELECT relname,relrowsecurity,relforcerowsecurity,relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owns_table FROM pg_class WHERE relnamespace='public'::regnamespace AND relname=ANY($1::text[]) ORDER BY relname",[contract.rlsContract.tables])).rows;
    assert.equal(contract.rlsContract.tables.length,129);assertCompleteFixtureCatalog(contract.rlsContract,catalog);result.admittedTables=catalog.length;
    const migrations=(await admin.query('SELECT id,checksum,status FROM schema_migrations ORDER BY id')).rows;
    assert.deepEqual(migrations,contract.migrations);assert.equal(migrations.length,54);assert.ok(migrations.every(r=>r.status==='complete'));result.migrationsSha256=snapshotHash(JSON.stringify(migrations));result.migrations=54;
    result.migrationRows=migrations;result.registrySha256=snapshotHash(registry);
    result.admission={inventory:'classpilotPrivateChatLifecyclePostExpand',tables:129,forced:true,restrictedNonOwnerRole:true};
    result.stage='fixture-counts';
    const counts=(await admin.query('SELECT id AS school_id,(SELECT COUNT(*) FROM heartbeats WHERE school_id=schools.id) AS raw,(SELECT COUNT(*) FROM teaching_sessions WHERE school_id=schools.id) AS sessions,(SELECT COUNT(*) FROM classpilot_session_students WHERE school_id=schools.id) AS frozen_roster_rows,(SELECT COUNT(*) FROM classpilot_usage_rollups WHERE school_id=schools.id) AS aggregates FROM schools ORDER BY id')).rows;
    result.fixtureCounts=counts.map(({school_id,...row})=>({schoolIndex:snapshot.schools.findIndex(s=>s.id===school_id),...row}));
    assert.deepEqual(counts,[...snapshot.preparation.fixtureCounts].sort((a,b)=>a.school_id.localeCompare(b.school_id)));
    const start=time.utcTimestampForSql(time.localDateStartUtc(metrics.dataset.heavyDate,'America/New_York')),end=time.utcTimestampForSql(time.localDateStartUtc(time.addLocalDays(metrics.dataset.heavyDate,1),'America/New_York'));
    for(const school of snapshot.schools){
      result.currentSchoolIndex=school.index;result.stage='tenant-isolation';
      await app.query('BEGIN READ ONLY');await app.query("SELECT set_config('app.school_id',$1,true),set_config('app.is_super','off',true)",[school.id]);
      // schools is intentionally global; students is in the admitted FORCE-RLS inventory.
      assert.ok(contract.rlsContract.tables.includes('students'));assert.ok(!contract.rlsContract.tables.includes('schools'));
      const visible=(await app.query('SELECT COUNT(*)::int AS visible,COUNT(*) FILTER(WHERE school_id=$1)::int AS current,COUNT(*) FILTER(WHERE school_id<>$1)::int AS foreign FROM students',[school.id])).rows[0];
      result.tenantVisibility=visible;assert.deepEqual(visible,{visible:500,current:500,foreign:0});
      result.stage='staff-identity';
      const staffIdentity=(await app.query(`SELECT COUNT(*)::int AS count FROM unnest($2::text[]) AS expected(id)
        JOIN users u ON u.id=expected.id AND u.email='scale-'||expected.id||'@example.test' AND u.is_super_admin=false AND u.auth_version=1
        JOIN school_memberships m ON m.user_id=u.id AND m.school_id=$1 AND m.status='active'
        AND m.role=CASE WHEN u.id=$3 THEN 'school_admin' ELSE 'teacher' END`,[school.id,[school.staff,...school.teachers],school.staff])).rows[0];
      result.staffIdentityCount=staffIdentity.count;assert.equal(staffIdentity.count,101);result.stage='canonical-controls';
      const sessions=(await app.query('SELECT id,group_id,teacher_id,roster_snapshot_completed_at,class_name_snapshot,timezone_snapshot FROM teaching_sessions WHERE school_id=$1 AND end_time IS NULL',[school.id])).rows;
      const roster=(await app.query('SELECT r.student_id,r.teaching_session_id,r.group_id FROM classpilot_session_students r JOIN teaching_sessions t ON t.id=r.teaching_session_id AND t.school_id=r.school_id WHERE r.school_id=$1 AND t.end_time IS NULL',[school.id])).rows;
      const staff=(await app.query('SELECT r.staff_id,r.teaching_session_id,r.role FROM classpilot_session_staff r JOIN teaching_sessions t ON t.id=r.teaching_session_id AND t.school_id=r.school_id WHERE r.school_id=$1 AND t.end_time IS NULL',[school.id])).rows;
      const controls=(await app.query('SELECT student_id,teaching_session_id,supervision_context_id,source_command_id,desired_state,revision,hard_expires_at FROM classpilot_student_control_states WHERE school_id=$1',[school.id])).rows;
      validateReleaseControlRows(school,{sessions,roster,staff,controls},true);
      result.stage='authority-clock';
      const clocks=(await app.query(`SELECT
        (SELECT COUNT(*)::int FROM schools WHERE id=$1 AND is_active=true AND status='active' AND deleted_at IS NULL AND disabled_at IS NULL AND (active_until IS NULL OR active_until>clock_timestamp() AT TIME ZONE 'UTC')) AS schools,
        (SELECT COUNT(*)::int FROM product_licenses WHERE school_id=$1 AND product='CLASSPILOT' AND status='active' AND (expires_at IS NULL OR expires_at>clock_timestamp() AT TIME ZONE 'UTC')) AS licenses,
        (SELECT COUNT(*)::int FROM classpilot_student_control_states WHERE school_id=$1 AND hard_expires_at>clock_timestamp()) AS controls,
        (SELECT COUNT(*)::int FROM teaching_sessions WHERE school_id=$1 AND end_time IS NULL AND (scheduled_end_at IS NULL OR scheduled_end_at>clock_timestamp())) AS sessions`,[school.id])).rows[0];
      result.clockCounts=clocks;assert.deepEqual(clocks,{schools:1,licenses:1,controls:500,sessions:100});result.stage='live-bindings';
      const exact=(await app.query(`SELECT COUNT(*)::int AS count FROM unnest($2::text[],$3::text[],$4::text[]) AS expected(student_id,device_id,session_id)
        JOIN students s ON s.id=expected.student_id AND s.school_id=$1 AND s.status='active'
        JOIN devices d ON d.device_id=expected.device_id AND d.school_id=$1
        JOIN student_sessions ss ON ss.id=expected.session_id AND ss.student_id=s.id AND ss.device_id=d.device_id
        WHERE ss.is_active AND ss.ended_at IS NULL AND (ss.auth_kind<>'manual_shared' OR ss.manual_lease_expires_at>clock_timestamp())`,[school.id,school.students,school.devices,school.studentSessions])).rows[0];result.liveBindingCount=exact.count;assert.equal(exact.count,500);result.stage='heavy-bindings';
      const bindings=(await app.query(`WITH bindings AS (SELECT DISTINCT student_id,device_id FROM heartbeats WHERE school_id=$1 AND timestamp >=$2::timestamp AND timestamp<$3::timestamp)
        SELECT COUNT(*)::int AS pairs,COUNT(DISTINCT binding.device_id)::int AS devices,COUNT(*) FILTER(WHERE device.device_id IS NULL OR session.id IS NULL)::int AS invalid
        FROM bindings AS binding LEFT JOIN devices AS device ON device.device_id=binding.device_id AND device.school_id=$1
        LEFT JOIN student_sessions AS session ON session.student_id=binding.student_id AND session.device_id=binding.device_id
        LEFT JOIN students AS student ON student.id=binding.student_id AND student.school_id=$1 WHERE student.id IS NOT NULL`,[school.id,start,end])).rows[0];result.heavyBindingCounts=bindings;assert.deepEqual(bindings,{pairs:500,devices:500,invalid:0});result.stage='ai-bindings';
      const ai=(await app.query(`WITH decisions AS (SELECT * FROM classpilot_ai_decisions WHERE school_id=$1 AND created_at >=$2::timestamp AND created_at<$3::timestamp),per_student AS(SELECT student_id,COUNT(*)::int AS count FROM decisions GROUP BY student_id)
        SELECT COUNT(decision.id)::int AS rows,COUNT(DISTINCT decision.student_id)::int AS students,COUNT(DISTINCT decision.heartbeat_id)::int AS observations,
        COUNT(*) FILTER(WHERE heartbeat.id IS NULL OR heartbeat.school_id IS DISTINCT FROM decision.school_id OR heartbeat.student_id IS DISTINCT FROM decision.student_id OR heartbeat.device_id IS DISTINCT FROM decision.device_id OR heartbeat.active_tab_url IS DISTINCT FROM decision.url OR heartbeat.ai_category IS DISTINCT FROM decision.category OR heartbeat.teacher_intent_source IS DISTINCT FROM decision.teacher_intent_source OR decision.created_at IS DISTINCT FROM heartbeat.timestamp+interval '1 second')::int AS invalid,
        (SELECT MIN(count) FROM per_student) AS minperstudent,(SELECT MAX(count) FROM per_student) AS maxperstudent FROM decisions AS decision LEFT JOIN heartbeats AS heartbeat ON heartbeat.id=decision.heartbeat_id`,[school.id,start,end])).rows[0];
      result.aiBindingCounts=ai;assert.deepEqual(ai,{rows:10000,students:500,observations:10000,invalid:0,minperstudent:20,maxperstudent:20});
      await app.query('COMMIT');result.schools.push({index:school.index,raw:1000001,aggregates:541500,currentSessions:sessions.length,rosterRows:roster.length,staffBindings:staff.length,staffIdentities:staffIdentity.count,controls:controls.length,exactLiveBindings:exact.count,heavyBindings:bindings,ai,clocks});
    }
    result.stage='complete';result.passed=true;
  } finally {
    const closed=await Promise.allSettled([app.end(),admin.end()]);result.clientsClosed=closed.every(row=>row.status==='fulfilled');result.finishedAt=new Date().toISOString();
    assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),source);
    assert.equal(execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim(),'');
    writeFileSync(config.resultFile,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
    assert.equal(result.clientsClosed,true,'Validation client closure must be confirmed');
  }
  return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  validateSnapshotDatabase(JSON.parse(readFileSync(process.argv[2],'utf8'))).then(r=>console.log(JSON.stringify({event:'snapshot_database_validation',passed:r.passed,clientsClosed:r.clientsClosed,schools:r.schools.length}))).catch(e=>{console.error(JSON.stringify({event:'snapshot_database_validation_failed',name:e.name,code:/^[A-Z0-9_]+$/.test(e.code||'')?e.code:'VALIDATION_FAILED'}));process.exitCode=1;});
}
