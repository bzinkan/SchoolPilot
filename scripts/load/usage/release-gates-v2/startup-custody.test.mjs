import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,mkdirSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {ownRole} from './owner.mjs';
import {BASELINE_COMPATIBILITY_SOURCE,BASELINE_COMPATIBILITY_SUCCESSOR} from './baseline-environment-compatibility.mjs';
import {hash} from './contracts.mjs';

test('v3 startup failure retains bound native state and private logs before caller cleanup, never claims acceptance',async()=>{
  for(const mode of ['fatal','logs-unavailable','historical']){
    const root=mkdtempSync(join(tmpdir(),'release297-startup-custody-')),control=join(root,'private'),output=join(root,'output');mkdirSync(control);mkdirSync(output);
    const run='a'.repeat(12),id='b'.repeat(64),image='sha256:'+'c'.repeat(64),containerImage='sha256:'+'d'.repeat(64),pg='e'.repeat(64),role='api0',source=BASELINE_COMPATIBILITY_SOURCE;
    const operations=[],rawLog='FATAL: synthetic unsupported rollout map\n';let started=false;
    const docker=async args=>{
      operations.push(args[0]);
      if(args[0]==='create')return id;
      if(args[0]==='start'){started=true;return '';}
      if(args[0]==='logs'){if(mode==='logs-unavailable')throw Error('synthetic transport detail');return rawLog;}
      if(args[0]==='inspect')return JSON.stringify([{Id:id,Name:`/schoolpilot-release297-v2-${role}-${run}`,Image:containerImage,
        Config:{Image:image,Labels:{'codex.release297-v2':run,'codex.release297-role':role,'codex.release297-source':source}},
        HostConfig:{NetworkMode:'container:'+pg,NanoCpus:1e9,Memory:1024,MemorySwap:1024,Privileged:false,ReadonlyRootfs:true},
        State:{Running:!started,ExitCode:started?1:0,OOMKilled:false}}]);
      throw Error('Unexpected Docker mutation');
    };
    try{
      let failure;
      await assert.rejects(ownRole({docker,run,source,helperImage:image,helperConfigDigest:containerImage,helperContainerImage:containerImage,
        preparation:{executedFiles:{'scripts/load/usage/release-gates-v2/blackbox-api.mjs':'f'.repeat(64)}},pgContainerId:pg,role,
        entryFile:'/harness/blackbox-api.mjs',environment:{NODE_ENV:'test'},privateDirectory:control,outputDirectory:output,cpu:1,memory:1024,
        ...(mode==='historical'?{}:{startupEvidenceContext:{id:BASELINE_COMPATIBILITY_SUCCESSOR,candidateSource:'2001e8888992674493c3084981fa8aae27d70e1d'}})}),error=>{failure=error;return error.message==='V2_ROLE_EXITED_BEFORE_RESPONSE';});
      assert.equal(operations.includes('rm'),false);assert.equal(operations.includes('kill'),false);
      if(mode==='historical'){assert.equal(failure.startupFailureEvidence,undefined);assert.deepEqual(readdirSync(output),[]);assert.equal(operations.includes('logs'),false);continue;}
      const evidence=failure.startupFailureEvidence,receipt=JSON.parse(readFileSync(evidence.receipt.file,'utf8'));
      assert.equal(evidence.receipt.sha256,hash(readFileSync(evidence.receipt.file)));
      assert.deepEqual(receipt.actualState,{running:false,exitCode:1,oomKilled:false});
      assert.deepEqual([receipt.run,receipt.source,receipt.containerId,receipt.startupFailed,receipt.cleanupVerified,receipt.acceptancePassed],[run,source,id,true,false,false]);
      assert.equal(receipt.inspect.sha256,hash(readFileSync(receipt.inspect.file)));
      if(mode==='fatal'){assert.equal(readFileSync(receipt.logs.file,'utf8'),rawLog);assert.equal(receipt.logs.sha256,hash(rawLog));assert.equal(receipt.captureComplete,true);}
      else{assert.equal(receipt.logsAvailable,false);assert.equal(receipt.captureComplete,false);assert.equal(receipt.logsFailure,'STARTUP_NATIVE_LOGS_UNAVAILABLE');assert.equal(JSON.stringify(receipt).includes('synthetic transport detail'),false);}
    }finally{assert.ok(resolve(root).startsWith(resolve(tmpdir())));rmSync(root,{recursive:true,force:true});}
  }
});
