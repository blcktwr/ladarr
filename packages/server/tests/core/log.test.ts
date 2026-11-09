import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { closeLog, catalog, log, logToFile, recentLogs, redact, traffic } from '../../src/core/log.ts';
import { outboundFetch } from '../../src/core/http.ts';
import { withOutboundRequests } from '../../src/core/outbound.ts';
import { startTestApp } from '../helpers/test-app.ts';

const dir = mkdtempSync(join(tmpdir(), 'ladarr-log-'));
afterAll(() => rmSync(dir, { recursive: true }));

describe('redact', () => {
  it('hides secret keys, nested or in a URL', () => {
    const out = redact({ url: 'http://x/api?apikey=abc123&page=2', headers: { 'X-Api-Key': 'abc123' }, list: [{ password: 'p' }] });
    expect(JSON.stringify(out)).not.toMatch(/abc123|"p"/);
    expect(out).toMatchObject({ url: 'http://x/api?apikey=[redacted]&page=2' });
  });

  it('hides a magnet link, a tracker and a download link in a JSON body', () => {
    const body = JSON.stringify([
      { magnet_uri: 'magnet:?xt=urn:btih:abc&tr=https%3A%2F%2Ftracker.test%2Fannounce%3Fpasskey%3DSEKRIT', tracker: 'https://tracker.test/announce?passkey=SEKRIT' },
    ]);
    const out = redact({ response: { body } });
    expect(JSON.stringify(out)).not.toContain('SEKRIT');
    expect(out).toMatchObject({ response: { body: [{ magnet_uri: '[redacted]', tracker: '[redacted]' }] } });
  });

  it('hides the link, the guid and the magnet of a feed', () => {
    const body =
      '<item><link>https://indexer/download?passkey=SEKRIT</link><guid>https://indexer/1?passkey=SEKRIT</guid><torznab:attr name="magneturl" value="magnet:?xt=urn:btih:abc&tr=https%3A%2F%2Ftracker.test%2Fannounce%3Fpasskey%3DSEKRIT"/></item>';
    const out = redact({ response: { body } });
    expect(JSON.stringify(out)).not.toContain('SEKRIT');
    expect(out).toMatchObject({ response: { body: '<item><link>[redacted]</link><guid>[redacted]</guid><torznab:attr name="magneturl" value="[redacted]"/></item>' } });
  });

  it('hides the address of a tracker entry and keeps another URL', () => {
    const out = redact([{ url: 'https://tracker.test/announce?passkey=SEKRIT', tier: 0 }, { request: { url: 'https://api.test/x?apikey=abc123' } }]);
    expect(JSON.stringify(out)).not.toContain('SEKRIT');
    expect(out).toMatchObject([{ url: '[redacted]', tier: 0 }, { request: { url: 'https://api.test/x?apikey=[redacted]' } }]);
  });

  it('hides every address of a feed, also one with the token in its path', () => {
    const body =
      '<?xml version="1.0"?><rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel><item>' +
      '<title>Show.S01E01.1080p</title>' +
      '<guid isPermaLink="false">https://indexer/rss/SEKRIT-GUID/1</guid>' +
      '<link>https://indexer/download/1?passkey=SEKRIT</link>' +
      '<comments>https://indexer/details/1/SEKRIT-PATH</comments>' +
      '<description><![CDATA[<a href="https://indexer/details/1?auth=SEKRIT-AUTH">more</a>]]></description>' +
      '<enclosure url="https://user:SEKRIT-PASS@indexer/download/1.torrent" length="1" type="application/x-bittorrent"/>' +
      '<torznab:attr name="magneturl" value="magnet:?xt=urn:btih:abc&amp;tr=https%3A%2F%2Ftracker.test%2Fannounce%3Fpasskey%3DSEKRIT"/>' +
      '<torznab:attr name="seeders" value="12"/>' +
      '<torznab:attr name="infohash" value="ABCDEF0123456789"/>' +
      '</item></channel></rss>';
    const out = redact({ response: { body } }) as { response: { body: string } };
    expect(out.response.body).not.toContain('SEKRIT');
    expect(out.response.body).not.toContain('https://');
    expect(out.response.body).not.toContain('magnet:');
    expect(out.response.body).toContain('<title>Show.S01E01.1080p</title>');
    expect(out.response.body).toContain('value="12"');
    expect(out.response.body).toContain('value="ABCDEF0123456789"');
  });

  it('hides the addresses of a feed without an XML declaration', () => {
    const body = '<rss><channel><item><comments>https://indexer/details/1/SEKRIT</comments></item></channel></rss>';
    const out = redact({ response: { body } }) as { response: { body: string } };
    expect(out.response.body).not.toContain('SEKRIT');
  });

  it('keeps an address that is not in a feed', () => {
    const out = redact({ message: 'tried https://indexer.test/api?t=caps' }) as { message: string };
    expect(out.message).toBe('tried https://indexer.test/api?t=caps');
  });
});

