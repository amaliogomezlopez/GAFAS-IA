import { SecureStorage } from '../secure-storage';
import { getProxyAuthHeaders } from '../proxy-auth';
import { API_ENDPOINTS } from '../../constants';
import { ConversationMessage, LLMProvider } from '../../types';
import { Platform } from 'react-native';
import { LogService } from '../LogService';

type ChatOptions = {
  maxTokens?: number;
  signal?: AbortSignal;
};

type StreamOptions = ChatOptions & {
  onDelta?: (delta: string, fullText: string) => void;
};

const DEFAULT_MAX_TOKENS = 320;
const HERMES_MIN_MAX_TOKENS = 640;
const PROXY_HEALTH_TIMEOUT_MS = 900;
const PROXY_HEALTH_TTL_MS = 60_000;

type ProxyHealthState = {
  checkedAt: number;
  healthy: boolean | null;
};

export type HermesStatus = {
  status: 'ok' | 'error' | 'unknown';
  runtime?: {
    provider?: string | null;
    model?: string | null;
    allowed_models?: string[];
    switching_enabled?: boolean;
    context_length?: string;
  };
  capabilities?: {
    features?: Record<string, boolean>;
    model?: string;
  } | null;
  error?: string;
};

export type ProxyDevicePairResponse = {
  status: 'ok';
  token: string;
  device_id: string;
  device_name: string;
  scopes: string[];
  expires_at: number;
};

export type ProxyAuthStatus = {
  status: 'ok';
  device_auth_enabled: boolean;
  device?: {
    id: string;
    name: string;
    scopes: string[];
    expires_at: number;
    last_seen_at?: number | null;
  };
};

let proxyHealthState: ProxyHealthState = {
  checkedAt: 0,
  healthy: null,
};

const sanitizeError = (status: number, body: string): string => {
  const sanitized = body.replace(/(?:sk-|Bearer\s+)[a-zA-Z0-9_-]{10,}/g, '[REDACTED]');
  const truncated = sanitized.length > 200 ? sanitized.substring(0, 200) + '...' : sanitized;
  return `LLM error (${status}): ${truncated}`;
};

const describeFetchFailure = (service: string, error: unknown): Error => {
  if (error instanceof Error && error.name === 'AbortError') {
    return error;
  }

  const raw = error instanceof Error ? error.message : String(error);
  if (Platform.OS === 'web' && /failed to fetch|network request failed|load failed/i.test(raw)) {
    return new Error(
      `${service}: Chrome no pudo conectar con el servicio. Si acabas de cambiar el proxy, recarga la web; si persiste, revisa la conexion o CORS.`,
    );
  }
  return new Error(`${service}: ${raw || 'fallo de red'}`);
};

function shouldReuseProxyHealth(): boolean {
  return Date.now() - proxyHealthState.checkedAt < PROXY_HEALTH_TTL_MS && proxyHealthState.healthy !== null;
}

function markProxyHealth(healthy: boolean): void {
  proxyHealthState = {
    checkedAt: Date.now(),
    healthy,
  };
}

async function fetchJsonText(response: Response): Promise<string> {
  const data = await response.json();
  const textEntry = data.content?.find((chunk: any) => chunk.type === 'text');
  return textEntry?.text ?? data.content?.[0]?.text ?? '';
}

async function requestMiniMaxDirect(
  apiKey: string,
  model: string,
  systemPrompt: string,
  messages: Array<{ role: string; content: string }>,
  maxTokens: number,
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(API_ENDPOINTS.minimax.chat, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      system: systemPrompt,
      messages,
      max_tokens: maxTokens,
    }),
    signal,
  });
}

async function requestOpenAICompatible(
  url: string,
  apiKey: string | null,
  model: string,
  systemPrompt: string,
  messages: ConversationMessage[],
  maxTokens: number,
  signal?: AbortSignal,
  extraHeaders: Record<string, string> = {},
  serviceName: string = 'LLM',
): Promise<string> {
  const formattedMessages = [
    { role: 'system', content: systemPrompt },
    ...messages.map((message) => ({ role: message.role, content: message.content })),
  ];
  const authHeaders: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
        ...extraHeaders,
      },
      body: JSON.stringify({
        model,
        messages: formattedMessages,
        max_tokens: maxTokens,
      }),
      signal,
    });
  } catch (error) {
    throw describeFetchFailure(serviceName, error);
  }

  if (!response.ok) {
    throw new Error(sanitizeError(response.status, await response.text()));
  }

  const data = await response.json();
  const choice = data.choices?.[0];
  const content = choice?.message?.content;
  if (Array.isArray(content)) {
    return content.map((chunk: any) => chunk?.text ?? '').join('').trim();
  }
  const text = content ?? choice?.delta?.content ?? '';
  if (!text && choice?.finish_reason === 'length' && choice?.message?.reasoning_content) {
    throw new Error(`${serviceName}: el modelo agotó tokens razonando antes de responder. Sube el límite de tokens o usa un modelo más directo.`);
  }
  return text;
}

