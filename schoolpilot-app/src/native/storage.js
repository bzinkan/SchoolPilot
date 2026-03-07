import { Capacitor } from '@capacitor/core';

const isNative = Capacitor.isNativePlatform();

export async function saveToken(token) {
  if (!isNative) return;
  const { Preferences } = await import('@capacitor/preferences');
  await Preferences.set({ key: 'sp_token', value: token });
}

export async function loadToken() {
  if (!isNative) return null;
  const { Preferences } = await import('@capacitor/preferences');
  const { value } = await Preferences.get({ key: 'sp_token' });
  return value;
}

export async function clearToken() {
  if (!isNative) return;
  const { Preferences } = await import('@capacitor/preferences');
  await Preferences.remove({ key: 'sp_token' });
}
