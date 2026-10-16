// Preloaded ClassPilot dashboard themes.
//
// The server mirrors DASHBOARD_THEME_PRESET_IDS in
// src/services/classpilotThemes.ts and a test keeps the two lists identical.
// A theme is presentation only: it recolors the console chrome, paints the
// page background and adds a small ornament to each tile. Student status
// colors, badges and layout never come from here.

import { calendarPresetFor, localDateParts } from './calendar.js';

export const DASHBOARD_THEME_PRESET_IDS = Object.freeze([
  'halloween',
  'thanksgiving',
  'christmas',
  'advent',
  'valentines',
  'st-patricks',
  'easter',
  'spring',
  'summer',
  'fall',
  'winter',
]);

// Every preset ships artwork and CSS. `ready: false` is how a preset would be
// retired without breaking stored values.
// `clearance` is the extra room an ornament that rises above the tile needs.
const PRESETS = Object.freeze([
  Object.freeze({ id: 'halloween', label: 'Halloween', ready: true, artwork: '/themes/halloween.svg', ornament: 'cobweb', clearance: 'none' }),
  Object.freeze({ id: 'thanksgiving', label: 'Thanksgiving', ready: true, artwork: '/themes/thanksgiving.svg', ornament: 'turkey', clearance: 'md' }),
  Object.freeze({ id: 'christmas', label: 'Christmas', ready: true, artwork: '/themes/christmas.svg', ornament: 'lights', clearance: 'sm' }),
  Object.freeze({ id: 'advent', label: 'Advent', ready: true, artwork: '/themes/advent.svg', ornament: 'none', clearance: 'none' }),
  Object.freeze({ id: 'valentines', label: "Valentine's Day", ready: true, artwork: '/themes/valentines.svg', ornament: 'hearts', clearance: 'sm' }),
  Object.freeze({ id: 'st-patricks', label: "St. Patrick's Day", ready: true, artwork: '/themes/st-patricks.svg', ornament: 'shamrock', clearance: 'sm' }),
  Object.freeze({ id: 'easter', label: 'Easter', ready: true, artwork: '/themes/easter.svg', ornament: 'ears', clearance: 'md' }),
  Object.freeze({ id: 'spring', label: 'Spring', ready: true, artwork: '/themes/spring.svg', ornament: 'daisy', clearance: 'sm' }),
  Object.freeze({ id: 'summer', label: 'Summer', ready: true, artwork: '/themes/summer.svg', ornament: 'sun', clearance: 'sm' }),
  Object.freeze({ id: 'fall', label: 'Fall', ready: true, artwork: '/themes/fall.svg', ornament: 'leaf', clearance: 'sm' }),
  Object.freeze({ id: 'winter', label: 'Winter', ready: true, artwork: '/themes/winter.svg', ornament: 'snowcap', clearance: 'sm' }),
]);

export const DASHBOARD_THEME_PRESETS = PRESETS;

export function findDashboardThemePreset(id) {
  return PRESETS.find(preset => preset.id === id) || null;
}

export function readyDashboardThemePresets() {
  return PRESETS.filter(preset => preset.ready);
}

// Turn a stored preference into the preset to draw, or null for Default.
// Unknown, retired or not-yet-shipped ids resolve to null so a stale value can
// never break the page; the picker reports them separately.
// A teacher's own background is fetched through the authenticated asset
// route. The stylesheet cannot send headers, so the school rides in the query.
export function dashboardThemeAssetUrl(assetId, schoolId) {
  const params = new URLSearchParams();
  if (schoolId) params.set('schoolId', schoolId);
  const query = params.toString();
  return `/api/classpilot/teacher/theme-asset/${encodeURIComponent(assetId)}/content${query ? `?${query}` : ''}`;
}

export function imageDashboardTheme(assetId, schoolId) {
  return Object.freeze({ id: 'image', label: 'Your background', ready: true, artwork: dashboardThemeAssetUrl(assetId, schoolId), ornament: 'none', clearance: 'none' });
}

// With `calendar: true` the stored preset is only a hint (Advent opts the
// school into the liturgical variant); the date picks the preset to draw.
// An uploaded image resolves to a neutral-glass "image" look over the asset.
export function resolveDashboardTheme(theme, { enabled = true, now = new Date(), timeZone = 'America/New_York', schoolId = null, uploadsEnabled = true } = {}) {
  if (!enabled || !theme || typeof theme !== 'object') return null;
  if (theme.kind === 'image') return uploadsEnabled && typeof theme.imageAssetId === 'string' && theme.imageAssetId ? imageDashboardTheme(theme.imageAssetId, schoolId) : null;
  if (theme.kind !== 'preset') return null;
  const id = theme.calendar === true
    ? calendarPresetFor(localDateParts(now, timeZone || 'America/New_York'), { liturgical: theme.preset === 'advent' })
    : theme.preset;
  const preset = findDashboardThemePreset(id);
  return preset && preset.ready ? preset : null;
}

// A stored preset the catalog no longer ships (or never shipped yet).
export function isUnavailableDashboardTheme(theme) {
  return Boolean(theme && typeof theme === 'object' && theme.kind === 'preset' && !resolveDashboardTheme(theme));
}

export function describeDashboardTheme(theme) {
  if (!theme || typeof theme !== 'object') return 'Default';
  if (typeof theme.name === 'string' && theme.name.trim()) return theme.name.trim();
  if (theme.kind === 'preset') return findDashboardThemePreset(theme.preset)?.label || 'Unavailable theme';
  return 'Your background';
}
