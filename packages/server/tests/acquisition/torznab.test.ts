import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyData, openDb, type Db } from '../../src/core/db.ts';
import type { Indexer, IndexerPush } from '../../src/library/grab/indexers.ts';
import { createLimiter } from '../../src/core/limiter.ts';
import { closeLog, logToFile, recentLogs } from '../../src/core/log.ts';
import { createIndexerService, IndexerError, parseCaps, parseFeed } from '../../src/library/grab/torznab.ts';

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:torznab="http://torznab.com/schemas/2015/feed">
<channel>
<title>Tracker</title>
<item>
  <title>Show.Name.S01E02.1080p.WEB-DL.DDP5.1.H.264-GRP</title>
  <guid>http://indexer/3/details/1</guid>
  <link>http://indexer/3/download?apikey=k&amp;file=Show</link>
  <pubDate>Sat, 03 Feb 2024 10:00:00 +0000</pubDate>
  <size>1610612736</size>
  <enclosure url="http://indexer/3/download?apikey=k&amp;file=Show" length="1610612736" type="application/x-bittorrent" />
  <torznab:attr name="category" value="5000" />
  <torznab:attr name="category" value="5040" />
  <torznab:attr name="seeders" value="12" />
  <torznab:attr name="peers" value="15" />
  <torznab:attr name="infohash" value="ABCDEF0123456789ABCDEF0123456789ABCDEF01" />
</item>
<item>
  <title><![CDATA[Movie & Name 2019 2160p]]></title>
  <guid>g2</guid>
  <link>magnet:?xt=urn:btih:abcdef0123456789abcdef0123456789abcdef01</link>
  <torznab:attr value="30" name="seeders"/>
  <torznab:attr name="size" value="9000000000"/>
</item>
<item><guid>no-title</guid></item>
</channel></rss>`;

describe('parseFeed', () => {
  it('reads the fields that ladarr uses', () => {
    const [first, second, ...rest] = parseFeed(FEED, 7);
    expect(rest).toEqual([]);
    expect(first).toEqual({
      indexerId: 7,
      guid: 'http://indexer/3/details/1',
      title: 'Show.Name.S01E02.1080p.WEB-DL.DDP5.1.H.264-GRP',
      link: 'http://indexer/3/download?apikey=k&file=Show',
      magnet: null,
      infoHash: 'abcdef0123456789abcdef0123456789abcdef01',
      sizeBytes: 1610612736,
      publishedAt: Date.parse('2024-02-03T10:00:00Z'),
      seeders: 12,
      peers: 15,
      categories: [5000, 5040],
    });
    expect(second).toMatchObject({ title: 'Movie & Name 2019 2160p', link: null, magnet: expect.stringMatching(/^magnet:/), seeders: 30, sizeBytes: 9_000_000_000, publishedAt: null });
  });

  it('turns an error answer into a rejection', () => {
    expect(() => parseFeed('<error code="100" description="Incorrect user credentials"/>', 1)).toThrow(/error 100/);
    expect(() => parseFeed('<html>oops</html>', 1)).toThrow(IndexerError);
  });

  it('does not expand entities from a DTD', () => {
    const xml = `<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY x "AAAA">]><rss><channel><item><title>&x; a</title></item></channel></rss>`;
    expect(parseFeed(xml, 1)[0]!.title).toBe('&x; a');
  });
});

describe('parseCaps', () => {
  it('reads the search modes and their parameters', () => {
    const caps = parseCaps(`<caps><searching>
      <search available="yes" supportedParams="q"/>
      <tv-search available="yes" supportedParams="q,season,ep,tvdbid"/>
      <movie-search available="no" supportedParams="q"/>
    </searching><categories><category id="5000" name="TV"><subcat id="5040" name="HD"/></category></categories></caps>`);
    expect(caps).toEqual({ search: ['q'], tv: ['q', 'season', 'ep', 'tvdbid'], movie: null, categories: [5000, 5040] });
  });
});

let server: Server;
afterEach(() => {
  server?.closeAllConnections();
  server?.close();
});

const pushed = (name: string): IndexerPush => ({
  name,
  enableRss: true,
  enableAutomaticSearch: true,
  enableInteractiveSearch: true,
  priority: 1,
  categories: [],
  animeCategories: [],
  minimumSeeders: 0,
  tags: [],
  fields: {},
});

const indexerAt = (port: number, delaySeconds: number): Indexer => ({
  id: 1,
  baseUrl: `http://127.0.0.1:${port}/1/`,
  apiPath: '/api',
  apiKey: 'secret-key',
  delaySeconds,
  nextRequestAt: 0,
  push: { sonarr: pushed('Tracker') },
  caps: null,
  capsAt: 0,
  health: { okAt: null, failedAt: null, failures: 0, retryAt: 0, error: null },
});

