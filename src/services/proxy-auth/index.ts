import { PROXY_CONFIG } from '../../constants';
import { SecureStorage } from '../secure-storage';

export const PROXY_NOT_CONFIGURED_MESSAGE =
  'El servidor proxy no está configurado. Define EXPO_PUBLIC_PROXY_BASE_URL y vuelve a compilar la app.';

/**
 * Every proxy call goes through here, so this is the single place that stops
 * requests to relative URLs ("/api/v1/…") when the build has no proxy URL.
 */
export async function getProxyAuthHeaders(extraHeaders: Record<string, string> = {}): Promise<Record<string, string>> {
  if (!PROXY_CONFIG.baseUrl) {
    throw new Error(PROXY_NOT_CONFIGURED_MESSAGE);
  }
  const storedToken = await SecureStorage.getProxyToken();
  const token = storedToken || PROXY_CONFIG.appToken;
  const authHeaders: Record<string, string> = {};
  if (token) {
    authHeaders.Authorization = `Bearer ${token}`;
    authHeaders['X-App-Token'] = token;
  }

  return {
    ...authHeaders,
    ...extraHeaders,
  };
}
