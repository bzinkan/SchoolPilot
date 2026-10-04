import assert from 'node:assert/strict';
import { hash } from './contracts.mjs';

// Common public logs, not candidate-only SQL wrappers, provide this paired
// error oracle. Missing/partial logs are unavailable rather than zero errors.
export function classifyLog(bytes, kind, { complete = false } = {}) {
  assert.ok(['api', 'postgres'].includes(kind)); assert.equal(typeof bytes, 'string');
  const lines = bytes.split(/\r?\n/), errors = [];
  const category = line => /acquir|connect.*timeout|pool.*timeout|too many clients|remaining connection slots/i.test(line) ? 'acquisition'
    : /statement timeout|canceling statement|deadlock|SQLSTATE|\b(?:ERROR|FATAL|PANIC):/i.test(line) ? 'statement'
    : 'unknown-foreground';
  for (const line of lines) if (/\b(?:error|fatal|panic|uncaught|unhandled)\b|timeout exceeded|connection terminated|canceling statement/i.test(line)) errors.push(category(line));
  return { kind, complete, available: complete, bytes: Buffer.byteLength(bytes), sha256: hash(bytes),
    errorCount: errors.length, categories: Object.fromEntries([...new Set(errors)].map(value => [value, errors.filter(item => item === value).length])) };
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
