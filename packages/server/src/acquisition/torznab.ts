import { backoffMs, JobError } from '../core/jobs.ts';
import type { Db } from '../core/db.ts';
import { outboundFetch } from '../core/http.ts';
import { indexerName, type Caps, type Indexer } from './indexers.ts';
import type { Limiter } from '../core/limiter.ts';
import { log } from '../core/log.ts';

// One result of a search or of the RSS feed, before any decision.
export type RawRelease = {
  indexerId: number;
  guid: string;
  title: string;
  // The address of the .torrent file, usually through the indexer manager.
  link: string | null;
  magnet: string | null;
  infoHash: string | null;
  sizeBytes: number;
  publishedAt: number | null;
  seeders: number | null;
  peers: number | null;
  categories: number[];
};

type ErrorCode = 'rejected' | 'unavailable' | 'invalid_response';

// The message never holds the address, because the address holds the API key.
export class IndexerError extends JobError {
  code: ErrorCode;
  constructor(code: ErrorCode, message: string, cause?: unknown) {
    super('outage', message);
    this.code = code;
    this.cause = cause;
  }
}

const MAX_FEED_BYTES = 10 * 1024 * 1024;
const MAX_TORRENT_BYTES = 5 * 1024 * 1024;
const MAX_ITEMS = 500;
const CAPS_TTL_MS = 24 * 60 * 60_000;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decode(value: string) {
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(value);
  if (cdata) return cdata[1]!;
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Math.min(Number(dec), 0x10ffff)))
    .replace(/&(amp|lt|gt|quot|apos);/g, (_, name) => ENTITIES[name]!)
    .trim();
}

const attributes = (tag: string) => Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map((match) => [match[1]!, decode(match[2] ?? match[3] ?? '')]));
const tagText = (xml: string, name: string) => {
  const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(xml);
  return match ? decode(match[1]!) : null;
};
const toNumber = (value: string | undefined | null) => {
  const number = value === undefined || value === null || value === '' ? NaN : Number(value);
  return Number.isFinite(number) ? number : null;
};

// Reads the RSS answer of a Torznab server. It reads only the fields that ladarr uses.
// No XML parser runs, so there is no entity or DTD expansion to attack.
export function parseFeed(xml: string, indexerId: number): RawRelease[] {
  const error = /<error\s([^>]*)\/?>/.exec(xml);
  if (error) throw new IndexerError('rejected', `The indexer answered with error ${attributes(error[1]!).code ?? 'unknown'}.`);
  if (!/<rss[\s>]/.test(xml)) throw new IndexerError('invalid_response', 'The indexer did not send a feed.');

  const items: RawRelease[] = [];
  for (const [, body] of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    if (items.length >= MAX_ITEMS) break;
    const title = tagText(body!, 'title');
    if (!title) continue;
    const attrs: Record<string, string[]> = {};
    for (const [, tag] of body!.matchAll(/<(?:torznab|newznab):attr\s([^>]*?)\/?>/g)) {
      const { name, value } = attributes(tag!);
      if (name && value !== undefined) (attrs[name] ??= []).push(value);
    }
    const enclosure = /<enclosure\s([^>]*?)\/?>/.exec(body!);
    const enclosureAttrs = enclosure ? attributes(enclosure[1]!) : {};
    const link = tagText(body!, 'link') ?? enclosureAttrs.url ?? null;
    const magnet = attrs.magneturl?.[0] ?? (link?.startsWith('magnet:') ? link : null);
    const infoHash = attrs.infohash?.[0]?.toLowerCase();
    const published = tagText(body!, 'pubDate');
    const seeders = toNumber(attrs.seeders?.[0]);
    const peers = toNumber(attrs.peers?.[0]);
    items.push({
      indexerId,
      guid: tagText(body!, 'guid') ?? link ?? title,
      title,
      link: link && !link.startsWith('magnet:') ? link : null,
      magnet,
      infoHash: infoHash && /^[0-9a-f]{40}$/.test(infoHash) ? infoHash : null,
      sizeBytes: toNumber(attrs.size?.[0]) ?? toNumber(tagText(body!, 'size')) ?? toNumber(enclosureAttrs.length) ?? 0,
      publishedAt: published && !Number.isNaN(Date.parse(published)) ? Date.parse(published) : null,
      seeders,
      peers,
      categories: (attrs.category ?? []).map(Number).filter(Number.isInteger),
    });
  }
  return items;
}

