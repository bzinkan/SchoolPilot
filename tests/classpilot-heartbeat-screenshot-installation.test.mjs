import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {assertClasspilotHeartbeatScreenshotEvidence as verify, grantClasspilotHeartbeatScreenshotEvidence as grant, installClasspilotHeartbeatScreenshotEvidence as install} from '../src/db/classpilotHeartbeatScreenshotEvidenceInstallation.ts';
import {CLASSPILOT_HEARTBEAT_SCREENSHOT_EVIDENCE_BODY as body,CLASSPILOT_HEARTBEAT_SCREENSHOT_EVIDENCE_SQL as sql} from '../src/db/classpilotHeartbeatScreenshotEvidenceDefinition.ts';
import {classpilotHeartbeatScreenshotEvidenceMigration as migration,CLASSPILOT_HEARTBEAT_SCREENSHOT_EVIDENCE_MIGRATION_CONTRACT as contract} from '../src/db/classpilotHeartbeatScreenshotEvidenceMigration.ts';
import {schoolPilot27Migrations} from '../src/db/migrations27.ts';
import {assertLocalScreenshotEvidenceFixture as local} from '../src/cli/prepareClasspilotHeartbeatScreenshotEvidence.ts';
const hash=text=>createHash('sha256').update(text).digest('hex');
const good=()=>({body,language:'plpgsql',volatility:'v',securityDefiner:false,parallel:'u',kind:'f',returnsSet:false,strict:false,leakproof:false,defaultArguments:0,resultType:'jsonb',configuration:['search_path=pg_catalog'],argumentNames:['p_school_id','p_student_id','p_session_id','p_device_id'],executable:true,publicExecute:false});
const client=row=>({query:async()=>({rows:row?[row]:[]})});