async function requestAnthropicCompatible(
  url: string,
  apiKey: string | null,
  model: string,
  systemPrompt: string,
  messages: ConversationMessage[],
  maxTokens: number,
  signal?: AbortSignal,
  extraHeaders: Record<string, string> = {},
  serviceName: string = 'LLM',
): Promise<string> {
  const authHeaders: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}`, 'x-api-key': apiKey } : {};
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
        'anthropic-version': '2023-06-01',
        ...extraHeaders,
      },
      body: JSON.stringify({
        model,
        system: systemPrompt,
        messages: messages.map((message) => ({ role: message.role, content: message.content })),
        max_tokens: maxTokens,
      }),
      signal,
    });
  } catch (error) {
    throw describeFetchFailure(serviceName, error);
  }

  if (!response.ok) {
    throw new Error(sanitizeError(response.status, await response.text()));
  }

  const data = await response.json();
  const textEntry = data.content?.find((chunk: any) => chunk.type === 'text');
  const text = textEntry?.text ?? data.content?.[0]?.text ?? data.choices?.[0]?.message?.content ?? '';
  if (!text && data.choices?.[0]?.finish_reason === 'length' && data.choices?.[0]?.message?.reasoning_content) {
    throw new Error(`${serviceName}: el modelo agotó tokens razonando antes de responder. Sube el límite de tokens o usa un modelo más directo.`);
  }
  return text;
}

function isOpenCodeAnthropicModel(model: string): boolean {
  return model === 'minimax-m2.7' || model === 'minimax-m2.5';
}

function getOpenCodeMaxTokens(model: string, requestedMaxTokens: number): number {
  // OpenCode reasoning models can spend hundreds of tokens in
  // reasoning_content, leaving message.content empty if the cap is too low.
  const minimumForReasoningModels = 1024;
  return Math.max(requestedMaxTokens, minimumForReasoningModels);
}

function extractStreamDelta(payload: any): string {
  const choice = payload?.choices?.[0];
  const content = choice?.delta?.content ?? choice?.message?.content ?? '';
  if (Array.isArray(content)) {
    return content.map((chunk: any) => chunk?.text ?? '').join('');
  }
  return typeof content === 'string' ? content : '';
}

async function requestOpenAICompatibleStream(
  url: string,
  apiKey: string | null,
  model: string,
  systemPrompt: string,
  messages: ConversationMessage[],
  maxTokens: number,
  options: StreamOptions = {},
  extraHeaders: Record<string, string> = {},
  serviceName: string = 'LLM',
): Promise<{ text: string; streamed: boolean }> {
  const formattedMessages = [
    { role: 'system', content: systemPrompt },
    ...messages.map((message) => ({ role: message.role, content: message.content })),
  ];
  const authHeaders: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
        ...extraHeaders,
      },
      body: JSON.stringify({
        model,
        messages: formattedMessages,
        max_tokens: maxTokens,
        stream: true,
      }),
      signal: options.signal,
    });
  } catch (error) {
    throw describeFetchFailure(serviceName, error);
  }

  if (!response.ok) {
    throw new Error(sanitizeError(response.status, await response.text()));
  }

  const body = response.body as any;
  const reader = body?.getReader?.();
  if (!reader || typeof TextDecoder === 'undefined') {
    const fallback = await response.text();
    return { text: fallback, streamed: false };
  }

  const decoder = new TextDecoder();
  let pending = '';
  let fullText = '';
  let streamed = false;

  const consumeLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(':')) return;
    const raw = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
    if (!raw || raw === '[DONE]') return;
    try {
      const payload = JSON.parse(raw);
      const delta = extractStreamDelta(payload);
      if (delta) {
        streamed = true;
        fullText += delta;
        options.onDelta?.(delta, fullText);
      }
    } catch {
      // Some proxies may coalesce non-SSE JSON fragments. Keep waiting.
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? '';
    lines.forEach(consumeLine);
  }
  pending += decoder.decode();
  pending.split(/\r?\n/).forEach(consumeLine);

  return { text: fullText, streamed };
}

function getHermesMaxTokens(requestedMaxTokens: number): number {
  return Math.max(requestedMaxTokens, HERMES_MIN_MAX_TOKENS);
}

export const LLMService = {
  async pairProxyDevice(code: string, deviceName: string = 'Amalio iPhone', signal?: AbortSignal): Promise<ProxyDevicePairResponse> {
    let response: Response;
    try {
      response = await fetch(API_ENDPOINTS.proxy.authPair, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: code.trim(),
          device_name: deviceName.trim() || 'Amalio iPhone',
          client: 'smartglasses',
        }),
        signal,
      });
    } catch (error) {
      throw describeFetchFailure('Proxy pairing', error);
    }

    if (!response.ok) {
      throw new Error(sanitizeError(response.status, await response.text()));
    }

    const data = await response.json() as ProxyDevicePairResponse;
    const saved = await SecureStorage.saveProxyDeviceAuth({
      token: data.token,
      deviceId: data.device_id,
      deviceName: data.device_name,
      scopes: data.scopes,
      expiresAt: data.expires_at,
    });
    if (!saved) {
      throw new Error('Proxy pairing: no se pudo guardar el token del dispositivo.');
    }
    return data;
  },

  async getProxyAuthStatus(signal?: AbortSignal): Promise<ProxyAuthStatus> {
    let response: Response;
    try {
      response = await fetch(API_ENDPOINTS.proxy.authStatus, {
        method: 'GET',
        headers: await getProxyAuthHeaders(),
        signal,
      });
    } catch (error) {
      throw describeFetchFailure('Proxy auth status', error);
    }

    if (!response.ok) {
      throw new Error(sanitizeError(response.status, await response.text()));
    }

    return response.json();
  },

  async revokeProxyDevice(signal?: AbortSignal): Promise<void> {
    let response: Response;
    try {
      response = await fetch(API_ENDPOINTS.proxy.authRevokeSelf, {
        method: 'POST',
        headers: await getProxyAuthHeaders(),
        signal,
      });
    } catch (error) {
      throw describeFetchFailure('Proxy auth revoke', error);
    }

    await SecureStorage.deleteProxyDeviceAuth();
    if (!response.ok) {
      throw new Error(sanitizeError(response.status, await response.text()));
    }
  },

  async getHermesStatus(signal?: AbortSignal): Promise<HermesStatus> {
    let response: Response;
    try {
      response = await fetch(API_ENDPOINTS.proxy.hermesStatus, {
        method: 'GET',
        headers: await getProxyAuthHeaders(),
        signal,
      });
    } catch (error) {
      throw describeFetchFailure('Hermes status', error);
    }

    if (!response.ok) {
      throw new Error(sanitizeError(response.status, await response.text()));
    }

    return response.json();
  },

  async switchHermesModel(model: string, signal?: AbortSignal): Promise<HermesStatus['runtime']> {
    let response: Response;
    try {
      response = await fetch(API_ENDPOINTS.proxy.hermesModel, {
        method: 'POST',
        headers: {
          ...(await getProxyAuthHeaders()),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model }),
        signal,
      });
    } catch (error) {
      throw describeFetchFailure('Hermes model switch', error);
    }

    if (!response.ok) {
      throw new Error(sanitizeError(response.status, await response.text()));
    }

    return response.json();
  },

  async refreshProxyHealth(force: boolean = false): Promise<boolean> {
    if (!force && shouldReuseProxyHealth()) {
      return proxyHealthState.healthy === true;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROXY_HEALTH_TIMEOUT_MS);

    try {
      const response = await fetch(API_ENDPOINTS.proxy.health, {
        method: 'GET',
        headers: await getProxyAuthHeaders(),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const healthy = response.ok;
      markProxyHealth(healthy);
      return healthy;
    } catch {
      clearTimeout(timeout);
      markProxyHealth(false);
      return false;
    }
  },

  async chat(
    messages: ConversationMessage[],
    systemPrompt: string,
    provider: LLMProvider,
    model: string,
    options: ChatOptions = {},
  ): Promise<string> {
    switch (provider) {
      case 'hermes':
        return this.chatHermes(messages, systemPrompt, model, options);
      case 'openai':
        return this.chatOpenAI(messages, systemPrompt, model, options);
      case 'anthropic':
        return this.chatAnthropic(messages, systemPrompt, model, options);
      case 'google':
        return this.chatGoogle(messages, systemPrompt, model, options);
      case 'minimax':
        return this.chatMiniMax(messages, systemPrompt, model, options);
      case 'opencode':
        return this.chatOpenCode(messages, systemPrompt, model, options);
      case 'nvidia':
        return this.chatNvidia(messages, systemPrompt, model, options);
      default:
        throw new Error(`Unsupported LLM provider: ${provider}`);
    }
  },

  async chatStream(
    messages: ConversationMessage[],
    systemPrompt: string,
    provider: LLMProvider,
    model: string,
    options: StreamOptions = {},
  ): Promise<{ text: string; streamed: boolean }> {
    if (provider === 'hermes') {
      const proxyHeaders = await getProxyAuthHeaders({
        'X-Hermes-Session-Key': 'smartglasses-kairo',
        'X-Hermes-Client': 'smartglasses',
      });
      const result = await requestOpenAICompatibleStream(
        API_ENDPOINTS.proxy.hermesChat,
        null,
        model || 'hermes-agent',
        systemPrompt,
        messages,
        getHermesMaxTokens(options.maxTokens ?? DEFAULT_MAX_TOKENS),
        options,
        proxyHeaders,
        'Hermes proxy stream',
      );
      if (result.streamed) return result;
    }

    if (provider === 'opencode' && !isOpenCodeAnthropicModel(model)) {
      const proxyHeaders = await getProxyAuthHeaders();
      try {
        const result = await requestOpenAICompatibleStream(
          API_ENDPOINTS.proxy.opencodeChat,
          null,
          model,
          systemPrompt,
          messages,
          getOpenCodeMaxTokens(model, options.maxTokens ?? DEFAULT_MAX_TOKENS),
          options,
          proxyHeaders,
          'OpenCode proxy stream',
        );
        if (result.streamed) return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        LogService.warn('LLM', `OpenCode streaming unavailable: ${message}`);
      }
    }

    const text = await this.chat(messages, systemPrompt, provider, model, options);
    return { text, streamed: false };
  },

  async chatHermes(
    messages: ConversationMessage[],
    systemPrompt: string,
    model: string,
    options: ChatOptions = {},
  ): Promise<string> {
    const proxyHeaders = await getProxyAuthHeaders({
      'X-Hermes-Session-Key': 'smartglasses-kairo',
      'X-Hermes-Client': 'smartglasses',
    });
    return requestOpenAICompatible(
      API_ENDPOINTS.proxy.hermesChat,
      null,
      model || 'hermes-agent',
      systemPrompt,
      messages,
      getHermesMaxTokens(options.maxTokens ?? DEFAULT_MAX_TOKENS),
      options.signal,
      proxyHeaders,
      'Hermes proxy',
    );
  },

  async chatOpenAI(
    messages: ConversationMessage[],
    systemPrompt: string,
    model: string,
    options: ChatOptions = {},
  ): Promise<string> {
    const apiKey = await SecureStorage.getAPIKey('openai');
    if (!apiKey) throw new Error('OpenAI API key not configured.');

    const formattedMessages = [
      { role: 'system', content: systemPrompt },
      ...messages.map((message) => ({ role: message.role, content: message.content })),
    ];

    const response = await fetch(API_ENDPOINTS.openai.chat, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
    body: JSON.stringify({
      model,
      messages: formattedMessages,
      max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
    }),
    signal: options.signal,
  });

    if (!response.ok) {
      throw new Error(sanitizeError(response.status, await response.text()));
    }

    const data = await response.json();
    return data.choices[0].message.content;
  },

  async chatAnthropic(
    messages: ConversationMessage[],
    systemPrompt: string,
    model: string,
    options: ChatOptions = {},
  ): Promise<string> {
    const apiKey = await SecureStorage.getAPIKey('anthropic');
    if (!apiKey) throw new Error('Anthropic API key not configured.');

    const response = await fetch(API_ENDPOINTS.anthropic.chat, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
    body: JSON.stringify({
      model,
      system: systemPrompt,
      messages: messages.map((message) => ({ role: message.role, content: message.content })),
      max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
    }),
    signal: options.signal,
  });

    if (!response.ok) {
      throw new Error(sanitizeError(response.status, await response.text()));
    }

    const data = await response.json();
    return data.content[0].text;
  },

  async chatGoogle(
    messages: ConversationMessage[],
    systemPrompt: string,
    model: string,
    options: ChatOptions = {},
  ): Promise<string> {
    const apiKey = await SecureStorage.getAPIKey('google');
    if (!apiKey) throw new Error('Google AI API key not configured.');

    const contents = messages.map((message) => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: message.content }],
    }));

    const url = `https://generativelanguage.googleapis.com/v1/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents,
      generationConfig: { maxOutputTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS },
    }),
    signal: options.signal,
  });

    if (!response.ok) {
      throw new Error(sanitizeError(response.status, await response.text()));
    }

    const data = await response.json();
    return data.candidates[0].content.parts[0].text;
  },

  async chatOpenCode(
    messages: ConversationMessage[],
    systemPrompt: string,
    model: string,
    options: ChatOptions = {},
  ): Promise<string> {
    const apiKey = await SecureStorage.getAPIKey('opencode');
    const maxTokens = getOpenCodeMaxTokens(model, options.maxTokens ?? DEFAULT_MAX_TOKENS);
    const proxyHeaders = await getProxyAuthHeaders();
    const useAnthropic = isOpenCodeAnthropicModel(model);

    try {
      if (useAnthropic) {
        return await requestAnthropicCompatible(
          API_ENDPOINTS.proxy.opencodeMessages,
          null,
          model,
          systemPrompt,
          messages,
          maxTokens,
          options.signal,
          proxyHeaders,
          'OpenCode proxy',
        );
      }

      return await requestOpenAICompatible(
        API_ENDPOINTS.proxy.opencodeChat,
        null,
        model,
        systemPrompt,
        messages,
        maxTokens,
        options.signal,
        proxyHeaders,
        'OpenCode proxy',
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      LogService.warn('LLM', `OpenCode proxy unavailable, checking secure direct key: ${message}`);
    }

    if (!apiKey) {
      throw new Error('OpenCode no disponible: el proxy no respondio y no hay clave manual guardada.');
    }

    if (useAnthropic) {
      return requestAnthropicCompatible(
        API_ENDPOINTS.opencode.messages,
        apiKey,
        model,
        systemPrompt,
        messages,
        maxTokens,
        options.signal,
        {},
        'OpenCode',
      );
    }

    return requestOpenAICompatible(
      API_ENDPOINTS.opencode.chat,
      apiKey,
      model,
      systemPrompt,
      messages,
      maxTokens,
      options.signal,
      {},
      'OpenCode',
    );
  },

  async chatNvidia(
    messages: ConversationMessage[],
    systemPrompt: string,
    model: string,
    options: ChatOptions = {},
  ): Promise<string> {
    const apiKey = await SecureStorage.getAPIKey('nvidia');
    if (!apiKey) throw new Error('NVIDIA API key not configured.');

    return requestOpenAICompatible(
      API_ENDPOINTS.nvidia.chat,
      apiKey,
      model,
      systemPrompt,
      messages,
      options.maxTokens ?? DEFAULT_MAX_TOKENS,
      options.signal,
    );
  },

  async chatMiniMax(
    messages: ConversationMessage[],
    systemPrompt: string,
    model: string,
    options: ChatOptions = {},
  ): Promise<string> {
    const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    const formattedMessages = messages.map((message) => ({ role: message.role, content: message.content }));
    const directApiKey = await SecureStorage.getAPIKey('minimax');

    const shouldUseProxyFirst = proxyHealthState.healthy !== false;
    let response: Response | null = null;
    let lastError: Error | null = null;

    if (shouldUseProxyFirst) {
      try {
        response = await fetch(API_ENDPOINTS.proxy.chat, {
          method: 'POST',
          headers: {
            ...(await getProxyAuthHeaders()),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            system: systemPrompt,
            messages: formattedMessages,
            max_tokens: maxTokens,
          }),
          signal: options.signal,
        });

        if (response.ok) {
          markProxyHealth(true);
        } else if (response.status >= 500) {
          markProxyHealth(false);
        }
      } catch (error) {
        markProxyHealth(false);
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }

    if ((!response || !response.ok) && directApiKey) {
      response = await requestMiniMaxDirect(
        directApiKey,
        model,
        systemPrompt,
        formattedMessages,
        maxTokens,
        options.signal,
      );
    }

    if (!response) {
      throw lastError ?? new Error('MiniMax service unavailable.');
    }

    if (!response.ok) {
      throw new Error(sanitizeError(response.status, await response.text()));
    }

    return fetchJsonText(response);
  },
};
