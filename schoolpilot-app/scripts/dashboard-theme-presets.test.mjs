import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DASHBOARD_THEME_PRESETS, DASHBOARD_THEME_PRESET_IDS, describeDashboardTheme, findDashboardThemePreset, isUnavailableDashboardTheme, readyDashboardThemePresets, resolveDashboardTheme, resolveSchoolTheme } from '../src/shared/themes/presets.js';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('preset ids are unique, ordered like the catalog, and mirrored by the server', () => {
  assert.equal(new Set(DASHBOARD_THEME_PRESET_IDS).size, DASHBOARD_THEME_PRESET_IDS.length);
  assert.deepEqual(DASHBOARD_THEME_PRESETS.map(preset => preset.id), [...DASHBOARD_THEME_PRESET_IDS]);
  const serverCatalog = path.join(appRoot, '..', 'src', 'services', 'classpilotThemes.ts');
  assert.ok(existsSync(serverCatalog), 'src/services/classpilotThemes.ts must exist and list DASHBOARD_THEME_PRESET_IDS');
  const match = readFileSync(serverCatalog, 'utf8').match(/DASHBOARD_THEME_PRESET_IDS\s*=\s*\[([^\]]*)\]/);
  assert.ok(match, 'server preset id list not found');
  const serverIds = [...match[1].matchAll(/"([a-z-]+)"/g)].map(found => found[1]);
  assert.deepEqual(serverIds, [...DASHBOARD_THEME_PRESET_IDS], 'client and server preset ids must stay identical');
});

test('ready presets ship artwork under /themes/ and a known ornament and clearance', () => {
  const ready = readyDashboardThemePresets();
  assert.equal(ready.length, DASHBOARD_THEME_PRESET_IDS.length, 'every catalog preset ships');
  for (const preset of ready) {
    assert.match(preset.artwork, /^\/themes\/[a-z-]+\.webp$/);
    const file = path.join(appRoot, 'public', preset.artwork);
    assert.ok(existsSync(file), `${preset.artwork} must be shipped in public/`);
    assert.ok(statSync(file).size <= 400 * 1024, `${preset.artwork} stays within the 400 KB artwork budget`);
    assert.ok(['none', 'cobweb', 'turkey', 'lights', 'hearts', 'shamrock', 'ears', 'daisy', 'sun', 'leaf', 'snowcap'].includes(preset.ornament));
    assert.ok(['none', 'sm', 'md'].includes(preset.clearance));
  }
});

test('resolve returns a ready preset for a stored preset and null for everything else', () => {
  assert.equal(resolveDashboardTheme(null), null);
  assert.equal(resolveDashboardTheme(undefined), null);
  assert.equal(resolveDashboardTheme('halloween'), null);
  assert.equal(resolveDashboardTheme({ kind: 'preset', preset: 'halloween' }, { enabled: false }), null, 'the server gate wins');
  assert.equal(resolveDashboardTheme({ kind: 'preset', preset: 'not-a-theme' }), null, 'a retired id never breaks the page');
  const uploaded = resolveDashboardTheme({ kind: 'image', imageAssetId: '00000000-0000-4000-8000-000000000000' }, { schoolId: 'school-a' });
  assert.equal(uploaded?.id, 'image', 'an uploaded background resolves to the neutral image look');
  assert.equal(uploaded?.artwork, '/api/classpilot/teacher/theme-asset/00000000-0000-4000-8000-000000000000/content?schoolId=school-a');
  assert.equal(uploaded?.ornament, 'none');
  assert.equal(resolveDashboardTheme({ kind: 'image', imageAssetId: '00000000-0000-4000-8000-000000000000' }, { uploadsEnabled: false }), null, 'the school upload switch wins');
  assert.equal(resolveDashboardTheme({ kind: 'image' }), null, 'an image theme without an asset is Default');
  assert.equal(resolveDashboardTheme({ kind: 'preset', preset: 'fall', calendar: true }, { now: new Date('2026-10-16T18:00:00Z'), timeZone: 'America/New_York' })?.id, 'fall', 'calendar mode follows the date, not the stored hint');
  assert.equal(resolveDashboardTheme({ kind: 'preset', preset: 'advent', calendar: true }, { now: new Date('2026-12-10T18:00:00Z'), timeZone: 'America/New_York' })?.id, 'advent', 'the Advent hint opts into the liturgical variant');
  assert.equal(resolveDashboardTheme({ kind: 'preset', preset: 'fall', calendar: true }, { now: new Date('2026-12-10T18:00:00Z'), timeZone: 'America/New_York' })?.id, 'winter', 'without the hint December is Christmas');
  assert.equal(resolveDashboardTheme({ kind: 'preset', preset: 'halloween', name: 'Spooky' }), findDashboardThemePreset('halloween'));
});

