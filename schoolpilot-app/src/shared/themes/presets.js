// Preloaded ClassPilot dashboard themes.
//
// The server mirrors DASHBOARD_THEME_PRESET_IDS in
// src/services/classpilotThemes.ts and a test keeps the two lists identical.
// A theme is presentation only: it recolors the console chrome, paints the
// page background and adds a small ornament to each tile. Student status
// colors, badges and layout never come from here.

import { DEFAULT_CALENDAR_HOLIDAYS, calendarPresetFor, localDateParts, teacherCalendarHolidays } from './calendar.js';

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
  Object.freeze({ id: 'halloween', label: 'Halloween', ready: true, artwork: '/themes/halloween.webp', ornament: 'cobweb', clearance: 'none' }),
  Object.freeze({ id: 'thanksgiving', label: 'Thanksgiving', ready: true, artwork: '/themes/thanksgiving.webp', ornament: 'turkey', clearance: 'md' }),
  Object.freeze({ id: 'christmas', label: 'Christmas', ready: true, artwork: '/themes/christmas.webp', ornament: 'lights', clearance: 'sm' }),
  Object.freeze({ id: 'advent', label: 'Advent', ready: true, artwork: '/themes/advent.webp', ornament: 'none', clearance: 'none' }),
  Object.freeze({ id: 'valentines', label: "Valentine's Day", ready: true, artwork: '/themes/valentines.webp', ornament: 'hearts', clearance: 'sm' }),
  Object.freeze({ id: 'st-patricks', label: "St. Patrick's Day", ready: true, artwork: '/themes/st-patricks.webp', ornament: 'shamrock', clearance: 'sm' }),
  Object.freeze({ id: 'easter', label: 'Easter', ready: true, artwork: '/themes/easter.webp', ornament: 'ears', clearance: 'md' }),
  Object.freeze({ id: 'spring', label: 'Spring', ready: true, artwork: '/themes/spring.webp', ornament: 'daisy', clearance: 'sm' }),
  Object.freeze({ id: 'summer', label: 'Summer', ready: true, artwork: '/themes/summer.webp', ornament: 'sun', clearance: 'sm' }),
  Object.freeze({ id: 'fall', label: 'Fall', ready: true, artwork: '/themes/fall.webp', ornament: 'leaf', clearance: 'sm' }),
  Object.freeze({ id: 'winter', label: 'Winter', ready: true, artwork: '/themes/winter.webp', ornament: 'snowcap', clearance: 'sm' }),
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

// How an uploaded picture is drawn behind the dashboard: `cover` fills the
// page and crops the edges, `contain` shows the whole picture over a blurred
// copy of itself, `tile` repeats a small image. Anything else reads as cover.
export const DASHBOARD_THEME_IMAGE_FITS = Object.freeze(['cover', 'contain', 'tile']);
export const DASHBOARD_THEME_IMAGE_FIT_LABELS = Object.freeze({ cover: 'Fill the page', contain: 'Fit the whole picture', tile: 'Tile' });
export function normalizeImageFit(value) {
  return DASHBOARD_THEME_IMAGE_FITS.includes(value) ? value : 'cover';
}

export function imageDashboardTheme(assetId, schoolId, fit = 'cover') {
  return Object.freeze({ id: 'image', label: 'Your background', ready: true, artwork: dashboardThemeAssetUrl(assetId, schoolId), ornament: 'none', clearance: 'none', fit: normalizeImageFit(fit) });
}

// With `calendar: true` the date picks the preset to draw. A theme the server
// derived from the school (`source: 'school'`) uses the school's own holiday
// list, lead time and early starts (`calendar`); a teacher's own calendar may
// show every holiday, with the stored preset only an Advent hint. `none` is
// the teacher's deliberate "plain dashboard" and resolves to nothing. An
// uploaded image resolves to a neutral-glass "image" look over the asset.
export function resolveDashboardTheme(theme, { enabled = true, now = new Date(), timeZone = 'America/New_York', schoolId = null, uploadsEnabled = true, calendar = null } = {}) {
  if (!enabled || !theme || typeof theme !== 'object') return null;
  if (theme.kind === 'image') return uploadsEnabled && typeof theme.imageAssetId === 'string' && theme.imageAssetId ? imageDashboardTheme(theme.imageAssetId, schoolId, theme.fit) : null;
  if (theme.kind !== 'preset') return null;
  const id = theme.calendar === true
    ? calendarPresetFor(localDateParts(now, timeZone || 'America/New_York'), {
      allowed: theme.source === 'school' ? (calendar?.holidays ?? DEFAULT_CALENDAR_HOLIDAYS) : teacherCalendarHolidays(theme.preset),
      leadDays: calendar?.leadDays, starts: calendar?.starts ?? {},
    })
    : theme.preset;
  const preset = findDashboardThemePreset(id);
  return preset && preset.ready ? preset : null;
}

// The theme a teacher who follows the school sees today, from the preferences
// DTO (`schoolTheme` plus `schoolCalendar`), or null when the school has none.
export function resolveSchoolTheme(preferences, { now = new Date(), timeZone } = {}) {
  if (!preferences || typeof preferences !== 'object') return null;
  return resolveDashboardTheme(preferences.schoolTheme ?? null, { now, timeZone, calendar: preferences.schoolCalendar ?? null, uploadsEnabled: false });
}

// A stored preset the catalog no longer ships (or never shipped yet).
export function isUnavailableDashboardTheme(theme) {
  return Boolean(theme && typeof theme === 'object' && theme.kind === 'preset' && !resolveDashboardTheme(theme));
}

export function describeDashboardTheme(theme) {
  if (!theme || typeof theme !== 'object') return 'Follow the school';
  if (theme.kind === 'none') return 'Plain, no theme';
  if (typeof theme.name === 'string' && theme.name.trim()) return theme.name.trim();
  if (theme.kind === 'preset') return (theme.calendar === true ? 'Calendar: ' : '') + (findDashboardThemePreset(theme.preset)?.label || 'Unavailable theme');
  return 'Your background';
}
