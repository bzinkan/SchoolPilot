import assert from 'node:assert/strict';
import {assertExecutionMode} from './profile.mjs';
export const FIXTURE_KEYS=Object.freeze([
 'DATABASE_URL','ADMIN_DATABASE_URL','DATABASE_URL_PRIVILEGED','JWT_SECRET','SESSION_SECRET','STUDENT_TOKEN_SECRET',
 'NODE_ENV','REDIS_URL','RLS_GUC_ENABLED','RLS_ENABLED_TABLES','SCHEDULER_ENABLED','USAGE_LOCAL_SCALE',
 'USAGE_SCALE_CONTAINER','USAGE_SOURCE_REVISION','USAGE_SCALE_COLD_STATE_SHA256','USAGE_SCALE_RLS_INVENTORY',
 'CLASSPILOT_USAGE_ROLLUP_MODE','CLASSPILOT_DIGITAL_USAGE_MODE','CLASSPILOT_DAILY_USAGE_ROLLUP_MODE',
 'CLASSPILOT_SHARED_TEACHING_RESOURCES_MODE','PASSPILOT_RULES_MODE','PASSPILOT_APPOINTMENTS_MODE','PASSPILOT_REPORTS_MODE',
 'RUN_LEGACY_MIGRATIONS_ONLY','RUN_MIGRATIONS_ONLY',
]);
const CAPABILITIES=['SCOPED_AUTHORITY_CHECKS_V1','STUDENT_CHAT_IDEMPOTENCY_V1','PRECISE_RESTRICTION_RESOURCES_V1','FOCUS_TAB_V1','PRIVATE_CHAT_LIFECYCLE_V1','SCHEDULED_CLASSROOM_V1','LATE_SIGNIN_RESTRICTION_SSO_V1','RESTRICTION_AUTH_PASS_THROUGH_V1','SCREENSHOT_TRACKING_WINDOW_LEASE_V1','SCREENSHOT_ACTIVE_OBSERVATION_CADENCE_V1','SCREENSHOT_OBSERVATION_LEASE_V1'];
export const ENV_KEYS=Object.freeze([...FIXTURE_KEYS,...CAPABILITIES.map(value=>`CLASSPILOT_CAP_${value}`),
 'CLASSPILOT_PROTOCOL_V3_ENABLED','CLASSPILOT_SCHEDULED_CLASSROOM_MODE','CLASSPILOT_CAPABILITY_ROLLOUTS_JSON','CLASSPILOT_SCHEDULED_CLASSROOM_SCHOOL_IDS','CLASSPILOT_SCHEDULED_CLASSROOM_EXCLUDED_SCHOOL_IDS',
 'DB_POOL_MAX','SESSION_DB_POOL_MAX','SCHEDULER_DB_POOL_MAX','SCHEDULER_LOCK_POOL_MAX','USAGE_RELEASE_ROLE','PGAPPNAME',
 'USAGE_RELEASE_ROLE_CONTAINERS','USAGE_RELEASE_LINUX_DIAGNOSTIC','USAGE_RELEASE_DIAGNOSTIC','USAGE_RELEASE_CPU_PROFILE','USAGE_RELEASE_PHASE','USAGE_RELEASE_MODE',
 'USAGE_SCALE_OUTPUT','USAGE_SCALE_CAPS','USAGE_SCALE_COLD_STATE','DOTENV_CONFIG_PATH','DOTENV_CONFIG_QUIET','GIT_OPTIONAL_LOCKS',
]);
export function assertEnvironmentKeys(keys){assert.ok(Array.isArray(keys));assert.equal(new Set(keys).size,keys.length);for(const key of keys)assert.ok(ENV_KEYS.includes(key),`Unexpected fixture environment key: ${key}`);}
export function makeRoleEnvironment({role,run,source,environment,enabledReleaseEnvironment,pgApplicationNames,mode='diagnostic'}){
 assert.ok(['api','worker','generator','coordinator'].includes(role));assert.match(run,/^[a-f0-9]{12}$/);assert.match(source,/^[a-f0-9]{40}$/);
 const base=Object.fromEntries(FIXTURE_KEYS.filter(key=>typeof environment[key]==='string').map(key=>[key,environment[key]]));
 for(const key of ['DATABASE_URL','ADMIN_DATABASE_URL','DATABASE_URL_PRIVILEGED']){const url=new URL(base[key]);assert.ok(['postgres:','postgresql:'].includes(url.protocol));assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'5437');assert.equal(url.pathname,`/schoolpilot_redesign_usage_scale_${run}`);assert.equal(url.search,'');assert.equal(url.hash,'');}
 assert.equal(base.REDIS_URL,'redis://127.0.0.1:6387');assert.equal(base.NODE_ENV,'test');assert.equal(base.USAGE_LOCAL_SCALE,'1');assert.equal(base.USAGE_SOURCE_REVISION,source);assert.equal(base.USAGE_SCALE_CONTAINER,`schoolpilot-usage-scale-${run}`);
 const phase=environment.USAGE_RELEASE_PHASE;
 assert.ok(['combined','ingest'].includes(phase),'Explicit supported workload phase is required');
 assert.ok(['true','false'].includes(environment.USAGE_RELEASE_CPU_PROFILE),'Explicit CPU profiling mode is required');
 const collectApiCpuProfile=environment.USAGE_RELEASE_CPU_PROFILE==='true';
 const execution=assertExecutionMode({mode,phase,cpuProfile:collectApiCpuProfile});
 if(phase==='ingest')assert.equal(environment.USAGE_RELEASE_DIAGNOSTIC,'true');
 if(collectApiCpuProfile){assert.equal(environment.USAGE_RELEASE_PHASE,'ingest');assert.equal(environment.USAGE_RELEASE_DIAGNOSTIC,'true');}
 const enabled=enabledReleaseEnvironment(base);assertEnvironmentKeys(Object.keys(enabled));
 const env={...enabled,USAGE_RELEASE_ROLE:role,SCHEDULER_ENABLED:role==='worker'?'true':'false',
  ...(pgApplicationNames[role]?{PGAPPNAME:pgApplicationNames[role]}:{}),
  USAGE_RELEASE_ROLE_CONTAINERS:'true',USAGE_RELEASE_LINUX_DIAGNOSTIC:execution.diagnosticOnly?'true':'false',USAGE_RELEASE_DIAGNOSTIC:execution.diagnosticOnly?'true':'false',USAGE_RELEASE_CPU_PROFILE:'false',USAGE_RELEASE_PHASE:phase,USAGE_RELEASE_MODE:mode,
  USAGE_SCALE_OUTPUT:'/evidence/usage-scale.json',USAGE_SCALE_CAPS:'/evidence/resource-caps.json',USAGE_SCALE_COLD_STATE:'/evidence/cold-fixture-state.json',DOTENV_CONFIG_PATH:'/nonexistent-diagnostic-dotenv',DOTENV_CONFIG_QUIET:'true',GIT_OPTIONAL_LOCKS:'0'};
 assert.equal(env.DB_POOL_MAX,'16');assert.equal(env.SESSION_DB_POOL_MAX,'2');assert.equal(env.SCHEDULER_DB_POOL_MAX,'5');assert.equal(env.SCHEDULER_LOCK_POOL_MAX,'8');assertEnvironmentKeys(Object.keys(env));
 return env; // Private launch input: never serialize values in public evidence.
}
export function inheritWorkloadContract(profile,openLoop){
 assert.deepEqual(profile.httpOffering,openLoop);
 return structuredClone({profile:profile.name,httpOffering:profile.httpOffering,reportOffers:profile.reportOffers,fullWorkerAcceptanceMs:profile.fullWorkerAcceptanceMs,publicRequestDeadlineMs:profile.publicRequestDeadlineMs,
  pools:{api:profile.apiMainPool,session:profile.apiSessionPool,worker:profile.workerPool,observer:profile.observerPool}});
}
