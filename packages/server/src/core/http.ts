import { traffic } from './log.ts';
import { recordOutboundRequest, requestIdFor } from './outbound.ts';
import type { HttpOptions } from '../types.ts';

// What the caller sends, without a file or a stream, which has no text.
async function bodyOf(body: BodyInit | null | undefined): Promise<unknown> {
  if (body == null) return undefined;
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return Object.fromEntries(body);
  if (body instanceof FormData) {
    const fields: Record<string, unknown> = {};
    for (const [key, value] of body) fields[key] = typeof value === 'string' ? value : `[${value.size} bytes]`;
    return fields;
  }
  if (body instanceof Blob) return `[${body.size} bytes]`;
  if (body instanceof ArrayBuffer) return `[${body.byteLength} bytes]`;
  if (ArrayBuffer.isView(body)) return `[${body.byteLength} bytes]`;
  return '[stream]';
}

// A binary answer has no text, so the log shows its size and its type.
const BINARY = /^(image|audio|video|font)\/|application\/(octet-stream|pdf|zip|x-bittorrent)/i;

// The log keeps the start of a big answer only. The whole body holds memory, and the entry keeps 2000 characters of
// it at most. The clone is cut, so the caller still reads the whole answer.
const MAX_BODY_BYTES = 64_000;

async function readStart(response: Response, limit: number) {
  if (!response.body) return { text: '', bytes: 0, truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = limit - bytes;
      if (value.byteLength > room) {
        chunks.push(value.subarray(0, room));
        bytes = limit;
        truncated = true;
        break;
      }
      chunks.push(value);
      bytes += value.byteLength;
    }
  } finally {
    // A cancelled clone releases its side of the answer, so nothing waits in memory for a reader that never comes.
    // The cancel of one side of a copy resolves only when the caller cancels its side, so it is not awaited.
    if (truncated) void reader.cancel().catch(() => {});
    else reader.releaseLock();
  }
  const all = new Uint8Array(bytes);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(all), bytes, truncated };
}

async function bodyReceived(response: Response): Promise<unknown> {
  const type = response.headers.get('content-type') ?? '';
  const clone = response.clone();
  try {
    if (BINARY.test(type)) {
      // A missing header reads as 0, so the check has to tell it from a real 0.
      const header = response.headers.get('content-length');
      const length = header === null ? null : Number(header);
      if (length !== null && Number.isFinite(length) && length >= 0) {
        void clone.body?.cancel().catch(() => {});
        return `[${length} bytes of ${type}]`;
      }
      const { bytes, truncated } = await readStart(clone, MAX_BODY_BYTES);
      return `[${truncated ? `more than ${bytes}` : String(bytes)} bytes of ${type}]`;
    }
    return (await readStart(clone, MAX_BODY_BYTES)).text;
  } catch {
    return '[unreadable]';
  }
}

// The system that a caller logs is the name that the user set, not the host, because the host says little.
// The entry holds the request and the answer as they are. redact() hides a key, a token, a password, a magnet link, or a download link.
// Every request has an id, so the log of the work that sent it can link to the entry of the request.
export function outboundFetch(system: string, fetchImpl: typeof fetch = fetch, { path, query = true, requestId }: HttpOptions = {}): typeof fetch {
  return async (input, init) => {
    const id = requestId ?? requestIdFor(system);
    recordOutboundRequest(system, id);
    const address = new URL(input instanceof Request ? input.url : String(input));
    const target = new URL(address);
    if (!query) target.search = '';
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const headers: Record<string, string> = Object.fromEntries(input instanceof Request ? input.headers : []);
    new Headers(init?.headers).forEach((value, key) => (headers[key] = value));
    const sent = await (init?.body !== undefined ? bodyOf(init.body) : input instanceof Request && input.body ? input.clone().text() : Promise.resolve(undefined)).catch(() => '[unreadable]');
    const request = { method, url: path ?? target.toString(), headers, body: sent };
    try {
      const response = await fetchImpl(input, init);
      traffic.info('outbound request', {
        direction: 'outbound',
        requestId: id,
        system,
        request,
        response: { status: response.status, headers: Object.fromEntries(response.headers), body: await bodyReceived(response) },
      });
      return response;
    } catch (error) {
      const cause = error as { cause?: { code?: string }; name?: string };
      traffic.warn('outbound request failed', { direction: 'outbound', requestId: id, system, request, code: cause?.cause?.code ?? cause?.name });
      throw error;
    }
  };
}
