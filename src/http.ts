import { checkAbort, RouterError, invariant } from './domain.js';

export type Fetcher = typeof fetch;
export async function postJson(endpoint: string, body: unknown, headers: Record<string, string>, timeoutMs: number,
  signal: AbortSignal | undefined, fetcher: Fetcher = fetch): Promise<unknown> {
  checkAbort(signal);
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
  try {
    const response = await fetcher(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body), signal: combined, redirect: 'error' });
    invariant(response.ok, `HTTP_${response.status}`);
    invariant(response.body, 'EMPTY_RESPONSE');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        bytes += value.length; invariant(bytes <= 4 * 1024 * 1024, 'RESPONSE_TOO_LARGE'); chunks.push(value);
      }
    } finally { await reader.cancel(); reader.releaseLock(); }
    checkAbort(signal);
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch (error) {
    checkAbort(signal);
    if (timeout.signal.aborted) throw new RouterError('TIMEOUT');
    if (error instanceof RouterError) throw error;
    // Provider bodies and fetch errors may include user data; do not persist them.
    throw new RouterError('TRANSPORT_OR_PROTOCOL_ERROR');
  } finally { clearTimeout(timer); }
}
export function apiKey(name: string): string {
  const key = process.env[name]; invariant(key && key.trim(), 'MISSING_API_KEY'); return key;
}
