import { Capacitor } from '@capacitor/core';
import { SecureStoragePlugin } from 'capacitor-secure-storage-plugin';

const isNative = Capacitor.isNativePlatform();
const KEY = 'sp_token';
const productName = import.meta.env.VITE_APP_PRODUCT === 'passpilot' ? 'PassPilot' : 'GoPilot';

export class SecureStorageUnavailableError extends Error {
  constructor(message = `Secure device storage is unavailable. ${productName} cannot sign in safely on this device.`) {
    super(message);
    this.name = 'SecureStorageUnavailableError';
    this.code = 'NATIVE_SECURE_STORAGE_UNAVAILABLE';
  }
}

async function requireSecureStorage() {
  if (!isNative) return null;
  if (!Capacitor.isPluginAvailable('SecureStoragePlugin')) {
    throw new SecureStorageUnavailableError();
  }
  try {
    await SecureStoragePlugin.getPlatform();
    return SecureStoragePlugin;
  } catch {
    throw new SecureStorageUnavailableError();
  }
}

export async function saveToken(token) {
  if (!isNative) return;
  if (!token) throw new TypeError('A non-empty authentication token is required.');
  const secure = await requireSecureStorage();
  try {
    await secure.set({ key: KEY, value: token });
    const verification = await secure.get({ key: KEY });
    if (verification?.value !== token) {
      throw new Error('Secure-storage verification did not match');
    }
  } catch {
    throw new SecureStorageUnavailableError(`${productName} could not protect the sign-in token. Sign-in was stopped.`);
  }
}

export async function loadToken() {
  if (!isNative) return null;
  const secure = await requireSecureStorage();
  try {
    const result = await secure.get({ key: KEY });
    if (!result?.value) throw new Error('Stored token is empty');
    return result.value;
  } catch (error) {
    // Missing includes a legacy/corrupt value that the native fork removed and
    // verified before returning this code. Stay signed out and never publish it.
    if (error?.code === 'SECURE_STORAGE_ITEM_NOT_FOUND') return null;
    if (error instanceof SecureStorageUnavailableError) throw error;
    throw new SecureStorageUnavailableError(`${productName} could not read protected sign-in data. Sign in again after securing this device.`);
  }
}

export async function clearToken() {
  if (!isNative) return;
  const secure = await requireSecureStorage();
  try {
    const { value: keys = [] } = await secure.keys();
    if (keys.includes(KEY)) await secure.remove({ key: KEY });
  } catch {
    throw new SecureStorageUnavailableError(`${productName} could not clear protected sign-in data on this device.`);
  }
}
