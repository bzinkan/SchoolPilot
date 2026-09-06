import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeSafetyLoginReturn, rememberSafetyLoginReturn, consumeSafetyLoginReturn, SAFETY_LOGIN_RETURN_KEY, SAFETY_LOGIN_RETURN_TTL_MS } from '../src/shared/utils/safetyLoginReturn.js';

const path = '/classpilot/admin/safety';
const casePath = `${path}?case=340b5200-114d-4c68-b9b8-8a78c6e9d8a1`;
const storage = () => {
  const entries = new Map();
  return { getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value), removeItem: key => entries.delete(key) };
};

test('accepts only local Safety Center links and UUID or safe legacy case IDs', () => {
  assert.equal(normalizeSafetyLoginReturn(path), path);
  assert.equal(normalizeSafetyLoginReturn(casePath), casePath);
  assert.equal(normalizeSafetyLoginReturn(`${path}?case=legacy_case:1`), `${path}?case=legacy_case%3A1`);
  for (const invalid of [null, 'https://school-pilot.net' + casePath, '//evil.test', '/\\evil.test', `${path}/../other`, `${path}/`, `${path}#redirect`, `${path}?case=`, `${path}?case=a&case=b`, `${path}?case=%2F%2Fevil.test`, `${path}?case=%5Cevil`, `${path}?case=%00`, `${path}?case=${'a'.repeat(129)}`, `${path}?returnTo=https://evil.test`, '/login', '/classpilot', `${path}\n`]) {
    assert.equal(normalizeSafetyLoginReturn(invalid), null, String(invalid));
  }
});

test('destination survives the sign-in round trip and is consumed once', () => {
  const store = storage();
  assert.equal(rememberSafetyLoginReturn(casePath, { storage: store, now: 1000 }), true);
  assert.equal(consumeSafetyLoginReturn({ storage: store, now: 2000 }), casePath);
  assert.equal(consumeSafetyLoginReturn({ storage: store, now: 2000 }), null);
  rememberSafetyLoginReturn(casePath, { storage: store, now: 2000 });
  assert.equal(rememberSafetyLoginReturn('//evil.test', { storage: store, now: 2001 }), false);
  assert.equal(consumeSafetyLoginReturn({ storage: store, now: 2002 }), null, 'A rejected new destination cannot resume an older report');
});

test('expired, future, malformed and externally injected destinations are removed', () => {
  for (const value of [
    JSON.stringify({ version: 1, path: casePath, createdAt: 1000 }),
    JSON.stringify({ version: 1, path: casePath, createdAt: 1000 + SAFETY_LOGIN_RETURN_TTL_MS + 1 }),
    JSON.stringify({ version: 1, path: '//evil.test', createdAt: 1000 + SAFETY_LOGIN_RETURN_TTL_MS }),
    JSON.stringify({ version: 2, path: casePath, createdAt: 1000 + SAFETY_LOGIN_RETURN_TTL_MS }),
    '{bad json',
  ]) {
    const store = storage(); store.setItem(SAFETY_LOGIN_RETURN_KEY, value);
    assert.equal(consumeSafetyLoginReturn({ storage: store, now: 1000 + SAFETY_LOGIN_RETURN_TTL_MS }), null);
    assert.equal(store.getItem(SAFETY_LOGIN_RETURN_KEY), null);
  }
});

test('unavailable session storage cannot break authentication or create a redirect', () => {
  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
  assert.equal(rememberSafetyLoginReturn(casePath, { storage: blocked }), false);
  assert.equal(consumeSafetyLoginReturn({ storage: blocked }), null);
});
