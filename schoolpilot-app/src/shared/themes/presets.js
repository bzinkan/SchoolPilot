// Preloaded ClassPilot dashboard themes.
//
// The server mirrors DASHBOARD_THEME_PRESET_IDS in
// src/services/classpilotThemes.ts and a test keeps the two lists identical.
// A theme is presentation only: it recolors the console chrome, paints the
// page background and adds a small ornament to each tile. Student status
// colors, badges and layout never come from here.

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

// `ready` presets ship artwork and CSS; the rest are reserved ids until their
// phase lands, so a stored id never has to change when they arrive.
// `clearance` is the extra room an ornament that rises above the tile needs.
const PRESETS = Object.freeze([
  Object.freeze({ id: 'halloween', label: 'Halloween', ready: true, artwork: '/themes/halloween.svg', ornament: 'cobweb', clearance: 'none' }),
  Object.freeze({ id: 'thanksgiving', label: 'Thanksgiving', ready: true, artwork: '/themes/thanksgiving.svg', ornament: 'turkey', clearance: 'md' }),
  Object.freeze({ id: 'christmas', label: 'Christmas', ready: true, artwork: '/themes/christmas.svg', ornament: 'lights', clearance: 'sm' }),
  Object.freeze({ id: 'advent', label: 'Advent', ready: false, artwork: '/themes/advent.svg', ornament: 'none', clearance: 'none' }),
  Object.freeze({ id: 'valentines', label: "Valentine's Day", ready: false, artwork: '/themes/valentines.svg', ornament: 'hearts', clearance: 'sm' }),
  Object.freeze({ id: 'st-patricks', label: "St. Patrick's Day", ready: false, artwork: '/themes/st-patricks.svg', ornament: 'shamrock', clearance: 'sm' }),
  Object.freeze({ id: 'easter', label: 'Easter', ready: false, artwork: '/themes/easter.svg', ornament: 'ears', clearance: 'md' }),
  Object.freeze({ id: 'spring', label: 'Spring', ready: false, artwork: '/themes/spring.svg', ornament: 'daisy', clearance: 'sm' }),
  Object.freeze({ id: 'summer', label: 'Summer', ready: false, artwork: '/themes/summer.svg', ornament: 'sun', clearance: 'sm' }),
  Object.freeze({ id: 'fall', label: 'Fall', ready: false, artwork: '/themes/fall.svg', ornament: 'leaf', clearance: 'sm' }),
  Object.freeze({ id: 'winter', label: 'Winter', ready: false, artwork: '/themes/winter.svg', ornament: 'snowcap', clearance: 'sm' }),
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
export function resolveDashboardTheme(theme, { enabled = true } = {}) {
  if (!enabled || !theme || typeof theme !== 'object') return null;
  if (theme.kind !== 'preset') return null; // uploaded images arrive in a later phase
  const preset = findDashboardThemePreset(theme.preset);
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
