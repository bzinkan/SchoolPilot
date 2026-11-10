import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { encodeScreenshotDelta, applyScreenshotDelta } from '../src/services/screenshotDeltaCodec.ts';

test('canonical TypeScript generates byte-identical frontend and Chrome implementations', async () => {
  const generator = await import('../scripts/sync-classpilot-screenshot-codec.mjs').catch(() => null);
  assert.equal(typeof generator?.generateScreenshotDeltaCopies, 'function', 'The shared codec generator must exist');
  const source = readFileSync(new URL('../src/services/screenshotDeltaCodec.ts', import.meta.url), 'utf8');
  const generated = generator.generateScreenshotDeltaCopies(source);
  assert.equal(readFileSync(new URL('../schoolpilot-app/src/products/classpilot/lib/screenshotDeltaCodec.js', import.meta.url), 'utf8'), generated.frontendSource);
  const frontend = await import('../schoolpilot-app/src/products/classpilot/lib/screenshotDeltaCodec.js');
  const context = vm.createContext({ performance }); vm.runInContext(generated.extensionSource, context);
  const chrome = context.ClassPilotScreenshotDeltaCodec;
  assert.ok(Object.isFrozen(chrome));
  const base = Uint8Array.from({ length: 8192 }, (_, index) => ((index * 31) ^ (index >>> 3)) & 255);
  for (let seed = 0; seed < 32; seed++) {
    const target = base.slice(); target.fill(seed + 81, 200 + seed * 17, 240 + seed * 17);
    const result = encodeScreenshotDelta(base, target, { now: () => 0 }); assert.equal(result.kind, 'delta');
    for (const implementation of [frontend, chrome]) {
      const other = implementation.encodeScreenshotDelta(base, target, { now: () => 0 });
      assert.equal(other.kind, result.kind); assert.deepEqual(Array.from(other.bytes), Array.from(result.bytes));
      assert.deepEqual(Array.from(implementation.applyScreenshotDelta(base, other.bytes)), Array.from(applyScreenshotDelta(base, result.bytes)));
    }
  }
});
