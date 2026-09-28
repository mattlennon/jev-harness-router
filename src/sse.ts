import { invariant, RouterError, checkAbort } from './domain.js';
import type { Fetcher } from './http.js';
/** Incremental UTF-8 SSE, including comments, multiline data and split CRLF. */
export async function* decodeSse(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<unknown> {
  const reader = body.getReader(), decoder = new TextDecoder();
  let buffer = '', data: string[] = [], total = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      checkAbort(signal); const part = await reader.read(); checkAbort(signal);
      buffer += part.done ? decoder.decode() : decoder.decode(part.value, { stream: true }); total += part.value?.length ?? 0;
      invariant(total <= 16 * 1024 * 1024 && buffer.length <= 2 * 1024 * 1024, 'RESPONSE_TOO_LARGE');
      while (true) {
        const i = buffer.search(/[\r\n]/);
        if (i < 0 || (!part.done && i === buffer.length - 1 && buffer[i] === '\r')) break;
        const line = buffer.slice(0, i); buffer = buffer.slice(i + (buffer[i] === '\r' && buffer[i + 1] === '\n' ? 2 : 1));
        if (!line) {
          if (!data.length) continue; const value = data.join('\n'); data = [];
          if (value === '[DONE]') return;
          let parsed: unknown; try { parsed = JSON.parse(value); } catch { throw new RouterError('BAD_SSE_JSON'); }
          yield parsed;
        } else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      invariant(data.reduce((n, v) => n + v.length, 0) <= 2 * 1024 * 1024, 'RESPONSE_TOO_LARGE');
      if (part.done) throw new RouterError('STREAM_TRUNCATED');
    }
  } finally { signal.removeEventListener('abort', cancel); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export async function* providerEvents(endpoint: string, payload: unknown, headers: Record<string, string>, timeoutMs: number,
  signal: AbortSignal, fetcher: Fetcher, onHeaders: (headers: Headers) => void): AsyncGenerator<{ value: unknown; json: boolean }> {
  const timeout = new AbortController(), stop = new AbortController(), timer = setTimeout(() => timeout.abort(), timeoutMs);
  const combined = AbortSignal.any([signal, timeout.signal, stop.signal]); let response: Response | undefined;
  try {
    checkAbort(combined);
    response = await fetcher(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(payload), signal: combined, redirect: 'error' });
    onHeaders(response.headers); invariant(response.ok, `HTTP_${response.status}`); invariant(response.body, 'EMPTY_RESPONSE');
    if (response.headers.get('content-type')?.includes('text/event-stream')) {
      for await (const value of decodeSse(response.body, combined)) yield { value, json: false };
    } else {
      const reader = response.body.getReader(); let bytes = 0; const chunks: Uint8Array[] = [];
      try { while (true) { const p = await reader.read(); if (p.done) break; bytes += p.value.length; invariant(bytes <= 16 * 1024 * 1024, 'RESPONSE_TOO_LARGE'); chunks.push(p.value); } }
      finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      yield { value: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown, json: true };
    }
  } catch (error) {
    checkAbort(signal); if (timeout.signal.aborted) throw new RouterError('TIMEOUT');
    if (error instanceof RouterError) throw error; throw new RouterError('TRANSPORT_OR_PROTOCOL_ERROR');
  } finally { clearTimeout(timer); stop.abort(); if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {}); }
}
