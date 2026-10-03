import assert from 'node:assert/strict';
export async function verifyImageProbe(found,{name,imageId,image},inspectImage){
  assert.equal(found.Name,`/${name}`);assert.match(found.Id,/^[a-f0-9]{64}$/);
  assert.equal(found.Config.Labels['codex.usage-role-build'],name);assert.equal(found.Config.Image,imageId);
  const actual=await inspectImage(found.Image);assert.deepEqual(actual.RootFS,image.RootFS);assert.deepEqual(actual.Config,image.Config);
  return found;
}
// A failed create response can still own a container. Recover by the exact
// predeclared name, then prove its unique label and immutable image before remove.
export async function cleanupImageProbe({find,verify,remove,save,id,name}){
  try{
    const found=await find();
    if(found){await verify(found);if(!id)save('runtime-probe-create-recovery.json',{id:found.Id,name,createOutcome:'unconfirmed',exactOwnedContainerRecovered:true});id=found.Id;await remove(id);}
    assert.equal(await find(),null);save('runtime-probe-cleanup.json',{id:id??null,name,cleanupPassed:true});return true;
  }catch{save('runtime-probe-cleanup.json',{id:id??null,name,cleanupPassed:false,failure:'EXACT_OWNED_CLEANUP_UNCONFIRMED'});throw Error('ROLE_HELPER_PROBE_CLEANUP_FAILED');}
}
