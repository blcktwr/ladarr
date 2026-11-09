import { traffic } from './log.ts';
import { recordOutboundRequest, requestIdFor } from './outbound.ts';

type Options = {
  // Replaces the address in the log. A webhook address can hold a token.
  path?: string;
  // False leaves the query out of the log.
  query?: boolean;
  // Ties the entry to the log line that caused the request.
  requestId?: string;
};

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

async function bodyReceived(response: Response): Promise<unknown> {
  const type = response.headers.get('content-type') ?? '';
  try {
    if (BINARY.test(type)) return `[${(await response.clone().arrayBuffer()).byteLength} bytes of ${type}]`;
    return await response.clone().text();
  } catch {
    return '[unreadable]';
  }
}

// The system that a caller logs is the name that the user set, not the host, because the host says little.
// The entry holds the request and the answer as they are. redact() hides a key, a token, a password, a magnet link, or a download link.
// Every request has an id, so the log of the work that sent it can link to the entry of the request.
export function outboundFetch(system: string, fetchImpl: typeof fetch = fetch, { path, query = true, requestId }: Options = {}): typeof fetch {
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
