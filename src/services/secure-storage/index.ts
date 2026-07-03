import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { APIKeys } from '../../types';

const KEY_PREFIX = 'smartglassesai_key_';
const PROXY_DEVICE_AUTH_KEY = 'smartglassesai_proxy_device_auth';

export type ProxyDeviceAuth = {
  token: string;
  deviceId: string;
  deviceName: string;
  scopes: string[];
  expiresAt: number;
};

function storageKey(provider: keyof APIKeys): string {
  return `${KEY_PREFIX}${provider}`;
}

async function getStoredString(key: string): Promise<string | null> {
  if (Platform.OS === 'web') {
    return AsyncStorage.getItem(key);
  }
  return SecureStore.getItemAsync(key);
}

async function setStoredString(key: string, value: string): Promise<void> {
  if (Platform.OS === 'web') {
    await AsyncStorage.setItem(key, value);
    return;
  }
  await SecureStore.setItemAsync(key, value);
}

async function deleteStoredString(key: string): Promise<void> {
  if (Platform.OS === 'web') {
    await AsyncStorage.removeItem(key);
    return;
  }
  await SecureStore.deleteItemAsync(key);
}

async function getStoredKey(provider: keyof APIKeys): Promise<string | null> {
  return getStoredString(storageKey(provider));
}

async function setStoredKey(provider: keyof APIKeys, key: string): Promise<void> {
  await setStoredString(storageKey(provider), key);
}

async function deleteStoredKey(provider: keyof APIKeys): Promise<void> {
  await deleteStoredString(storageKey(provider));
}

/**
 * Secure storage for API keys using expo-secure-store (iOS Keychain / Android Keystore).
 *
 * Secrets must never be read from EXPO_PUBLIC_* values in the mobile bundle.
 * Runtime keys come only from manual secure storage entries, or from the
 * backend proxy keeping provider credentials server-side.
 */
export const SecureStorage = {
  async saveAPIKey(provider: keyof APIKeys, key: string): Promise<boolean> {
    try {
      await setStoredKey(provider, key);
      return true;
    } catch (error) {
      console.error('[SecureStorage] Save error');
      return false;
    }
  },

  async getAPIKey(provider: keyof APIKeys): Promise<string | null> {
    try {
      return await getStoredKey(provider);
    } catch (error) {
      console.error('[SecureStorage] Get error');
      return null;
    }
  },

  async deleteAPIKey(provider: keyof APIKeys): Promise<boolean> {
    try {
      await deleteStoredKey(provider);
      return true;
    } catch (error) {
      console.error('[SecureStorage] Delete error');
      return false;
    }
  },

  async hasKey(provider: keyof APIKeys): Promise<boolean> {
    try {
      const stored = await getStoredKey(provider);
      return !!stored;
    } catch {
      return false;
    }
  },

  async getKeyStatus(): Promise<Record<string, boolean>> {
    const providers: (keyof APIKeys)[] = ['openai', 'anthropic', 'elevenlabs', 'google', 'minimax', 'opencode', 'nvidia'];
    const status: Record<string, boolean> = {};
    for (const p of providers) {
      status[p] = await this.hasKey(p);
    }
    return status;
  },

  async saveProxyDeviceAuth(auth: ProxyDeviceAuth): Promise<boolean> {
    try {
      await setStoredString(PROXY_DEVICE_AUTH_KEY, JSON.stringify(auth));
      return true;
    } catch (error) {
      console.error('[SecureStorage] Proxy auth save error');
      return false;
    }
  },

  async getProxyDeviceAuth(): Promise<ProxyDeviceAuth | null> {
    try {
      const raw = await getStoredString(PROXY_DEVICE_AUTH_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as ProxyDeviceAuth;
      if (!parsed.token || !parsed.deviceId) return null;
      return parsed;
    } catch (error) {
      console.error('[SecureStorage] Proxy auth get error');
      return null;
    }
  },

  async getProxyToken(): Promise<string | null> {
    const auth = await this.getProxyDeviceAuth();
    return auth?.token ?? null;
  },

  async deleteProxyDeviceAuth(): Promise<boolean> {
    try {
      await deleteStoredString(PROXY_DEVICE_AUTH_KEY);
      return true;
    } catch (error) {
      console.error('[SecureStorage] Proxy auth delete error');
      return false;
    }
  },
};