test('describe and unavailable follow the stored value', () => {
  assert.equal(describeDashboardTheme(null), 'Follow the school');
  assert.equal(describeDashboardTheme({ kind: 'preset', preset: 'christmas' }), 'Christmas');
  assert.equal(describeDashboardTheme({ kind: 'preset', preset: 'christmas', name: '  Ho ho ho ' }), 'Ho ho ho');
  assert.equal(describeDashboardTheme({ kind: 'preset', preset: 'gone' }), 'Unavailable theme');
  assert.equal(isUnavailableDashboardTheme(null), false);
  assert.equal(isUnavailableDashboardTheme({ kind: 'preset', preset: 'halloween' }), false);
  assert.equal(isUnavailableDashboardTheme({ kind: 'preset', preset: 'gone' }), true);
});

test('plain and school-calendar themes resolve as the picker and dashboard expect', () => {
  assert.equal(resolveDashboardTheme({ kind: 'none' }), null, 'Plain is a deliberate nothing');
  const now = new Date('2026-12-20T16:00:00Z');
  const school = { kind: 'preset', preset: 'fall', calendar: true, source: 'school' };
  assert.equal(resolveDashboardTheme(school, { now, calendar: { holidays: ['halloween'], leadDays: 10, starts: {} } })?.id, 'winter', 'a school without Christmas listed sees Winter in December');
  assert.equal(resolveDashboardTheme(school, { now, calendar: { holidays: ['christmas'], leadDays: 10, starts: {} } })?.id, 'christmas');
  assert.equal(resolveDashboardTheme(school, { now: new Date('2026-12-12T16:00:00Z'), calendar: { holidays: ['christmas'], leadDays: 10, starts: { christmas: '2026-12-11' } } })?.id, 'christmas', 'an early start opens the window');
  assert.equal(resolveDashboardTheme({ kind: 'preset', preset: 'fall', calendar: true }, { now })?.id, 'christmas', "a teacher's own calendar may show Christmas");
  assert.equal(resolveDashboardTheme({ kind: 'preset', preset: 'fall', calendar: true }, { now: new Date('2026-12-10T16:00:00Z') })?.id, 'winter', 'without the Advent hint');
  assert.equal(resolveDashboardTheme({ kind: 'preset', preset: 'advent', calendar: true }, { now: new Date('2026-12-10T16:00:00Z') })?.id, 'advent');
  assert.equal(resolveSchoolTheme({ schoolTheme: school, schoolCalendar: { holidays: [], leadDays: 10, starts: {} } }, { now })?.id, 'winter');
  assert.equal(resolveSchoolTheme({ schoolTheme: { kind: 'preset', preset: 'summer', source: 'school' } }, { now })?.id, 'summer', 'a fixed school theme is itself');
  assert.equal(resolveSchoolTheme({ schoolTheme: null }), null);
  assert.equal(describeDashboardTheme({ kind: 'none' }), 'Plain, no theme');
  assert.equal(describeDashboardTheme(null), 'Follow the school');
  assert.equal(describeDashboardTheme({ kind: 'preset', preset: 'fall', calendar: true }), 'Calendar: Fall');
});