describe('log file', () => {
  it('keeps the file size bounded and returns the latest entries', async () => {
    const file = join(dir, 'logs', 'test.log');
    logToFile(file, 2_000);
    for (let i = 0; i < 200; i++) log.info('entry', { i, token: 'secret-token' });
    // The stream writes in the background. Closing it writes what is waiting.
    await closeLog();
    const files = readdirSync(join(dir, 'logs'));
    expect(files.sort()).toEqual(['requests.log', 'test.log', 'test.log.1']);
    // The stream rotates when a file passes the limit, so a file can pass it by one entry.
    for (const name of files) expect(statSync(join(dir, 'logs', name)).size).toBeLessThanOrEqual(2_000 + 200);
    const latest = await recentLogs(5);
    expect(latest.map((entry) => entry.i)).toEqual([195, 196, 197, 198, 199]);
    expect(latest[0]).toMatchObject({ level: 'info', message: 'entry', token: '[redacted]' });
    expect(new Date(latest[0]!.time).toISOString()).toBe(latest[0]!.time);
  });

  it('keeps the requests out of the file of the app', async () => {
    logToFile(join(dir, 'split', 'app.log'));
    log.info('server listening');
    traffic.info('request', { direction: 'inbound' });
    traffic.info('outbound request', { direction: 'outbound' });
    await closeLog();
    expect((await recentLogs(10)).map((entry) => entry.message)).toEqual(['server listening']);
    const requests = await recentLogs(10, { kind: 'requests' });
    expect(requests.map((entry) => entry.message)).toEqual(['request', 'outbound request']);
    // A request has no level. The code of the answer says how it went.
    expect(requests.every((entry) => entry.level === undefined)).toBe(true);
  });

  it('keeps only the start of a long text', async () => {
    logToFile(join(dir, 'long', 'long.log'));
    log.info('big', { response: { body: 'x'.repeat(5_000) } });
    await closeLog();
    const [entry] = await recentLogs(1);
    const body = (entry!.response as { body: string }).body;
    expect(body.length).toBeLessThanOrEqual(2_020);
    expect(body.startsWith('x')).toBe(true);
    expect(body).toContain('[truncated]');
  });

  it('does not write to the console', async () => {
    const stdout = vi.spyOn(process.stdout, 'write');
    const stderr = vi.spyOn(process.stderr, 'write');
    logToFile(join(dir, 'quiet', 'quiet.log'));
    log.info('hello');
    log.warn('careful', { a: 1 });
    log.error('failed', { error: new Error('boom') });
    await closeLog();
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
    stdout.mockRestore();
    stderr.mockRestore();
    const entries = await recentLogs(10);
    expect(entries.map((entry) => [entry.level, entry.message])).toEqual([['info', 'hello'], ['warn', 'careful'], ['error', 'failed']]);
    expect(entries[2]!.error).toMatchObject({ name: 'Error', message: 'boom' });
  });

  it('writes nothing before a file is set, and nothing after the close', async () => {
    await closeLog();
    expect(() => log.info('ignored')).not.toThrow();
  });
});