test('immutable CREATE bytes and append-only migration bind the explicit PUBLIC revoke',()=>{
  assert.equal(hash(sql),'10a2bf7377afc98c1d4a9f9a54afba740a97ab408dcb3df7bbb5dd019c964e76');
  assert.equal(migration.checksum,hash(contract));assert.match(contract,/REVOKE ALL ON FUNCTION public\.classpilot_heartbeat_screenshot_evidence_v1\(text,text,text,text\) FROM PUBLIC;/);
  assert.equal(schoolPilot27Migrations.length,54);assert.equal(schoolPilot27Migrations.at(-1),migration);
});
test('actual runtime catalog assertion is read only and accepts the exact invoker contract',async()=>{await verify(client(good()));});
for(const [field,value] of Object.entries({body:body+' ',language:'sql',volatility:'s',securityDefiner:true,parallel:'s',kind:'p',returnsSet:true,strict:true,leakproof:true,defaultArguments:1,resultType:'text',configuration:['search_path=public'],argumentNames:['wrong'],executable:false,publicExecute:true})){
  test(`runtime rejects ${field} drift`,async()=>{await assert.rejects(verify(client({...good(),[field]:value})));});
}
test('missing function and incompatible existing body fail closed without replacement',async()=>{
  await assert.rejects(verify(client(undefined)));
  const calls=[];await assert.rejects(install({query:async text=>{calls.push(text);return{rows:[{...good(),body:'changed'}]};}}));assert.equal(calls.length,1);
});
test('installer creates only absent exact version and then removes PUBLIC execute',async()=>{
  const calls=[];let installed=false;
  await install({query:async text=>{calls.push(text);if(text===sql)installed=true;return{rows:text.includes('pg_proc')&&installed?[good()]:[]};}});
  assert.equal(calls.filter(text=>text===sql).length,1);assert.match(calls[2],/^REVOKE ALL ON FUNCTION/);
});
test('grant quotes one existing exact role and cannot inject another statement',async()=>{
  const role='fixture"; GRANT ALL TO PUBLIC; --',calls=[];
  await grant({query:async(text,values)=>{calls.push([text,values]);return{rows:text.includes('pg_roles')?[{rolname:role}]:[good()]};}},role);
  assert.deepEqual(calls[0][1],[role]);assert.equal(calls.at(-1)[0],`GRANT EXECUTE ON FUNCTION public.classpilot_heartbeat_screenshot_evidence_v1(text,text,text,text) TO "fixture""; GRANT ALL TO PUBLIC; --"`);
  await assert.rejects(grant({query:async()=>({rows:[]})},'missing'));
});
const environment={ADMIN_DATABASE_URL:'postgresql://owner:test@127.0.0.1:5437/schoolpilot_redesign_usage_scale_012345abcdef',DATABASE_URL:'postgresql://runtime:test@127.0.0.1:5437/schoolpilot_redesign_usage_scale_012345abcdef'};
test('local fixture CLI accepts explicit different users on exactly the same disposable database',()=>assert.deepEqual(local(environment),{adminUrl:environment.ADMIN_DATABASE_URL,appUrl:environment.DATABASE_URL}));
for(const delta of [{NODE_ENV:'production'},{DATABASE_URL:undefined},{DATABASE_URL:'postgresql://u:p@db.example.test/sptest'},{DATABASE_URL:environment.DATABASE_URL+'?host=remote'},{DATABASE_URL:environment.DATABASE_URL+'#fragment'},{DATABASE_URL:'postgresql://u:p@127.0.0.1:5437/production'},{DATABASE_URL:environment.DATABASE_URL.replace('5437','5438')},{DATABASE_URL:environment.DATABASE_URL.replace('postgresql:','https:')}]){
  test('local fixture guard rejects unsafe '+JSON.stringify(Object.keys(delta)),()=>assert.throws(()=>local({...environment,...delta})));
}
test('real server and isolated createApp startup prove runtime contract before serving; restore reapplies exact ACL',()=>{
  const index=readFileSync(new URL('../src/index.ts',import.meta.url),'utf8');const start=index.slice(index.indexOf('async function startServer()'),index.indexOf('async function runMigrationsAndExit()'));
  assert.ok(start.indexOf('await assertClasspilotHeartbeatScreenshotEvidence(pool)')<start.indexOf('const app = createApp()'));
  const child=readFileSync(new URL('../scripts/load/usage/release-enabled-process.mjs',import.meta.url),'utf8');assert.ok(child.indexOf('await assertClasspilotHeartbeatScreenshotEvidence(mainPool)')<child.indexOf('server = createServer(createApp())'));
  const restore=readFileSync(new URL('../scripts/load/usage/roles/restore-snapshot.mjs',import.meta.url),'utf8');assert.ok(restore.indexOf('grantClasspilotHeartbeatScreenshotEvidence(functionOwner,role)')>restore.indexOf("'--no-privileges'"));assert.ok(restore.includes('await assertClasspilotHeartbeatScreenshotEvidence(functionRuntime)'));
});

test('both actual fixture close branches settle both clients and refuse a failed close',async()=>{
  const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
  for(const [file,names] of [['../src/cli/prepareClasspilotHeartbeatScreenshotEvidence.ts',['app','admin']],['../scripts/load/usage/roles/restore-snapshot.mjs',['functionRuntime','functionOwner']]]){
    const source=readFileSync(new URL(file,import.meta.url),'utf8');
    const body=source.match(/const closed\s*=\s*await Promise\.allSettled\([^;]+;\s*(?:if\s*\([^\n]+|assert\.ok\([^\n]+)/)?.[0];assert.ok(body);
    const close=new AsyncFunction(...names,'assert',body);
    for(const failed of [0,1]){
      const calls=[];const clients=[0,1].map(index=>({end:async()=>{calls.push(index);if(index===failed)throw Error('synthetic close failure');}}));
      await assert.rejects(close(...clients,assert));assert.deepEqual(calls,[0,1]);
    }
    await close({end:async()=>{}},{end:async()=>{}},assert);
  }
});
