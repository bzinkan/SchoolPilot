import assert from "node:assert/strict";
import { test } from "node:test";

const load = async () => {
  const module = await import("../src/services/screenshotDeltaCodec.js").catch(() => null);
  assert.equal(typeof module?.encodeScreenshotDelta, "function", "The canonical screenshot delta encoder must exist");
  assert.equal(typeof module?.applyScreenshotDelta, "function");
  return module!;
};
function bytes(length: number, seed = 1): Uint8Array {
  let state = seed;
  return Uint8Array.from({ length }, () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state & 255; });
}
function patch(baseBytes: number, targetBytes: number, operations: number[]): Uint8Array {
  const value = Uint8Array.from([67, 80, 68, 49, 0, 0, 0, 0, 0, 0, 0, 0, ...operations]);
  const view = new DataView(value.buffer); view.setUint32(4, baseBytes); view.setUint32(8, targetBytes); return value;
}
const number = (value: number) => [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
const copy = (offset: number, length: number) => [1, ...number(offset), ...number(length)];
const literal = (...value: number[]) => [0, ...number(value.length), ...value];
const stable = { now: () => 0 };

test("canonical codec has a deterministic hash-free twelve-byte copy golden", async () => {
  const { encodeScreenshotDelta, applyScreenshotDelta } = await load();
  const base = bytes(1024), result = encodeScreenshotDelta(base, base, stable);
  assert.equal(result.kind, "delta"); if (result.kind !== "delta") return;
  assert.deepEqual(result.bytes, patch(1024, 1024, copy(0, 1024)));
  assert.equal(result.targetBytes, 1024); assert.deepEqual(applyScreenshotDelta(base, result.bytes), base);
});
test("decoder copies at a non-byte base bit offset and handles a sliced patch buffer", async () => {
  const { applyScreenshotDelta } = await load();
  const encoded = patch(4, 3, [...copy(3, 2), ...literal(127)]);
  const backing = new Uint8Array(encoded.length + 10); backing.set(encoded, 5);
  assert.deepEqual(applyScreenshotDelta(Uint8Array.of(0xb3, 0x6a, 0xf0, 0x59), backing.subarray(5, -5)), Uint8Array.of(0x9b, 0x57, 127));
});
test("encoder finds bit-offset matches and reconstructs exact bytes", async () => {
  const { encodeScreenshotDelta, applyScreenshotDelta } = await load();
  const base = bytes(1025, 54), target = Uint8Array.from({ length: 1024 }, (_, i) => ((base[i]! << 3) | (base[i + 1]! >>> 5)) & 255);
  const result = encodeScreenshotDelta(base, target, stable); assert.equal(result.kind, "delta");
  if (result.kind === "delta") { assert.deepEqual(result.bytes, patch(1025, 1024, copy(3, 1024))); assert.deepEqual(applyScreenshotDelta(base, result.bytes), target); }
});
test("incompressible and insufficient absolute/relative savings keep the original full frame", async () => {
  const { encodeScreenshotDelta } = await load();
  const tiny = bytes(550), tinyChange = tiny.slice(); tinyChange.fill(19, 180, 230);
  const broad = bytes(4096), broadChange = broad.slice(); broadChange.set(bytes(3400, 391), 350);
  for (const [base, target] of [[bytes(4096, 1), bytes(4096, 2)], [tiny, tinyChange], [broad, broadChange]]) {
    assert.deepEqual(encodeScreenshotDelta(base!, target!, stable), { kind: "full", reason: "not_profitable" });
  }
});
test("encoder deadline and bad-clock fallback cannot mutate the capture", async () => {
  const { encodeScreenshotDelta } = await load(); const base = bytes(4096), target = base.slice(); target[120] = target[120]! ^ 7;
  const original = target.slice();
  assert.deepEqual(encodeScreenshotDelta(base, target, { budgetMs: 0 }), { kind: "full", reason: "budget" });
  assert.deepEqual(encodeScreenshotDelta(base, target, { now: () => NaN }), { kind: "full", reason: "clock" });
  let clock = 0; assert.deepEqual(encodeScreenshotDelta(base, target, { now: () => clock++ }), { kind: "full", reason: "budget" });
  assert.deepEqual(target, original);
});
test("codec validates input bounds before allocating expanded output", async () => {
  const { encodeScreenshotDelta, applyScreenshotDelta } = await load(); const base = bytes(1000);
  for (const target of [new Uint8Array(), new Uint8Array(262145)]) assert.equal(encodeScreenshotDelta(base, target, stable).kind, "full");
  assert.equal(Reflect.apply(encodeScreenshotDelta, undefined, [null, base]).kind, "full");
  assert.throws(() => Reflect.apply(applyScreenshotDelta, undefined, [null, base]), /screenshot delta/i);
  for (const value of [patch(1000, 262145, []), new Uint8Array(262145), patch(999, 1, literal(2))]) assert.throws(() => applyScreenshotDelta(base, value), /screenshot delta/i);
});
test("decoder rejects truncated, unknown, zero-length, overflowing and trailing operations", async () => {
  const { applyScreenshotDelta } = await load(); const base = bytes(16);
  for (const malformed of [patch(16, 1, [255]), patch(16, 1, [0, 0]), patch(16, 1, literal()), patch(16, 1, copy(0, 0)),
    patch(16, 2, copy(127, 2)), patch(16, 1, literal(1, 2)), patch(16, 2, literal(1)), patch(16, 1, [...literal(1), 255]),
    patch(16, 1, [...literal(1), ...literal(2)])]) assert.throws(() => applyScreenshotDelta(base, malformed), /screenshot delta/i);
  const badMagic = patch(16, 1, literal(2)); badMagic[0] = 0; assert.throws(() => applyScreenshotDelta(base, badMagic), /screenshot delta/i);
});
test("decoder admits exactly 8192 bounded operations and rejects an extra operation", async () => {
  const { applyScreenshotDelta } = await load(); const base = Uint8Array.from({ length: 16 }, () => 73);
  const accepted = patch(16, 8192 * 16, Array.from({ length: 8192 }, () => copy(0, 16)).flat());
  assert.equal(applyScreenshotDelta(base, accepted).length, 8192 * 16);
  const rejected = patch(16, 8193 * 16, Array.from({ length: 8193 }, () => copy(0, 16)).flat());
  assert.throws(() => applyScreenshotDelta(base, rejected), /screenshot delta/i);
});
test("seeded round trips and malformed-patch fuzz stay bounded and exact", async () => {
  const { encodeScreenshotDelta, applyScreenshotDelta } = await load();
  for (let seed = 1; seed <= 120; seed++) {
    const base = bytes(600 + (seed * 83) % 5000, seed), target = base.slice();
    const start = (seed * 19) % target.length; target.set(bytes(Math.min(5 + seed % 71, target.length - start), seed + 198), start);
    const encoded = encodeScreenshotDelta(base, target, stable);
    if (encoded.kind === "delta") { assert.ok(encoded.bytes.length <= target.length * .75 && target.length - encoded.bytes.length >= 512); assert.deepEqual(applyScreenshotDelta(base, encoded.bytes), target); }
    const malformed = bytes(12 + seed, seed + 10000);
    assert.throws(() => applyScreenshotDelta(base, malformed), /screenshot delta/i);
  }
});
