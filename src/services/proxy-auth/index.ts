import { PROXY_CONFIG } from '../../constants';
import { SecureStorage } from '../secure-storage';

export async function getProxyAuthHeaders(extraHeaders: Record<string, string> = {}): Promise<Record<string, string>> {
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
