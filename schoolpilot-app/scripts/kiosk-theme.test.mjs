import assert from 'node:assert/strict';
import test from 'node:test';
import { DASHBOARD_THEME_PRESET_IDS } from '../src/shared/themes/presets.js';
import { KIOSK_PLATES, KIOSK_PLATE_MAX_NAME_LENGTH, kioskFirstName, kioskGreeting, kioskPlateLabel, kioskThemeAssetPath, resolveKioskTheme } from '../src/shared/themes/kiosk.js';

test('every shipped preset has a kiosk name plate and a greeting that uses the first name', () => {
  for (const id of DASHBOARD_THEME_PRESET_IDS) {
    assert.ok(KIOSK_PLATES[id], `${id} has a plate`);
    assert.match(kioskGreeting(id, 'Grace'), /Grace!$/, `${id} greets Grace`);
    assert.equal(kioskPlateLabel(id, 'Grace'), `Grace, ${KIOSK_PLATES[id].on}`);
  }
  assert.equal(kioskGreeting('halloween', 'Grace'), 'Happy Halloween, Grace!');
  assert.equal(kioskGreeting('christmas', 'Grace'), 'Merry Christmas, Grace!');
  assert.equal(kioskGreeting('advent', 'Grace'), 'Welcome back, Grace!', 'Advent keeps the plain welcome');
  assert.equal(kioskGreeting('winter', 'Grace'), 'Welcome back, Grace!');
  assert.equal(kioskGreeting('image', 'Grace'), 'Welcome back, Grace!');
  assert.equal(kioskGreeting('halloween', ''), 'Welcome back!', 'no name, no comma');
  assert.equal(kioskGreeting(null, undefined), 'Welcome back!');
});

test('long first names are trimmed to the plate width and never leak beyond the first name', () => {
  assert.equal(kioskFirstName('  Ada '), 'Ada');
  assert.equal(kioskFirstName('Maximiliana-Jo'), 'Maximiliana-Jo', '14 characters fit');
  const trimmed = kioskFirstName('Bartholomew Alexander');
  assert.equal(trimmed.length, KIOSK_PLATE_MAX_NAME_LENGTH);
  assert.ok(trimmed.endsWith('…'));
  assert.equal(kioskPlateLabel('easter', ''), '');
});

test('the kiosk resolves only concrete themes the server already decided on', () => {
  assert.deepEqual(resolveKioskTheme({ kind: 'preset', preset: 'halloween' }),
    { id: 'halloween', label: 'Halloween', artwork: '/themes/halloween.svg', plate: KIOSK_PLATES.halloween, imageAssetId: null });
  const image = resolveKioskTheme({ kind: 'image', imageAssetId: 'asset-1' });
  assert.equal(image.id, 'image');
  assert.equal(image.artwork, null, 'uploaded bytes come through the kiosk client, never a public URL');
  assert.equal(image.imageAssetId, 'asset-1');
  assert.equal(image.plate, KIOSK_PLATES.image);
  assert.equal(resolveKioskTheme({ kind: 'preset', preset: 'retired-look' }), null);
  assert.equal(resolveKioskTheme({ kind: 'image' }), null);
  assert.equal(resolveKioskTheme(null), null);
  assert.equal(resolveKioskTheme('halloween'), null);
  assert.equal(resolveKioskTheme({ kind: 'preset', preset: 'halloween', calendar: true }).id, 'halloween', 'calendar mode is resolved server-side; the kiosk shows the preset it was given');
});

test('the kiosk asset path is scoped to the kiosk API and encodes the id', () => {
  assert.equal(kioskThemeAssetPath('asset-1'), '/api/passpilot/kiosk/theme-asset/asset-1/content');
  assert.equal(kioskThemeAssetPath('a/b c'), '/api/passpilot/kiosk/theme-asset/a%2Fb%20c/content');
});
