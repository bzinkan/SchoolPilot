import assert from 'node:assert/strict';
import test from 'node:test';
import { buildConfiguration } from '../configure.mjs';

const input = {
  wifiSsid: 'Classroom WiFi', wifiPassword: 'quote" slash\\ unicode café',
  apiUrl: 'https://school-pilot.net/api/passpilot/indicators/state',
};
const pairing = { pairingId: '9801f5da-6f71-4c88-a370-2ea2112c114a', token: `ppi_${'a'.repeat(43)}`, expiresAt: '2099-01-01T00:00:00.000Z' };
const ca = '-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----';

test('matching keys and names, escaped credentials, and exact API endpoint', () => {
  const result = buildConfiguration(input, pairing, ca, Buffer.alloc(32, 7), '12ab34cd');
  assert.match(result.light, /PP_LIGHT_SUFFIX = "12ab34cd"/);
  assert.match(result.light, new RegExp(`PP_LIGHT_KEY_HEX = "${'07'.repeat(32)}"`));
  assert.match(result.gateway, /PP_LIGHT_NAME = "PP-Light-12ab34cd"/);
  assert.match(result.gateway, new RegExp(`PP_BLE_KEY_HEX = "${'07'.repeat(32)}"`));
  assert.ok(result.gateway.includes(JSON.stringify(input.wifiPassword)));
  assert.ok(!JSON.stringify(result.manifest).includes(pairing.token));
});

test('rejects insecure or credential-bearing API addresses and malformed tokens', () => {
  for (const apiUrl of ['http://school-pilot.net/api/passpilot/indicators/state', 'https://user:pass@example.org/api/passpilot/indicators/state', 'https://example.org/elsewhere', 'https://example.org/api/passpilot/indicators/state?token=x']) {
    assert.throws(() => buildConfiguration({ ...input, apiUrl }, pairing, ca));
  }
  assert.throws(() => buildConfiguration(input, { ...pairing, token: 'a staff token' }, ca));
  assert.throws(() => buildConfiguration(input, { ...pairing, expiresAt: '2000-01-01' }, ca));
  assert.throws(() => buildConfiguration({ ...input, categoryBit: 3 }, pairing, ca));
});

test('configuration must supply a certificate and supported WiFi credentials', () => {
  assert.throws(() => buildConfiguration(input, pairing, ''));
  assert.throws(() => buildConfiguration({ ...input, wifiSsid: '' }, pairing, ca));
  assert.throws(() => buildConfiguration({ ...input, wifiPassword: 'a\nnewline' }, pairing, ca));
});
