import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import pg from "pg";
import { CLASSPILOT_NATIVE_VISIBILITY_SQL } from "../src/db/classpilotNativeVisibilityMigration.js";
import { CLASSPILOT_WINDOWS_BROWSER_SQL } from "../src/db/classpilotWindowsBrowserMigration.js";
import { CLASSPILOT_WINDOWS_HISTORY_SQL } from "../src/db/classpilotWindowsHistoryMigration.js";

const tables=["classpilot_windows_guards","classpilot_windows_browsers","classpilot_windows_pairing_proofs","classpilot_windows_commands","classpilot_windows_command_targets","classpilot_windows_browser_events"];
test("Windows browser identities and evidence use forced RLS and exact same-student parents",async t=>{
  const url=process.env.ADMIN_DATABASE_URL;assert.ok(url,"Explicit isolated local database required");assert.ok(["localhost","127.0.0.1","[::1]"].includes(new URL(url).hostname));
  const client=new pg.Client({connectionString:url});const role=`windows_rls_${randomUUID().replaceAll("-","")}`;const hash="a".repeat(64);
  const schools=[0,1].map(()=>({school:randomUUID(),student:randomUUID(),otherStudent:randomUUID(),enrollment:randomUUID(),installation:randomUUID(),guard:randomUUID(),browser:randomUUID(),source:randomUUID(),proof:randomUUID(),command:randomUUID(),target:randomUUID(),event:randomUUID()}));
  await client.connect();try{
    await client.query("BEGIN");await client.query(CLASSPILOT_NATIVE_VISIBILITY_SQL);await client.query(CLASSPILOT_WINDOWS_BROWSER_SQL);await client.query(CLASSPILOT_WINDOWS_HISTORY_SQL);
    await client.query(`CREATE ROLE ${role} NOSUPERUSER NOBYPASSRLS NOINHERIT NOLOGIN`);await client.query(`GRANT USAGE ON SCHEMA public TO ${role};GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
    await client.query("SELECT set_config('app.is_super','on',true)");
    for(const row of schools){
      await client.query("INSERT INTO schools(id,name,domain,status,plan_status) VALUES($1,'Windows synthetic RLS',$2,'active','active')",[row.school,`${row.school}.example.edu`]);
      for(const student of[row.student,row.otherStudent])await client.query("INSERT INTO students(id,school_id,first_name,last_name,status) VALUES($1,$2,'Synthetic','Student','active')",[student,row.school]);
      await client.query("INSERT INTO classpilot_native_enrollment_tokens(id,school_id,token_hash,issued_by,expires_at) VALUES($1,$2,$3,'synthetic-admin',now()+interval '10 minutes')",[row.enrollment,row.school,hash]);
      await client.query("INSERT INTO classpilot_native_installations(id,school_id,credential_hash,enrollment_token_id,client_version) VALUES($1,$2,$3,$4,'test')",[row.installation,row.school,hash,row.enrollment]);
      await client.query("INSERT INTO classpilot_windows_guards(id,school_id,installation_id,student_id,credential_hash,student_credential_fingerprint,os_session_nonce,expires_at,absolute_expires_at) VALUES($1,$2,$3,$4,$5,$5,$6,now()+interval '45 seconds',now()+interval '8 hours')",[row.guard,row.school,row.installation,row.student,hash,randomUUID()]);
      await client.query("INSERT INTO classpilot_windows_browsers(id,school_id,guard_id,student_id,browser_family,profile_id,credential_hash,source_ref,client_protocol_version,extension_version,accepted_capabilities) VALUES($1,$2,$3,$4,'chrome',$5,$6,$7,3,'3.0.3','[]')",[row.browser,row.school,row.guard,row.student,randomUUID(),hash,row.source]);
      await client.query("INSERT INTO classpilot_windows_pairing_proofs(id,school_id,guard_id,browser_family,profile_id,challenge,token_hash,expires_at) VALUES($1,$2,$3,'edge',$4,$5,$6,now()+interval '60 seconds')",[row.proof,row.school,row.guard,randomUUID(),"a".repeat(43),hash]);
      await client.query("INSERT INTO classpilot_windows_commands(id,school_id,actor_id,teaching_session_id,command_type,payload,expires_at) VALUES($1,$2,'synthetic-admin',$3,'open-tab','{}',now()+interval '15 seconds')",[row.command,row.school,randomUUID()]);
      await client.query("INSERT INTO classpilot_windows_command_targets(id,school_id,command_id,browser_id,student_id,source_ref,binding_revision,control_revision) VALUES($1,$2,$3,$4,$5,$6,1,1)",[row.target,row.school,row.command,row.browser,row.student,row.source]);
      await client.query("INSERT INTO classpilot_windows_browser_events(id,school_id,student_id,browser_id,source_ref,binding_revision,observation_id,sequence,observed_at,usage_ends_at,browser_focused,active_tab_url,active_tab_title,teaching_session_id) VALUES($1,$2,$3,$4,$5,1,$6,1,now(),now()+interval '5 seconds',true,'https://example.edu','Synthetic',gen_random_uuid())",[row.event,row.school,row.student,row.browser,row.source,randomUUID()]);
    }
    await client.query(`SET LOCAL ROLE ${role}`);await client.query("SELECT set_config('app.is_super','',true),set_config('app.school_id','',true)");
    const denied=async(code:string,statement:string,values:unknown[])=>{await client.query("SAVEPOINT expected_windows_denial");try{await assert.rejects(client.query(statement,values),{code});}finally{await client.query("ROLLBACK TO SAVEPOINT expected_windows_denial");}};
    await t.test("actual role cannot bypass and all six tables force read/write tenant policies",async()=>{
      assert.deepEqual((await client.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows,[{rolsuper:false,rolbypassrls:false}]);
      const rows=await client.query("SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,p.polqual IS NOT NULL AS reads,p.polwithcheck IS NOT NULL AS writes FROM pg_class c JOIN pg_policy p ON p.polrelid=c.oid WHERE c.relname=ANY($1::text[]) AND p.polname='tenant_isolation'",[tables]);assert.equal(rows.rowCount,6);assert.ok(rows.rows.every(r=>r.relrowsecurity&&r.relforcerowsecurity&&r.reads&&r.writes));
    });
    await t.test("no tenant reveals nothing; exact school reads and updates cannot cross school",async()=>{
      for(const table of tables)assert.equal((await client.query(`SELECT id FROM ${table}`)).rowCount,0);
      await client.query("SELECT set_config('app.school_id',$1,true)",[schools[0]!.school]);
      for(const table of tables)assert.equal((await client.query(`SELECT id FROM ${table}`)).rowCount,1);
      assert.equal((await client.query("UPDATE classpilot_windows_guards SET ended_at=now() WHERE id=$1",[schools[1]!.guard])).rowCount,0);
    });
    await t.test("cross-school insertion and same-school different-student parent splicing fail",async()=>{
      const own=schools[0]!,other=schools[1]!;
      await denied("42501","INSERT INTO classpilot_windows_commands(id,school_id,actor_id,teaching_session_id,command_type,payload,expires_at) VALUES($1,$2,'synthetic',$3,'open-tab','{}',now()+interval '15 seconds')",[randomUUID(),other.school,randomUUID()]);
      await denied("23503","UPDATE classpilot_windows_browsers SET student_id=$1 WHERE id=$2",[own.otherStudent,own.browser]);
      await denied("23503","UPDATE classpilot_windows_command_targets SET student_id=$1 WHERE id=$2",[own.otherStudent,own.target]);
      await denied("23503","UPDATE classpilot_windows_browser_events SET student_id=$1 WHERE id=$2",[own.otherStudent,own.event]);
      await denied("23503","UPDATE classpilot_windows_pairing_proofs SET guard_id=$1 WHERE id=$2",[other.guard,own.proof]);
    });
    await t.test("proof expiry bound and one active profile/family remain database constraints",async()=>{
      const own=schools[0]!;
      await denied("23514","UPDATE classpilot_windows_pairing_proofs SET expires_at=created_at+interval '61 seconds' WHERE id=$1",[own.proof]);
      await denied("23505","INSERT INTO classpilot_windows_browsers(id,school_id,guard_id,student_id,browser_family,profile_id,credential_hash,source_ref,client_protocol_version,extension_version,accepted_capabilities) VALUES($1,$2,$3,$4,'chrome',$5,$6,$7,3,'3.0.3','[]')",[randomUUID(),own.school,own.guard,own.student,randomUUID(),hash,randomUUID()]);
    });
  }finally{await client.query("ROLLBACK").catch(()=>undefined);await client.end();}
});
