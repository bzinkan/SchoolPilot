import assert from 'node:assert/strict';
import { hash } from './contracts.mjs';

// Common public logs, not candidate-only SQL wrappers, provide this paired
// error oracle. Missing/partial logs are unavailable rather than zero errors.
export function negativeProbes(traffic) {
  const lifecycle=traffic?.lifecycle;
  return lifecycle?.rounds?lifecycle.rounds.flatMap(row=>row.expectedNegativeProbes??[]):lifecycle?.expectedNegativeProbes??[];
}
export function runNegativeProbes(metrics) {
  return metrics.continuous?negativeProbes(metrics.continuous.traffic):metrics.preparationSmokeResult?negativeProbes(metrics.preparationSmokeResult.result):metrics.rounds.flatMap(row=>negativeProbes(row.traffic));
}
export function negativeLogCoverage(coverage,probes) {
  const actual=coverage.filter(row=>row.role?.startsWith('api')).flatMap(row=>row.expectedNegativeRequestIds??[]).sort();
  const expected=probes.map(row=>row.requestId).sort();
  return new Set(expected).size===expected.length&&JSON.stringify(actual)===JSON.stringify(expected);
}
export function classifyLog(bytes, kind, { complete = false, expectedNegativeProbes=[] } = {}) {
  assert.ok(['api', 'postgres'].includes(kind)); assert.equal(typeof bytes, 'string');
  const probes=new Map();
  for(const probe of expectedNegativeProbes){assert.match(probe.requestId,/^[a-f0-9-]{36}$/);assert.equal(probe.status,409);assert.equal(probe.code,'PRIVATE_CHAT_LIFECYCLE_STALE');assert.equal(probes.has(probe.requestId),false);probes.set(probe.requestId,probe);}
  const lines = bytes.split(/\r?\n/), errors = [],expectedNegativeRequestIds=[];
  const category = line => /acquir|connect.*timeout|pool.*timeout|too many clients|remaining connection slots/i.test(line) ? 'acquisition'
    : /statement timeout|canceling statement|deadlock|SQLSTATE|\b(?:ERROR|FATAL|PANIC):/i.test(line) ? 'statement'
    : 'unknown-foreground';
  for (const line of lines) if (/\b(?:error|fatal|panic|uncaught|unhandled)\b|timeout exceeded|connection terminated|canceling statement/i.test(line)) {
    const known=kind==='api'&&line.match(/^Error \[req:([a-f0-9-]{36})\]: \{ errorType: 'Error', errorCode: 'PRIVATE_CHAT_LIFECYCLE_STALE' \}$/);
    if(known&&probes.has(known[1])&&!expectedNegativeRequestIds.includes(known[1]))expectedNegativeRequestIds.push(known[1]);else errors.push(category(line));
  }
  return { kind, complete, available: complete, bytes: Buffer.byteLength(bytes), sha256: hash(bytes),
    errorCount: errors.length, expectedNegativeRequestIds, categories: Object.fromEntries([...new Set(errors)].map(value => [value, errors.filter(item => item === value).length])) };
}
export function cpuObservation(window,{strict=true}={}){
  try{return{available:true,acceptedAsCpuEvidence:true,...cpuWindow(window)};}
  catch(error){if(strict)throw error;return{available:false,acceptedAsCpuEvidence:false,usec:null,meanFraction:null,errorCode:'OPTIONAL_CPU_WINDOW_INVALID'};}
}
export function cpuWindow(window) {
  assert.equal(window.declaredDurationMs, 60_000); assert.ok(window.start && window.end);
  const usec = window.end.cpu.usage_usec - window.start.cpu.usage_usec;
  assert.ok(Number.isSafeInteger(usec) && usec >= 0);
  assert.ok(window.startDelayMs >= 0 && window.startDelayMs <= 100);
  assert.ok(window.endDelayMs >= 0 && window.endDelayMs <= 100);
  assert.ok(window.end.hrtimeMicroseconds > window.start.hrtimeMicroseconds);
  // The denominator is the declared offering window. Later cleanup cannot
  // dilute it; CPU after that window is measured separately.
  return { usec, meanFraction: usec / 60_000_000, durationMs: (window.end.hrtimeMicroseconds - window.start.hrtimeMicroseconds) / 1000 };
}
