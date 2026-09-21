export const ZAOKIT_BASE_URL = 'https://api.zaokit.com/v1';

export function zaokitBaseUrl(value?: string): string {
  const base = (value || ZAOKIT_BASE_URL).replace(/\/+$/, '');
  // Accept the public root entered by a user as well as a versioned gateway URL.
  const url = new URL(base);
  return url.pathname === '/' ? `${base}/v1` : base;
}

export async function zaokitFetch(
  path: string,
  config: { apiKey?: string; baseUrl?: string },
  init: RequestInit = {},
): Promise<Response> {
  if (!config.apiKey) throw new Error('Zaokit API key is required');
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${config.apiKey}`);
  const response = await fetch(`${zaokitBaseUrl(config.baseUrl)}${path}`, {
    ...init,
    headers,
    redirect: 'manual',
    signal: init.signal || AbortSignal.timeout(180_000),
  });
  if (!response.ok) {
    throw new Error(`Zaokit request failed (${response.status}): ${await response.text()}`);
  }
  return response;
}

export interface ZaokitResponse {
  status?: string;
  error?: { message?: string };
  output?: Array<{
    type: string;
    content?: Array<{
      type: string;
      text?: string;
      annotations?: Array<{ type: string; url?: string; title?: string }>;
    }>;
  }>;
}

export async function zaokitResponse(
  config: { apiKey?: string; baseUrl?: string },
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ZaokitResponse> {
  const response = await zaokitFetch('/responses', config, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-6-astra', ...body, stream: false }),
    signal,
  });
  const data: ZaokitResponse = await response.json();
  if (data.error || (data.status && data.status !== 'completed')) {
    throw new Error(data.error?.message || `Zaokit response ${data.status}`);
  }
  return data;
}

export function zaokitResponseText(data: ZaokitResponse): string {
  const text = (data.output || [])
    .flatMap((item) => item.content || [])
    .filter((part) => part.type === 'output_text')
    .map((part) => part.text || '')
    .join('\n')
    .trim();
  if (!text) throw new Error('Zaokit returned no text');
  return text;
}