export function parseCaps(xml: string): Caps {
  if (!/<caps[\s>]/.test(xml)) throw new IndexerError('invalid_response', 'The indexer did not send its capabilities.');
  const mode = (name: string) => {
    const tag = new RegExp(`<${name}\\s([^>]*?)/?>`).exec(xml);
    if (!tag) return null;
    const attrs = attributes(tag[1]!);
    return attrs.available === 'yes' ? (attrs.supportedParams ?? '').split(',').map((param) => param.trim()).filter(Boolean) : null;
  };
  const categories = [...xml.matchAll(/<(?:category|subcat)\s([^>]*?)\/?>/g)].map((match) => Number(attributes(match[1]!).id)).filter(Number.isInteger);
  return { search: mode('search'), tv: mode('tv-search'), movie: mode('movie-search'), categories };
}

export type SearchQuery = {
  kind: 'search' | 'tv' | 'movie';
  q?: string;
  season?: number;
  ep?: number;
  year?: number;
  imdbId?: string;
  tmdbId?: number;
  tvdbId?: number;
  categories: number[];
  limit?: number;
};

const FUNCTION = { search: 'search', tv: 'tvsearch', movie: 'movie' } as const;

type Options = { fetch?: typeof fetch; timeoutMs?: number };

// The native indexer service. The adapter endpoints for the indexer manager do not use it, and it does not use them.
export function createIndexerService(db: Db, limiter: Limiter, { fetch: fetchImpl = fetch, timeoutMs = 30_000 }: Options = {}, onChange: () => void = () => {}) {
  const url = (indexer: Indexer, params: Record<string, string>) => {
    const target = new URL(`${indexer.baseUrl.replace(/\/+$/, '')}${indexer.apiPath}`);
    for (const [key, value] of Object.entries({ ...params, apikey: indexer.apiKey })) target.searchParams.set(key, value);
    return target;
  };

  // Every request goes through the limiter, the log, and the health record, so no caller can skip them.
  async function request<T>(indexer: Indexer, { urgent = false, signal, requestId }: { urgent?: boolean; signal?: AbortSignal; requestId?: string }, run: (signal: AbortSignal, send: typeof fetch) => Promise<T>): Promise<T> {
    await limiter.acquire(indexer.id, { urgent, signal });
    const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    const send = outboundFetch(indexerName(indexer), fetchImpl, { requestId });
    try {
      const value = await run(combined, send);
      Object.assign(indexer.health, { okAt: Date.now(), failures: 0, retryAt: 0, error: null });
      onChange();
      return value;
    } catch (error) {
      // A stop of ladarr is not a fault of the indexer.
      if (signal?.aborted) throw error;
      // An error that is not an IndexerError is a fault in ladarr. The user must not read it as a fault of the indexer.
      if (!(error instanceof IndexerError)) log.error('an indexer request broke', { error });
      const known = error instanceof IndexerError ? error : new IndexerError('unavailable', 'The indexer did not answer.');
      const { health } = indexer;
      health.failures++;
      health.failedAt = Date.now();
      health.error = known.message;
      health.retryAt = Date.now() + backoffMs(health.failures);
      onChange();
      throw known;
    }
  }

  async function read(send: typeof fetch, target: URL, signal: AbortSignal, maxBytes: number) {
    let response: Response;
    try {
      // A redirect could send the API key to another host, so none is followed.
      response = await send(target, { signal, redirect: 'manual', headers: { accept: 'application/rss+xml, application/xml, text/xml, */*' } });
    } catch (error) {
      throw new IndexerError('unavailable', 'The indexer did not answer.', error);
    }
    if (response.status === 401 || response.status === 403) throw new IndexerError('rejected', 'The indexer rejected the API key.');
    if (!response.ok) throw new IndexerError('unavailable', `The indexer answered with status ${response.status}.`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new IndexerError('invalid_response', 'The answer of the indexer is too large.');
    return bytes;
  }

  const readText = async (send: typeof fetch, target: URL, signal: AbortSignal) => (await read(send, target, signal, MAX_FEED_BYTES)).toString('utf8');

  async function readCaps(indexer: Indexer, options: { urgent?: boolean; signal?: AbortSignal; requestId?: string } = {}) {
    indexer.caps = await request(indexer, options, async (signal, send) => parseCaps(await readText(send, url(indexer, { t: 'caps' }), signal)));
    indexer.capsAt = Date.now();
    return indexer.caps;
  }

  async function caps(indexer: Indexer, options: { signal?: AbortSignal; requestId?: string } = {}) {
    if (indexer.caps && Date.now() - indexer.capsAt < CAPS_TTL_MS) return indexer.caps;
    return readCaps(indexer, options);
  }

  return {
    caps,

    // The Settings test: a new request for the capabilities. The cache does not serve it, and it goes before the searches.
    test: (indexer: Indexer) => readCaps(indexer, { urgent: true }),

    // A search with no text is the RSS feed: the newest releases of the categories.
    async search(indexer: Indexer, query: SearchQuery, options: { signal?: AbortSignal; requestId?: string } = {}) {
      const params: Record<string, string> = { t: FUNCTION[query.kind], cat: query.categories.join(','), limit: String(query.limit ?? 100), extended: '1' };
      if (query.q) params.q = query.q;
      if (query.season !== undefined) params.season = String(query.season);
      if (query.ep !== undefined) params.ep = String(query.ep);
      if (query.year !== undefined) params.year = String(query.year);
      if (query.imdbId) params.imdbid = query.imdbId.replace(/^tt/, '');
      if (query.tmdbId !== undefined) params.tmdbid = String(query.tmdbId);
      if (query.tvdbId !== undefined) params.tvdbid = String(query.tvdbId);
      return request(indexer, options, async (signal, send) => parseFeed(await readText(send, url(indexer, params), signal), indexer.id));
    },

    // Gets a .torrent file. The address can answer with a redirect to a magnet link, and then the link is the result.
    async download(indexer: Indexer, link: string, options: { signal?: AbortSignal } = {}): Promise<{ torrent: Buffer } | { magnet: string }> {
      const target = new URL(link);
      const base = new URL(indexer.baseUrl);
      // The link comes from the answer of the indexer. It must lead to the same host, because ladarr adds the API key to the request only there.
      if (target.origin !== base.origin) throw new IndexerError('rejected', 'The download link leads to another host.');
      return request<{ torrent: Buffer } | { magnet: string }>(indexer, { ...options, urgent: true }, async (signal, send) => {
        let response: Response;
        try {
          response = await send(target, { signal, redirect: 'manual', headers: { 'x-api-key': indexer.apiKey } });
        } catch (error) {
          throw new IndexerError('unavailable', 'The indexer did not answer.', error);
        }
        const location = response.headers.get('location');
        if (response.status >= 300 && response.status < 400 && location?.startsWith('magnet:')) return { magnet: location };
        if (response.status === 401 || response.status === 403) throw new IndexerError('rejected', 'The indexer rejected the API key.');
        if (!response.ok) throw new IndexerError('unavailable', `The indexer answered with status ${response.status}.`);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > MAX_TORRENT_BYTES) throw new IndexerError('invalid_response', 'The torrent file is too large.');
        return { torrent: bytes };
      });
    },

    // True when the indexer is not in a backoff after failed requests.
    usable: (indexer: Indexer) => Date.now() >= indexer.health.retryAt,
  };
}

export type IndexerService = ReturnType<typeof createIndexerService>;
