import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';
import {hash} from './contracts.mjs';
import {replaceOnce} from '../roles/patch-coordinator.mjs';

// The historical restore ABI remains immutable. This strict overlay changes
// only module resolution and owned PostgreSQL cleanup for new v2 campaigns.
export function gracefulSnapshotOverlay(original,originalUrl){
  let source=original.replaceAll('\r\n','\n');
  source=source.replace(/from '((?:\.\.\/|\.\/)[^']+)'/g,(_,specifier)=>`from '${new URL(specifier,originalUrl).href}'`);
  source=replaceOnce(source,'const ownDirectory=dirname(fileURLToPath(import.meta.url));',`const ownDirectory=${JSON.stringify(dirname(fileURLToPath(originalUrl)))};`);
  source=replaceOnce(source,"let created=false,id=null,passed=false,stage='create',failure=null,value;","let created=false,id=null,passed=false,stage='create',failure=null,value;let v2StoppedState=null;");
  source=replaceOnce(source,"remove:actualId=>call(['rm','--force','--volumes',actualId],{log:'remove.log'})",`remove:actualId=>{
    const owned=verify(find());assert.equal(owned.Id,actualId);
    if(owned.State.Running)call(['stop','--time','30',actualId],{log:'v2-clean-stop.log'});
    const stopped=verify(find()).State;assert.equal(stopped.Running,false);assert.equal(stopped.ExitCode,0);assert.equal(stopped.OOMKilled,false);
    v2StoppedState=stopped;return call(['rm','--volumes',actualId],{log:'remove.log'});
  }`);
  source=replaceOnce(source,"saveReceipt:receipt=>save(output,'cleanup.json',receipt)","saveReceipt:receipt=>save(output,'cleanup.json',{...receipt,forced:false,stopped:v2StoppedState,cleanupPassed:receipt.cleanupPassed&&(!created||v2StoppedState?.ExitCode===0)})");
  assert.ok(!source.includes("call(['rm','--force'"));return source;
}
export async function withUsageSnapshotV2(options,useFixture){
  const url=new URL('../roles/restore-snapshot.mjs',import.meta.url),original=readFileSync(url,'utf8'),overlay=gracefulSnapshotOverlay(original,url);
  const module=await import('data:text/javascript;base64,'+Buffer.from(overlay).toString('base64'));
  return module.withRestoredSnapshot(options,async context=>{
    writeFileSync(join(context.output,'v2-restore-overlay.json'),JSON.stringify({originalSha256:hash(original),overlaySha256:hash(overlay),
      originalAbiUnchanged:true,gracefulOwnedStopRequired:true,forcedRemovalAllowed:false,capacityAcceptance:false},null,2)+'\n',{flag:'wx'});
    return useFixture(context);
  });
}
