import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {assertLocalScaleFixture} from '../local-usage-scale.mjs';
import {assertReviewedUsageSource,assertUsageSourceCheckout,assertUsageSourceDatabase,loadFixtureUsageSourceBinding} from './usage-source-binding.mjs';

// The ordinary test-mode index also runs contract migrations from its legacy
// bootstrap. A reviewed successor must instead execute the selected ordered
// declarative plan directly with the unchanged production ledger executor.
export async function migrateBoundUsageFixture({envelope,manifest,pool,executeLedger,registrySha256}){
  const binding=assertReviewedUsageSource(envelope).binding;
  const migrations=manifest[binding.migrationStage==='expand'?'schoolPilot27ExpandMigrations':'schoolPilot27Migrations'];
  assert.ok(Array.isArray(migrations));
  const declared=migrations.map(({id,checksum})=>({id,checksum,status:'complete'})).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  assert.deepEqual(declared,binding.expectedMigrations,'Compiled fixture manifest differs from reviewed source/stage');
  assert.equal(registrySha256,binding.registrySha256);
  assert.equal((await pool.query('SELECT id,checksum,status FROM schema_migrations ORDER BY id')).rows.length,0,'Require a fresh schema-only fixture, not an existing migration ledger');
  await executeLedger({pool,migrations,applicationSha:binding.source});
  const actual=(await pool.query('SELECT id,checksum,status FROM schema_migrations ORDER BY id')).rows;
  const catalog=(await pool.query("SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relnamespace='public'::regnamespace AND relname=ANY($1::text[]) ORDER BY relname",[binding.rlsTables])).rows;
  assert.ok(catalog.every(row=>row.relrowsecurity&&row.relforcerowsecurity),'Every reviewed table must retain FORCE RLS');
  assertUsageSourceDatabase(envelope,{migrations:actual,tables:catalog.map(row=>row.relname),registrySha256});
  return {schemaVersion:1,source:binding.source,bindingSha256:envelope.bindingSha256,migrationStage:binding.migrationStage,
    migrationManifestSha256:binding.migrationManifestSha256,completedMigrations:actual.length,admittedTables:catalog.length,
    stageVerified:true,capacityAccepted:false,productionReadiness:false,operationalAuthorization:false};
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  let pool;
  try{
    assertLocalScaleFixture(process.env);const envelope=loadFixtureUsageSourceBinding(process.env);assert.ok(envelope);
    const root=resolve(process.argv[2]);assertUsageSourceCheckout(envelope,root);
    const fixtureUser='scale_fixture_'+process.env.USAGE_SCALE_CONTAINER.slice(-12);
    for(const key of ['DATABASE_URL','ADMIN_DATABASE_URL'])assert.equal(new URL(process.env[key]).username,fixtureUser);
    const {Pool}=createRequire(join(root,'package.json'))('pg');
    const manifest=await import(pathToFileURL(join(root,'dist/db/migrations27.js')));
    const {runSchoolPilotMigrationLedger}=await import(pathToFileURL(join(root,'dist/db/migrationLedger.js')));
    const {hash}=await import('./contracts.mjs');
    pool=new Pool({connectionString:process.env.ADMIN_DATABASE_URL,max:2,connectionTimeoutMillis:5000,statement_timeout:120000});
    const result=await migrateBoundUsageFixture({envelope,manifest,pool,executeLedger:runSchoolPilotMigrationLedger,
      registrySha256:hash(readFileSync(join(root,'src/config/rlsRegistry.json')))});
    process.stdout.write(JSON.stringify(result)+'\n');
  }catch{process.stderr.write('USAGE_BOUND_FIXTURE_MIGRATIONS_FAILED\n');process.exitCode=1;}
  finally{if(pool)await pool.end();}
}