describe('linked requests', () => {
  it('links an entry to the outbound requests of its work', async () => {
    logToFile(join(dir, 'linked', 'linked.log'));
    const send = outboundFetch('TMDB', (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch);

    await withOutboundRequests(async () => {
      await send('https://api.test/one');
      catalog.info('refreshed', 'Refreshed the metadata from TMDB', { itemId: 'movie:1', itemType: 'movie', titleKey: 'movie:1', title: 'One', target: 'Movie' });
    });
    log.info('plain');
    await closeLog();

    const [entry, plain] = await recentLogs(10);
    expect(entry).toMatchObject({ event: 'refreshed', requests: [{ system: 'TMDB', requestId: expect.stringMatching(/^req-[0-9a-f]{12}$/) }] });
    expect(plain).not.toHaveProperty('requests');
  });

  it('keeps only the requests that the entry already has', async () => {
    logToFile(join(dir, 'linked-given', 'linked-given.log'));
    const send = outboundFetch('TMDB', (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch);
    const fields = { itemId: 'movie:1', itemType: 'movie', titleKey: 'movie:1', title: 'One', target: 'Movie' };

    await withOutboundRequests(async () => {
      await send('https://api.test/one');
      catalog.info('search', 'First', fields, { requests: [{ indexer: 'Indexer A', requestId: 'req-first' }] });
      catalog.info('search', 'Second', fields, { requests: [{ indexer: 'Indexer A', requestId: 'req-second' }] });
    });
    await closeLog();

    const entries = await recentLogs(10);
    expect(entries.map((entry) => entry.requests)).toEqual([
      [{ indexer: 'Indexer A', requestId: 'req-first' }],
      [{ indexer: 'Indexer A', requestId: 'req-second' }],
    ]);
  });
});

describe('request id filter', () => {
  it('returns only the entries with the given request id', async () => {
    logToFile(join(dir, 'request-id', 'request-id.log'));
    traffic.info('outbound request', { requestId: 'req-1', system: 'Indexer' });
    traffic.info('outbound request', { requestId: 'req-2', system: 'Indexer' });
    traffic.info('outbound request', { requestId: 'req-1', system: 'Indexer' });
    await closeLog();
    const entries = await recentLogs(10, { kind: 'requests', requestId: 'req-1' });
    expect(entries).toHaveLength(2);
    expect(entries.every((entry) => (entry as { requestId?: string }).requestId === 'req-1')).toBe(true);
    expect(await recentLogs(10, { kind: 'requests', requestId: 'req-3' })).toEqual([]);
  });

  it('serves the entries of one request from the API', async () => {
    logToFile(join(dir, 'api-request-id', 'api.log'));
    traffic.info('outbound request', { requestId: 'req-1', system: 'Indexer' });
    traffic.info('outbound request', { requestId: 'req-2', system: 'Indexer' });
    await closeLog();
    const app = await startTestApp();
    try {
      const found = await app.get('/system/logs?kind=requests&requestId=req-1');
      expect(found.body.entries.map((entry: { message: string }) => entry.message)).toEqual(['outbound request']);
      expect(found.body.entries.every((entry: { requestId?: string }) => entry.requestId === 'req-1')).toBe(true);
      const none = await app.get('/system/logs?kind=requests&requestId=req-3');
      expect(none.body.entries).toEqual([]);
    } finally {
      app.close();
    }
  });
});

describe('item filter', () => {
  it('returns only the entries of one item', async () => {
    logToFile(join(dir, 'items', 'items.log'));
    log.info('first', { itemId: 'movie:2', itemType: 'movie' });
    log.info('other', { itemId: 'tv:1:1x1', itemType: 'tv' });
    log.info('last', { itemId: 'movie:2', itemType: 'movie' });
    log.info('plain');
    await closeLog();
    expect((await recentLogs(10, { itemId: 'movie:2' })).map((entry) => entry.message)).toEqual(['first', 'last']);
    expect((await recentLogs(10, { itemType: 'tv' })).map((entry) => entry.message)).toEqual(['other']);
    expect(await recentLogs(10, { itemId: 'movie:2', itemType: 'tv' })).toEqual([]);
    expect((await recentLogs(1, { itemId: 'movie:2' })).map((entry) => entry.message)).toEqual(['last']);
  });

  it('tells a catalog entry from a system entry', async () => {
    logToFile(join(dir, 'types', 'types.log'));
    log.info('server start');
    catalog.info('search.finished', 'Search finished: every release was rejected', { itemId: 'tv:1:1x2', itemType: 'tv', titleKey: 'tv:1', title: 'Show', target: 'S01E02', attempt: 1, sinceCreatedMs: 10 }, { result: 'all_rejected' });
    await closeLog();
    const all = await recentLogs(10);
    expect(all.map((entry) => entry.type)).toEqual(['system', 'catalog']);
    const catalogOnly = await recentLogs(10, { type: 'catalog' });
    expect(catalogOnly).toHaveLength(1);
    expect(catalogOnly[0]).toMatchObject({ type: 'catalog', event: 'search.finished', itemId: 'tv:1:1x2', itemType: 'tv', title: 'Show', target: 'S01E02', result: 'all_rejected' });
    expect((await recentLogs(10, { type: 'system' })).map((entry) => entry.message)).toEqual(['server start']);
  });

  it('serves the filtered entries from the API', async () => {
    logToFile(join(dir, 'api', 'api.log'));
    log.info('first', { itemId: 'movie:2', itemType: 'movie' });
    log.info('other', { itemId: 'tv:1:1x1', itemType: 'tv' });
    log.info('last', { itemId: 'movie:2', itemType: 'movie' });
    await closeLog();
    const app = await startTestApp();
    try {
      const found = await app.get('/system/logs?itemId=movie%3A2&itemType=movie');
      expect(found.body.entries.map((entry: { message: string }) => entry.message)).toEqual(['first', 'last']);
      const none = await app.get('/system/logs?itemId=movie%3A2&itemType=tv');
      expect(none.body.entries).toEqual([]);
    } finally {
      app.close();
    }
  });
});
