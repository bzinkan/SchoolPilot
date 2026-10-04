import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
const [repository,output]=process.argv.slice(2);
const source='b11202fc305198d76e73c5e6d711b7dc9ed2d938';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const relative='docs/release-evidence/release-297/usage-contention/frontend-final-source.json';
const raw=readFileSync(resolve(repository,relative)),prior=JSON.parse(raw);
const rows=execFileSync('git',['ls-tree','-rz',source,'--','schoolpilot-app'],{cwd:repository,encoding:'utf8',windowsHide:true}).split('\0').filter(Boolean);
const actual=new Map(rows.map(row=>{const match=/^\d+ blob ([a-f0-9]{40})\t(.+)$/.exec(row);assert.ok(match);return[match[2],match[1]];}));
assert.equal(actual.size,prior.sourceBinding.source.length);
for(const expected of prior.sourceBinding.source)assert.equal(actual.get(expected.file),expected.gitBlob,expected.file);
const artifact=prior.artifact;
assert.equal(sha(readFileSync(artifact.location)),artifact.sha256);
assert.equal(prior.aggregateExitCode,0);assert.equal(prior.buildExitCode,0);assert.equal(prior.lintExitCode,0);
const receipt={schemaVersion:1,recordedAt:new Date().toISOString(),source,
 frontendTree:execFileSync('git',['rev-parse',source+':schoolpilot-app'],{cwd:repository,encoding:'utf8',windowsHide:true}).trim(),
 sourceFiles:actual.size,allSourceBlobsMatch:true,priorReceipt:relative,priorReceiptSha256:sha(raw),priorRecordedAt:prior.recordedAt,
 priorNodeRunnerTotals:prior.nodeRunnerTotals,priorDirectBrowserScripts:prior.directBrowserScripts,
 frontendArchive:artifact.location,frontendArchiveSha256:artifact.sha256,artifactUnchanged:true,
 scope:'Source and retained frontend artifact equivalence only. This does not claim a new browser run, deployment, or backend/frontend live acceptance.',published:false};
writeFileSync(output,JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({source,sourceFiles:actual.size,artifactUnchanged:true,receiptSha256:sha(readFileSync(output))}));
