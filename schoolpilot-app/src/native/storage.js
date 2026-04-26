import { Capacitor } from '@capacitor/core';

const isNative = Capacitor.isNativePlatform();
const KEY = 'sp_token';

/**
 * JWT secure storage for the native (Capacitor) app.
 *
 * Uses `capacitor-secure-storage-plugin` which writes to:
 *   - Android: Android Keystore (hardware-backed where available)
 *   - iOS: Keychain (encrypted, app-sandboxed)
 *
 * On first run after the upgrade, we migrate existing tokens from the legacy
 * `@capacitor/preferences` (SharedPreferences / NSUserDefaults — NOT encrypted)
 * to the secure store, then delete the legacy copy. Older app builds without the
 * native plugin gracefully fall back to Preferences so existing users aren't
 * locked out before they update.
 */

let _secureUnavailable = false; // cache: true once we confirm the plugin isn't on the device

async function getSecure() {
  if (_secureUnavailable) return null;
  try {
    const mod = await import('capacitor-secure-storage-plugin');
    return mod.SecureStoragePlugin;
  } catch {
    _secureUnavailable = true;
    return null;
  }
}

async function getPrefs() {
  const { Preferences } = await import('@capacitor/preferences');
  return Preferences;
}

export async function saveToken(token) {
  if (!isNative) return;
  const secure = await getSecure();
  if (secure) {
    try {
      await secure.set({ key: KEY, value: token });
      // Best-effort cleanup of legacy plaintext copy
      const Preferences = await getPrefs();
      await Preferences.remove({ key: KEY }).catch(() => {});
      return;
    } catch {
      // Fall through to Preferences if secure store fails for any reason
    }
  }
  const Preferences = await getPrefs();
  await Preferences.set({ key: KEY, value: token });
}

export async function loadToken() {
  if (!isNative) return null;
  const secure = await getSecure();
  if (secure) {
    try {
      const result = await secure.get({ key: KEY });
      if (result?.value) return result.value;
    } catch {
      // Key not found in secure store — try legacy
    }
    // Migrate from legacy Preferences if found
    const Preferences = await getPrefs();
    const legacy = await Preferences.get({ key: KEY });
    if (legacy?.value) {
      try {
        await secure.set({ key: KEY, value: legacy.value });
        await Preferences.remove({ key: KEY });
      } catch {
        // If migration fails, keep returning the legacy value so user stays signed in
      }
      return legacy.value;
    }
    return null;
  }
  // Fallback for older app builds without the native plugin
  const Preferences = await getPrefs();
  const { value } = await Preferences.get({ key: KEY });
  return value || null;
}

export async function clearToken() {
  if (!isNative) return;
  const secure = await getSecure();
  if (secure) {
    try {
      await secure.remove({ key: KEY });
    } catch { /* ignore */ }
  }
  const Preferences = await getPrefs();
  await Preferences.remove({ key: KEY }).catch(() => {});
}
