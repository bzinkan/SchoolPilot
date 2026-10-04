import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export async function cleanupFixtures(adapter, {run, resources}) {
  assert.match(run,/^[a-f0-9]{12}$/); const results=[];
  for (const resource of resources) {
    const result={role:resource.role,removed:false,cleanupPassed:false}; results.push(result);
    try {
      const prefix={harness:'schoolpilot-usage-linux-',redis:'schoolpilot-usage-redis-',postgres:'schoolpilot-usage-scale-'}[resource.role];
      assert.ok(prefix); assert.equal(resource.name,prefix+run);
      const current=await adapter.inspect(resource.name);
      if(current===null){result.confirmedAbsent=true;result.cleanupPassed=true;continue;}
      assert.equal(current.Name,`/${resource.name}`); assert.equal(current.Config?.Labels?.['codex.usage-scale'],run);
      assert.match(resource.image,/^sha256:[a-f0-9]{64}$/); assert.equal(current.Config?.Image,resource.image);
      const identities=resource.imageIdentities??[resource.image];assert.ok(identities.includes(resource.image));
      for(const identity of identities)assert.match(identity,/^sha256:[a-f0-9]{64}$/);
      assert.ok(identities.includes(current.Image));
      await adapter.remove(current.Id);
      assert.equal(await adapter.inspect(resource.name),null); result.removed=true;result.cleanupPassed=true;
    } catch {result.failure='OWNED_FIXTURE_CLEANUP_UNCONFIRMED';}
  }
  return {cleanupPassed:results.every(row=>row.cleanupPassed),resources:results};
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [docker,endpoint,run,output,harnessImage,redisImage,pgImage,harnessIdentitiesJson]=process.argv.slice(2);
  assert.match(endpoint,/^(?:npipe:\/{2,4}\.\/pipe\/[a-zA-Z0-9_.-]+|unix:\/\/\/[^\s?#]+)$/);
  const env={...process.env};for(const key of ['DOCKER_CONTEXT','DOCKER_HOST','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH','DOCKER_TLS'])delete env[key];
  const invoke=args=>execFileSync(docker,['--host',endpoint,...args],{env,timeout:30000,encoding:'utf8',stdio:['ignore','pipe','pipe'],windowsHide:true});
  const result=await cleanupFixtures({inspect:async name=>{
    const ids=invoke(['container','ls','--all','--filter',`name=^/${name}$`,'--format','{{.ID}}']).trim().split('\n').filter(Boolean);assert.ok(ids.length<=1);
    return ids.length?JSON.parse(invoke(['container','inspect',ids[0]]))[0]:null;
  },remove:async id=>{invoke(['container','rm','--force','--volumes',id]);}}, {run,resources:[
    {role:'harness',name:`schoolpilot-usage-linux-${run}`,image:harnessImage,imageIdentities:JSON.parse(harnessIdentitiesJson)},
    {role:'redis',name:`schoolpilot-usage-redis-${run}`,image:redisImage},
    {role:'postgres',name:`schoolpilot-usage-scale-${run}`,image:pgImage},
  ]});
  writeFileSync(resolve(output,'all-owned-linux-fixtures-cleanup.json'),JSON.stringify(result,null,2)+'\n');
  process.exitCode=result.cleanupPassed?0:1;
}