async function fakeTracker(handler: (url: URL, res: import('node:http').ServerResponse) => void) {
  const starts: { at: number; path: string }[] = [];
  server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    starts.push({ at: Date.now(), path: `${url.pathname}?t=${url.searchParams.get('t') ?? ''}` });
    handler(url, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { starts, port: (server.address() as AddressInfo).port };
}

async function setup(port: number, delaySeconds: number) {
  const db: Db = await openDb('unused.json');
  Object.assign(db.data, emptyData());
  const indexer = indexerAt(port, delaySeconds);
  db.data.indexers[1] = indexer;
  const limiter = createLimiter(db);
  return { db, indexer, limiter, service: createIndexerService(db, limiter, { timeoutMs: 2_000 }) };
}

describe('limiter', () => {
  it('grants slots one delay apart, in the order of the waiting, and a download first', async () => {
    const { indexer, limiter } = await setup(0, 0.1);
    const grants: { name: string; at: number }[] = [];
    const take = (name: string, urgent = false) => limiter.acquire(indexer.id, { urgent }).then(() => grants.push({ name, at: Date.now() }));
    await Promise.all([take('a'), take('b'), take('c'), take('download', true)]);
    expect(grants.map((g) => g.name)).toEqual(['a', 'download', 'b', 'c']);
    // A timer never fires early, so each gap is a full delay (1 ms for the clock).
    for (let i = 1; i < grants.length; i++) expect(grants[i]!.at - grants[i - 1]!.at).toBeGreaterThanOrEqual(99);
  });

  it('lets a request go when the indexer is gone', async () => {
    const { db, indexer, limiter } = await setup(0, 5);
    indexer.nextRequestAt = Date.now() + 5_000;
    const waiting = limiter.acquire(indexer.id);
    delete db.data.indexers[indexer.id];
    limiter.stop();
    // The wait ends when the limiter looks again. A new request looks at once.
    const other = limiter.acquire(indexer.id);
    await expect(Promise.race([other, new Promise((resolve) => setTimeout(() => resolve('late'), 200))])).resolves.toBeUndefined();
    await waiting;
  });
});

describe('indexer service', () => {
  it('starts two requests to one indexer at least one delay apart', async () => {
    const { starts, port } = await fakeTracker((_url, res) => void res.end(FEED));
    const { indexer, service } = await setup(port, 0.15);
    const query = { kind: 'search' as const, q: 'a', categories: [5000] };
    await Promise.all([service.search(indexer, query), service.search(indexer, query), service.search(indexer, query)]);
    expect(starts).toHaveLength(3);
    // The server sees the arrival of a request, and the arrival can differ by some ms from the start. The span of two delays is firm.
    expect(starts[1]!.at - starts[0]!.at).toBeGreaterThanOrEqual(100);
    expect(starts[2]!.at - starts[1]!.at).toBeGreaterThanOrEqual(100);
    expect(starts[2]!.at - starts[0]!.at).toBeGreaterThanOrEqual(200);
  });

  it('makes a download wait for the same limiter as a search, and go first', async () => {
    const { starts, port } = await fakeTracker((url, res) => void res.end(url.pathname.endsWith('/download') ? 'd8:announce1:ae' : FEED));
    const { indexer, service } = await setup(port, 0.15);
    const query = { kind: 'search' as const, q: 'a', categories: [] };
    const order: string[] = [];
    const first = service.search(indexer, query).then(() => order.push('search 1'));
    const second = service.search(indexer, query).then(() => order.push('search 2'));
    const third = service.download(indexer, `http://127.0.0.1:${port}/1/download?file=x`).then(() => order.push('download'));
    await Promise.all([first, second, third]);
    expect(order).toEqual(['search 1', 'download', 'search 2']);
    expect(starts[2]!.at - starts[1]!.at).toBeGreaterThanOrEqual(100);
  });

  it('keeps the delay after a restart, because the time is in the database', async () => {
    const { starts, port } = await fakeTracker((_url, res) => void res.end(FEED));
    const { indexer, service } = await setup(port, 0.2);
    indexer.nextRequestAt = Date.now() + 200;
    const began = Date.now();
    await service.search(indexer, { kind: 'search', categories: [] });
    expect(starts[0]!.at - began).toBeGreaterThanOrEqual(190);
  });

  it('does not use a slot for a wait that was aborted', async () => {
    const { starts, port } = await fakeTracker((_url, res) => void res.end(FEED));
    const { indexer, service } = await setup(port, 0.2);
    indexer.nextRequestAt = Date.now() + 200;
    const controller = new AbortController();
    const aborted = service.search(indexer, { kind: 'search', categories: [] }, { signal: controller.signal });
    controller.abort();
    await expect(aborted).rejects.toBeDefined();
    await service.search(indexer, { kind: 'search', categories: [] });
    expect(starts).toHaveLength(1);
    expect(indexer.health.failures).toBe(0);
  });

  it('records a failure with a backoff and hides the address and the key', async () => {
    const { port } = await fakeTracker((_url, res) => void res.writeHead(500).end('apikey=secret-key'));
    const { indexer, service } = await setup(port, 0);
    const error = await service.search(indexer, { kind: 'search', categories: [] }).catch((e) => e);
    expect(error).toBeInstanceOf(IndexerError);
    expect(error.message).not.toContain('secret-key');
    expect(error.message).not.toContain('127.0.0.1');
    expect(indexer.health).toMatchObject({ failures: 1, error: error.message });
    expect(indexer.health.retryAt).toBeGreaterThan(Date.now());
    expect(service.usable(indexer)).toBe(false);

    // The next good answer clears the failure.
    server.removeAllListeners('request');
    server.on('request', (_req, res) => void res.end(FEED));
    indexer.health.retryAt = 0;
    await service.search(indexer, { kind: 'search', categories: [] });
    expect(indexer.health).toMatchObject({ failures: 0, error: null });
  });

  it('rejects a rejected key, a redirect and a download link to another host', async () => {
    const { port } = await fakeTracker((url, res) => {
      if (url.searchParams.get('t') === 'search') return void res.writeHead(401).end();
      res.writeHead(302, { location: 'http://evil.example/' }).end();
    });
    const { indexer, service } = await setup(port, 0);
    await expect(service.search(indexer, { kind: 'search', categories: [] })).rejects.toThrow(/rejected the API key/);
    await expect(service.caps(indexer)).rejects.toThrow(/status 302/);
    await expect(service.download(indexer, 'http://evil.example/1/download')).rejects.toThrow(/another host/);
  });

  it('returns a magnet link when the download answers with a redirect to one', async () => {
    const { port } = await fakeTracker((_url, res) => void res.writeHead(301, { location: 'magnet:?xt=urn:btih:abc' }).end());
    const { indexer, service } = await setup(port, 0);
    expect(await service.download(indexer, `http://127.0.0.1:${port}/1/download?file=x`)).toEqual({ magnet: 'magnet:?xt=urn:btih:abc' });
  });

  it('sends the ID and text parameters of a search', async () => {
    const seen: URL[] = [];
    const { port } = await fakeTracker((url, res) => {
      seen.push(url);
      res.end(FEED);
    });
    const { indexer, service } = await setup(port, 0);
    await service.search(indexer, { kind: 'tv', q: 'Show', season: 1, ep: 2, tvdbId: 55, categories: [5030, 5040] });
    expect(Object.fromEntries(seen[0]!.searchParams)).toMatchObject({ t: 'tvsearch', q: 'Show', season: '1', ep: '2', tvdbid: '55', cat: '5030,5040', apikey: 'secret-key' });
  });

  it('logs each outbound request with its query and the code of a network error, never the API key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ladarr-torznab-'));
    logToFile(join(dir, 'ladarr.log'));
    const { port } = await fakeTracker((_url, res) => void res.end(FEED));
    const { indexer, service } = await setup(port, 0);
    await service.search(indexer, { kind: 'movie', q: 'Movie', categories: [2000] });
    // The port of a closed server refuses the connection.
    await new Promise((resolve) => server.close(resolve));
    await expect(service.test(indexer)).rejects.toBeInstanceOf(IndexerError);
    await closeLog();
    const entries = await recentLogs(20, { kind: 'requests' });
    rmSync(dir, { recursive: true });
    const success = entries.find((entry) => entry.message === 'outbound request');
    expect(success).toMatchObject({
      system: 'Tracker',
      request: { method: 'GET', url: expect.stringContaining('t=movie') },
      response: { status: 200 },
    });
    expect(String((success!.request as { url: string }).url)).toContain('apikey=[redacted]');
    const failure = entries.find((entry) => entry.message === 'outbound request failed');
    expect(failure).toMatchObject({
      system: 'Tracker',
      request: { method: 'GET', url: expect.stringContaining('t=caps') },
      code: 'ECONNREFUSED',
    });
    expect(JSON.stringify(entries)).not.toContain('secret-key');
  });

  it('tags the outbound request with the id of the search', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ladarr-torznab-request-id-'));
    logToFile(join(dir, 'ladarr.log'));
    const { port } = await fakeTracker((_url, res) => void res.end(FEED));
    const { indexer, service } = await setup(port, 0);
    await service.search(indexer, { kind: 'search', q: 'a', categories: [] }, { requestId: 'req-1' });
    await closeLog();
    const entries = await recentLogs(20, { kind: 'requests' });
    rmSync(dir, { recursive: true });
    expect(entries.find((entry) => entry.message === 'outbound request')).toMatchObject({ requestId: 'req-1' });
  });
});
