// PassPilot kiosk side of dashboard themes.
//
// The server decides whose theme a kiosk shows (school lock, then the bound
// teacher, then the school default) and already turns calendar mode into
// today's preset, so the kiosk only maps a concrete theme to its look, its
// greeting and the shape the student's first name sits in. Presentation only:
// the kiosk ticket, checkout and check-in flows never read any of this.

import { findDashboardThemePreset, normalizeImageFit } from './presets.js';

// One name plate per preset: the SVG shape (KioskNamePlate) and how a screen
// reader hears it ("Ada, carved on a jack-o-lantern").
export const KIOSK_PLATES = Object.freeze({
  halloween: Object.freeze({ shape: 'pumpkin', on: 'carved on a jack-o-lantern' }),
  thanksgiving: Object.freeze({ shape: 'turkey', on: 'on a turkey' }),
  christmas: Object.freeze({ shape: 'stocking', on: 'written on a stocking' }),
  advent: Object.freeze({ shape: 'wreath', on: 'inside an Advent wreath' }),
  valentines: Object.freeze({ shape: 'heart', on: 'inside a heart' }),
  'st-patricks': Object.freeze({ shape: 'shamrock', on: 'on a shamrock' }),
  easter: Object.freeze({ shape: 'egg', on: 'on an Easter egg' }),
  spring: Object.freeze({ shape: 'flower', on: 'on a flower' }),
  summer: Object.freeze({ shape: 'sun', on: 'on a sun' }),
  fall: Object.freeze({ shape: 'leaf', on: 'on a leaf' }),
  winter: Object.freeze({ shape: 'snowflake', on: 'on a snowflake ornament' }),
  image: Object.freeze({ shape: 'glass', on: 'on a glass plate' }),
});

// Welcome-back copy per preset. Holidays greet by name; Advent and the seasons
// keep the plain welcome so the school chooses its own religious wording.
const GREETINGS = Object.freeze({
  halloween: name => `Happy Halloween, ${name}!`,
  thanksgiving: name => `Happy Thanksgiving, ${name}!`,
  christmas: name => `Merry Christmas, ${name}!`,
  valentines: name => `Happy Valentine's Day, ${name}!`,
  'st-patricks': name => `Happy St. Patrick's Day, ${name}!`,
  easter: name => `Happy Easter, ${name}!`,
});

export const KIOSK_PLATE_MAX_NAME_LENGTH = 14;

// A concrete theme from the server into the kiosk's look. Unknown or retired
// presets and malformed values resolve to null, which is the kiosk's current
// look: a missing theme is never an error on a shared device.
export function resolveKioskTheme(theme) {
  if (!theme || typeof theme !== 'object') return null;
  if (theme.kind === 'preset') {
    const preset = findDashboardThemePreset(theme.preset);
    if (!preset || !preset.ready) return null;
    return { id: preset.id, label: preset.label, artwork: preset.artwork, plate: KIOSK_PLATES[preset.id] ?? null, imageAssetId: null };
  }
  if (theme.kind === 'image' && typeof theme.imageAssetId === 'string' && theme.imageAssetId) {
    return { id: 'image', label: 'Custom background', artwork: null, plate: KIOSK_PLATES.image, imageAssetId: theme.imageAssetId, fit: normalizeImageFit(theme.fit) };
  }
  return null;
}

export function kioskFirstName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name) return '';
  return name.length > KIOSK_PLATE_MAX_NAME_LENGTH ? `${name.slice(0, KIOSK_PLATE_MAX_NAME_LENGTH - 1)}…` : name;
}

export function kioskGreeting(themeId, firstName) {
  const name = kioskFirstName(firstName);
  if (!name) return 'Welcome back!';
  const greet = GREETINGS[themeId];
  return greet ? greet(name) : `Welcome back, ${name}!`;
}

export function kioskPlateLabel(themeId, firstName) {
  const name = kioskFirstName(firstName);
  const plate = KIOSK_PLATES[themeId];
  return plate && name ? `${name}, ${plate.on}` : name;
}

// Uploaded backgrounds are fetched with the kiosk's own credential (token and
// session headers), never from a public URL, so the kiosk client requests
// this path and paints the bytes it gets back.
export function kioskThemeAssetPath(assetId) {
  return `/api/passpilot/kiosk/theme-asset/${encodeURIComponent(assetId)}/content`;
}
