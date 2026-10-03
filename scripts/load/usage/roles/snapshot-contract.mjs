import assert from 'node:assert/strict';
import {readFileSync,realpathSync,statSync} from 'node:fs';
import {resolve,relative,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
export const snapshotHash = bytes => createHash('sha256').update(bytes).digest('hex');
const records = ['prepared-database.private.dump','synthetic-roles.private.sql','cold-fixture-state.json','release-control-preparation.json','preparation-fixture-contract.json','preparation-metrics.json','schema-fingerprint.json','post-convergence-schema.sql','measurement-ready.json'];
export function normalizeSnapshotSchema(text) {
  return text.replace(/^\uFEFF/,'').replace(/\r\n/g,'\n').split('\n').filter(line => !/^\\(?:un)?restrict\s/.test(line)).join('\n').trim();
}
export function assertSnapshotManifest(manifest,{source,today}) {
  assert.equal(manifest.schemaVersion,1); assert.equal(manifest.source,source);
  assert.match(source,/^[a-f0-9]{40}$/); assert.equal(manifest.preparedSchoolLocalDate,today);
  assert.equal(manifest.sourceUnchanged,true); assert.equal(manifest.timingHeld,true);
  assert.equal(manifest.measurementGoAbsent,true); assert.equal(manifest.readOnlyExport,true);
  assert.equal(manifest.otherClientsBefore,0); assert.equal(manifest.otherClientsAfter,0);
  assert.equal(manifest.timezone,'UTC'); assert.equal(manifest.databaseEncoding,'UTF8'); assert.equal(manifest.serverVersion,'16.15');
  assert.equal(manifest.heartbeatRows,2_000_002); assert.equal(manifest.migrations,53);
  assert.deepEqual(manifest.schoolCounts,[{schoolIndex:0,observations:1_000_001},{schoolIndex:1,observations:1_000_001}]);
  assert.deepEqual(manifest.records.map(r=>r.file).sort(),[...records].sort());
  for(const row of manifest.records){assert.match(row.sha256,/^[a-f0-9]{64}$/);assert.ok(Number.isSafeInteger(row.bytes)&&row.bytes>0);}
  assert.match(manifest.pgImage,/^sha256:[a-f0-9]{64}$/); return manifest;
}
// Same-source restoration only. A future cross-source path needs a separate
// compatibility receipt; it must never rewrite historical source metadata.
export function loadSnapshot(directory,manifestSha256,expected) {
  const root=realpathSync(directory),raw=readFileSync(resolve(root,'manifest.json'));
  assert.match(manifestSha256,/^[a-f0-9]{64}$/); assert.equal(snapshotHash(raw),manifestSha256);
  const manifest=assertSnapshotManifest(JSON.parse(raw),expected),data={};
  for(const row of manifest.records){
    const file=realpathSync(resolve(root,row.file)),rel=relative(root,file);
    assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel)); assert.ok(statSync(file).isFile());
    const bytes=readFileSync(file);assert.equal(bytes.length,row.bytes);assert.equal(snapshotHash(bytes),row.sha256);
    if(row.file.endsWith('.json'))data[row.file]=JSON.parse(bytes);
  }
  return {root,manifest,manifestSha256,data};
}
