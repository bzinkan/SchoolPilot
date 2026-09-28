import assert from "node:assert/strict";
import { test } from "node:test";
import { assertIsolatedPaperworkBenchmarkDatabase,parsePaperworkBenchmarkArgs,summarizePaperworkBenchmark,type PaperworkBenchmarkSample } from "../src/cli/benchmarkPaperworkPreparation.js";

const sample=(protocol:1|2,pair:number):PaperworkBenchmarkSample=>({protocol,pair,queueMs:10,preparationMs:protocol===1?1000:700,
  firstReadyMs:protocol===1?800:200,pages:15,forms:15,readyForms:15,providerRequests:30,providerPeak:protocol,
  failures:0,unreviewedWrites:0,expectedFieldsCorrect:15});
test("paired benchmark requires three complete pairs, early review, unchanged expected fields, and measured improvement",()=>{
  const samples=[1,2,3].flatMap(pair=>[sample(1,pair),sample(2,pair)]);
  assert.equal(summarizePaperworkBenchmark(samples).accepted,true);
  assert.equal(summarizePaperworkBenchmark(samples.slice(0,4)).accepted,false);
  assert.equal(summarizePaperworkBenchmark(samples.map(s=>({...s,pair:1}))).accepted,false);
  for(const bad of [
    {...samples[5]!,firstReadyMs:700}, {...samples[5]!,forms:14}, {...samples[5]!,readyForms:14},
    {...samples[5]!,expectedFieldsCorrect:14}, {...samples[5]!,unreviewedWrites:1}, {...samples[5]!,providerPeak:3},
  ]) assert.equal(summarizePaperworkBenchmark([...samples.slice(0,5),bad]).accepted,false);
  assert.equal(summarizePaperworkBenchmark(samples.map(s=>({...s,preparationMs:1000}))).targetMet,false);
});
test("benchmark defaults to synthetic transport and rejects incomplete or unbounded configuration",()=>{
  assert.deepEqual(parsePaperworkBenchmarkArgs([]),{transport:"synthetic",pairs:3,syntheticDelayMs:500,imageDigest:null});
  assert.equal(parsePaperworkBenchmarkArgs(["--transport","live"]).transport,"live");
  for(const args of [["--api-key","secret"],["--pairs","1"],["--pairs","6"],["--synthetic-delay-ms","0"],["--transport"],["--transport","live","--transport","live"]])
    assert.throws(()=>parsePaperworkBenchmarkArgs(args));
});
test("worker benchmark refuses production and unrelated local databases before importing application pools",()=>{
  for(const url of ["postgres://user:pass@production.invalid/schoolpilot_paperwork_fixture","postgres://localhost/schoolpilot_production","postgres://localhost/postgres","https://localhost/schoolpilot_benchmark_fixture"])
    assert.throws(()=>assertIsolatedPaperworkBenchmarkDatabase(url));
  for(const host of ["localhost","127.0.0.1","host.docker.internal"])
    assert.equal(assertIsolatedPaperworkBenchmarkDatabase(`postgres://user:pass@${host}/schoolpilot_paperwork_fixture`).hostname,host);
});
