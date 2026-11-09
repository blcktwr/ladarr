import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEvents } from '../../src/core/events.ts';
import { closeLog, logToFile, recentLogs } from '../../src/core/log.ts';
import { mapPath, mapProfile, readFromApi, SourceError, type SourceProfile } from '../../src/migration/migration-source.ts';
import { migrationImportHandler } from '../../src/jobs/migration-import.ts';
import { startTestApp } from '../helpers/test-app.ts';
import { createTmdb } from '../../src/metadata/tmdb.ts';

// ---- profiles, modelled on the quality profiles that Sonarr and Radarr send ----

const q = (id: number, name: string, source: string, resolution: number) => ({ quality: { id, name, source, resolution }, items: [], allowed: true });
const group = (id: number, name: string, items: ReturnType<typeof q>[], allowed = true) => ({ id, name, items, allowed });
const profile = (extra: Partial<SourceProfile>): SourceProfile => ({ id: 1, name: 'P', cutoff: 0, items: [], minFormatScore: 0, formatItems: [], language: null, ...extra });

describe('quality profile mapping', () => {
  it('maps a 1080p profile with a group cutoff to the 1080p preset', () => {
    const items = [{ ...q(1, 'SDTV', 'television', 480), allowed: false }, group(1002, 'WEB 1080p', [q(15, 'WEBRip-1080p', 'webRip', 1080), q(3, 'WEBDL-1080p', 'web', 1080)]), q(7, 'Bluray-1080p', 'bluray', 1080)];
    expect(mapProfile(profile({ items, cutoff: 1002 }))).toEqual({ preset: 'p1080', notes: [] });
  });

  it('maps a 2160p cutoff to the 2160p preset', () => {
    const items = [q(18, 'WEBDL-2160p', 'web', 2160), q(19, 'Bluray-2160p', 'bluray', 2160)];
    expect(mapProfile(profile({ items, cutoff: 19 })).preset).toBe('p2160');
  });

  it('uses the highest allowed resolution when the cutoff names a quality that is not allowed', () => {
    const items = [{ ...q(18, 'WEBDL-2160p', 'web', 2160), allowed: false }, q(3, 'WEBDL-1080p', 'web', 1080)];
    expect(mapProfile(profile({ items, cutoff: 18 })).preset).toBe('p1080');
  });

  it('has no preset for a profile below 1080p, and shows why', () => {
    const items = [q(5, 'WEBDL-720p', 'web', 720), q(4, 'HDTV-720p', 'television', 720)];
    expect(mapProfile(profile({ items, cutoff: 5 }))).toEqual({ preset: null, notes: ['sources_not_supported', 'resolution_not_supported'] });
  });

  it('notes a source that ladarr rejects, and several resolutions', () => {
    const items = [q(9, 'HDTV-1080p', 'television', 1080), q(3, 'WEBDL-1080p', 'web', 1080), q(18, 'WEBDL-2160p', 'web', 2160)];
    expect(mapProfile(profile({ items, cutoff: 3 }))).toEqual({ preset: 'p1080', notes: ['sources_not_supported', 'several_resolutions'] });
  });

  it('reads the names that Radarr uses for the sources', () => {
    const items = [q(3, 'WEBDL-1080p', 'webdl', 1080), q(15, 'WEBRip-1080p', 'webrip', 1080), q(7, 'Bluray-1080p', 'bluray', 1080)];
    expect(mapProfile(profile({ items, cutoff: 7 }))).toEqual({ preset: 'p1080', notes: [] });
  });

  it('notes custom formats and a language that ladarr does not keep', () => {
    const items = [q(3, 'WEBDL-1080p', 'web', 1080)];
    expect(mapProfile(profile({ items, cutoff: 3, formatItems: [{ score: 0 }, { score: 100 }] })).notes).toEqual(['custom_formats']);
    expect(mapProfile(profile({ items, cutoff: 3, minFormatScore: 10 })).notes).toEqual(['custom_formats']);
    expect(mapProfile(profile({ items, cutoff: 3, language: 'French' })).notes).toEqual(['language_preference']);
  });

  it('does not fail on a profile without items', () => {
    expect(mapProfile(profile({}))).toEqual({ preset: null, notes: ['resolution_not_supported'] });
  });
});

describe('path mapping', () => {
  const rules = [{ from: '/tv', to: '/data/tv' }, { from: '/tv/anime', to: '/data/anime' }];

  it('uses the rule with the longest start', () => {
    expect(mapPath('/tv/Show (2020)', rules)).toBe('/data/tv/Show (2020)');
    expect(mapPath('/tv/anime/Show', rules)).toBe('/data/anime/Show');
  });

  it('matches whole path parts only', () => {
    expect(mapPath('/tv2/Show', rules)).toBe('/tv2/Show');
  });

  it('keeps a path that no rule covers, and ignores an empty rule', () => {
    expect(mapPath('/other/Show', rules)).toBe('/other/Show');
    expect(mapPath('/other/Show', [{ from: '', to: '/x' }])).toBe('/other/Show');
  });

  it('reads a Windows path', () => {
    expect(mapPath('D:\\TV\\Show (2020)', [{ from: 'd:\\tv', to: '/data/tv' }])).toBe('/data/tv/Show (2020)');
  });

  it('ignores a slash at the end of a path', () => {
    expect(mapPath('/tv/Show/', rules)).toBe('/data/tv/Show');
  });
});

// ---- a fake Sonarr, Radarr and TMDB ----

const sonarrProfiles = [
  { id: 1, name: 'HD-1080p', cutoff: 1002, minFormatScore: 0, formatItems: [], items: [{ ...q(1, 'SDTV', 'television', 480), allowed: false }, group(1002, 'WEB 1080p', [q(15, 'WEBRip-1080p', 'webRip', 1080), q(3, 'WEBDL-1080p', 'web', 1080)])] },
  { id: 2, name: 'Ultra-HD', cutoff: 18, minFormatScore: 0, formatItems: [], items: [q(18, 'WEBDL-2160p', 'web', 2160)] },
];

const series = (id: number, extra: Record<string, unknown> = {}) => ({ id, title: `Show ${id}`, year: 2000 + id, tvdbId: 1000 + id, tmdbId: 5000 + id, path: `/tv/Show ${id}`, monitored: true, qualityProfileId: 1, seriesType: 'standard', seasons: [{ seasonNumber: 0, monitored: false }, { seasonNumber: 1, monitored: true }, { seasonNumber: 2, monitored: false }], ...extra });

type Fake = { server: Server; url: string; calls: { url: string; key: string | undefined }[] };
async function fakeSource(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<Fake> {
  const calls: Fake['calls'] = [];
  const server = createServer((req, res) => {
    calls.push({ url: req.url!, key: req.headers['x-api-key'] as string | undefined });
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls };
}
const send = (res: ServerResponse, body: unknown, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

function sonarrHandler({ version = '4.0.20.3014', key = 'good', list = [series(1), series(2)] as unknown[] } = {}) {
  return (req: IncomingMessage, res: ServerResponse) => {
    if (req.headers['x-api-key'] !== key) return send(res, { error: 'Unauthorized' }, 401);
    if (req.url === '/api/v3/system/status') return send(res, { appName: 'Sonarr', version });
    if (req.url === '/api/v3/series') return send(res, list);
    if (req.url === '/api/v3/qualityprofile') return send(res, sonarrProfiles);
    send(res, {}, 404);
  };
}

describe('reading a running instance', () => {
  let open: Server[] = [];
  afterAll(() => open.forEach((server) => server.close()));
  const start = async (handler: Parameters<typeof fakeSource>[0]) => {
    const fake = await fakeSource(handler);
    open.push(fake.server);
    return fake;
  };
  const code = (promise: Promise<unknown>) => promise.then(() => 'ok', (err: SourceError) => `${err.code}${err.detail ? `:${err.detail}` : ''}`);

  it('reads titles and profiles, and sends the key in a header only', async () => {
    const fake = await start(sonarrHandler());
    const data = await readFromApi({ url: fake.url, apiKey: 'good' });
    expect(data).toMatchObject({ app: 'sonarr', version: '4.0.20.3014' });
    expect(data.namespace).toMatch(/^sonarr:[0-9a-f]{8}$/);
    expect(data.titles[0]).toMatchObject({ sourceId: 1, mediaType: 'tv', tmdbId: 5001, tvdbId: 1001, path: '/tv/Show 1', monitored: true });
    expect(data.profiles.map((p) => p.name)).toEqual(['HD-1080p', 'Ultra-HD']);
    expect(fake.calls.every((call) => call.key === 'good' && !call.url.includes('good'))).toBe(true);
  });

  it('gives each instance its own namespace', async () => {
    const a = await start(sonarrHandler());
    const b = await start(sonarrHandler());
    expect((await readFromApi({ url: a.url, apiKey: 'good' })).namespace).not.toBe((await readFromApi({ url: b.url, apiKey: 'good' })).namespace);
  });

  it('refuses a wrong key, a wrong program and an unsupported version, with the reason', async () => {
    expect(await code(readFromApi({ url: (await start(sonarrHandler())).url, apiKey: 'bad' }))).toBe('source_key_rejected');
    expect(await code(readFromApi({ url: (await start((_req, res) => send(res, { appName: 'Lidarr', version: '2.0.0' }))).url, apiKey: 'k' }))).toBe('source_wrong_app:Lidarr');
    expect(await code(readFromApi({ url: (await start(sonarrHandler({ version: '3.0.10.1567' }))).url, apiKey: 'good' }))).toBe('source_version_unsupported:3.0.10.1567');
    expect(await code(readFromApi({ url: (await start((_req, res) => send(res, { appName: 'Radarr', version: '6.4.4.10685' }))).url, apiKey: 'k' }))).toMatch(/^source_unreachable|source_invalid_response|ok$/);
  });

  it('refuses an address with credentials, a wrong scheme, or no address at all', async () => {
    expect(await code(readFromApi({ url: 'http://user:pass@127.0.0.1:1', apiKey: 'k' }))).toBe('source_url_invalid');
    expect(await code(readFromApi({ url: 'ftp://127.0.0.1', apiKey: 'k' }))).toBe('source_url_invalid');
    expect(await code(readFromApi({ url: 'not a url', apiKey: 'k' }))).toBe('source_url_invalid');
  });

  it('does not follow a redirect with the key', async () => {
    const target = await start(sonarrHandler());
    const redirecting = await start((_req, res) => {
      res.writeHead(302, { location: `${target.url}/api/v3/system/status` });
      res.end();
    });
    expect(await code(readFromApi({ url: redirecting.url, apiKey: 'good' }))).toBe('source_unreachable:HTTP 302');
    expect(target.calls).toEqual([]);
  });

  it('says that an instance does not answer', async () => {
    const fake = await start(sonarrHandler());
    fake.server.close();
    expect(await code(readFromApi({ url: fake.url, apiKey: 'good' }))).toBe('source_unreachable');
  });

  it('reads an instance behind a URL base', async () => {
    const fake = await start((req, res) => sonarrHandler()({ ...req, url: req.url!.replace('/sonarr', ''), headers: req.headers } as IncomingMessage, res));
    expect(await code(readFromApi({ url: `${fake.url}/sonarr`, apiKey: 'good' }))).toBe('ok');
  });

  it('logs each outbound request with the target and the path, never the key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ladarr-migration-log-'));
    try {
      logToFile(join(dir, 'ladarr.log'));
      const secret = 'source-secret-key';
      const fake = await start(sonarrHandler({ key: secret }));
      await readFromApi({ url: fake.url, apiKey: secret });
      await closeLog();
      const entries = await recentLogs(20, { kind: 'requests' });
      const entry = entries.find((item) => item.message === 'outbound request' && String((item.request as { url?: string })?.url).includes('/api/v3/system/status'));
      expect(entry).toMatchObject({
        system: 'Migration source',
        request: { method: 'GET' },
        response: { status: 200 },
      });
      expect(JSON.stringify(entries)).not.toContain(secret);
    } finally {
      await closeLog();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- the whole import ----

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
let tmdbDown = false;
const tmdbFetch = (async (input: URL | string) => {
  const url = new URL(String(input));
  const path = url.pathname.replace('/3', '');
  if (tmdbDown) return json({}, 503);
  if (path === '/find/1003') return json({ tv_results: [{ id: 7003, name: 'Found by TVDB' }] });
  if (path === '/find/1004') return json({ tv_results: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }] });
  if (path === '/find/1005') return json({ tv_results: [] });
  const show = /^\/tv\/(\d+)$/.exec(path);
  if (show) {
    const id = Number(show[1]);
    // 5006 is a series that TMDB does not have.
    return id === 5006 ? json({}, 404) : json({ id, name: `Series ${id}`, first_air_date: '2000-01-01', status: 'Ended', seasons: [] });
  }
  const movie = /^\/movie\/(\d+)$/.exec(path);
  if (movie) return json({ id: Number(movie[1]), title: `Movie ${movie[1]}`, release_date: '2000-01-01', status: 'Released' });
  return json({}, 404);
}) as unknown as typeof fetch;

describe('import', () => {
  let app: Awaited<ReturnType<typeof startTestApp>>;
  let dir: string;
  let source: Fake;
  let events = createEvents();
  let runImport: () => Promise<void>;
  let list: unknown[];

  beforeAll(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'ladarr-migration-')));
    mkdirSync(join(dir, 'tv', 'Show 1'), { recursive: true });
    mkdirSync(join(dir, 'tv', 'Show 2'), { recursive: true });
    mkdirSync(join(dir, 'movies'));
    const tmdb = createTmdb({ apiKey: 'k', fetch: tmdbFetch, baseUrl: 'https://tmdb.test/3', spacingMs: 0, ttlMs: 0 });
    app = await startTestApp({ tmdb, events });
    await app.post('/roots', { path: join(dir, 'tv'), mediaType: 'tv' });
    await app.post('/roots', { path: join(dir, 'movies'), mediaType: 'movie' });

    list = [
      series(1),
      series(2, { monitored: false, seriesType: 'anime', qualityProfileId: 2 }),
      series(3, { tmdbId: 0, path: '/tv/Show 3' }),
      series(4, { tmdbId: 0 }),
      series(5, { tmdbId: 0 }),
      series(6),
      series(7, { tmdbId: 5001 }),
      series(8, { path: '/elsewhere/Show 8' }),
      series(9, { seriesType: 'daily', path: null }),
    ];
    source = await fakeSource((req, res) => sonarrHandler({ list })(req, res));
    const handler = migrationImportHandler({ db: app.db, tmdb, events, save: async () => {}, enqueue: (input) => app.db.data.jobs[Object.keys(app.db.data.jobs)[0]!] ?? ({} as never) });
    runImport = () => handler.run({} as never, { signal: new AbortController().signal });
  });
  afterAll(() => {
    app.close();
    source.server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const preview = (mappings: unknown = [{ from: '/tv', to: join(dir, 'tv') }]) => app.post('/migration/preview', { url: source.url, apiKey: 'good', mappings });
  const row = (body: { rows: { sourceId: number }[] }, id: number) => body.rows.find((r) => r.sourceId === id) as any;

  it('tests the connection', async () => {
    expect((await app.post('/migration/test', { url: source.url, apiKey: 'good' })).body).toEqual({ app: 'sonarr', version: '4.0.20.3014' });
    expect((await app.post('/migration/test', { url: source.url, apiKey: 'bad' })).body).toEqual({ error: 'source_key_rejected' });
    expect((await app.post('/migration/test', { url: source.url })).status).toBe(400);
  });

  it('shows a dry run, and makes no change', async () => {
    const before = JSON.stringify(app.db.data);
    const { status, body } = await preview();
    expect(status).toBe(200);
    expect(JSON.stringify(app.db.data)).toBe(before);

    expect(body.counts).toMatchObject({ new: 6, unmatched: 2, conflict: 1 });
    expect(body).toMatchObject({ app: 'sonarr', version: '4.0.20.3014' });
    expect(row(body, 1)).toMatchObject({ status: 'new', match: 'tmdb', tmdbId: 5001, preset: 'p1080', pathStatus: 'ok', mappedPath: join(dir, 'tv', 'Show 1') });
    expect(row(body, 1).notes).toEqual(['episode_monitoring']);
    expect(row(body, 2)).toMatchObject({ preset: 'p2160', pathStatus: 'ok' });
  });

  it('resolves a series by its TVDB ID, and keeps absent and ambiguous matches visible', async () => {
    const { body } = await preview();
    expect(row(body, 3)).toMatchObject({ status: 'new', match: 'tvdb', tmdbId: 7003, pathStatus: 'missing' });
    expect(row(body, 4)).toMatchObject({ status: 'unmatched', match: 'ambiguous', reason: 'tvdb_ambiguous', tmdbId: null });
    expect(row(body, 5)).toMatchObject({ status: 'unmatched', match: 'none', reason: 'tvdb_not_found' });
  });

  it('reports a title that the source lists twice, and a path outside the folders of ladarr', async () => {
    const { body } = await preview();
    expect(row(body, 7)).toMatchObject({ status: 'conflict', reason: 'duplicate_in_source' });
    expect(row(body, 8)).toMatchObject({ pathStatus: 'outside_roots', status: 'new' });
    expect(row(body, 9)).toMatchObject({ pathStatus: 'no_path', notes: expect.arrayContaining(['daily_series_type']) });
    // Without a mapping, the path of the source is not under a folder of ladarr.
    expect(row((await preview([])).body, 1).pathStatus).toBe('outside_roots');
  });

  it('refuses a bad mapping', async () => {
    expect((await preview([{ from: '/tv', to: 'relative/path' }])).status).toBe(400);
    expect((await preview('nope')).status).toBe(400);
  });

  it('refuses an unknown plan', async () => {
    expect((await app.post('/migration/import', { planId: 'nope' })).status).toBe(404);
  });

  it('imports the new titles with their folder, preset, pause state and season choices', async () => {
    const { body } = await preview();
    const queued = await app.post('/migration/import', { planId: body.planId });
    expect(queued).toMatchObject({ status: 202, body: { queued: 6, pending: 6 } });
    await runImport();

    const library = app.db.data.titles;
    expect(Object.keys(library).sort()).toEqual(['tv:5001', 'tv:5002', 'tv:5006', 'tv:5008', 'tv:5009', 'tv:7003'].filter((key) => key !== 'tv:5006'));
    expect(library['tv:5001']).toMatchObject({ folder: 'Show 1', preset: 'p1080', paused: false, seriesType: 'standard', seasonOverrides: { 2: 'unmonitored' } });
    expect(library['tv:5002']).toMatchObject({ folder: 'Show 2', preset: 'p2160', paused: true, seriesType: 'anime' });
    // A title outside the folders goes to the default folder without a folder name.
    expect(library['tv:5008']).toMatchObject({ folder: null });
    expect(library['tv:5008']!.rootId).toBe(app.db.data.settings.defaultRoots.tv);
    const ledger = Object.values(app.db.data.ledger);
    expect(ledger.filter((e) => e.status === 'imported')).toHaveLength(5);
    expect(ledger.find((e) => e.title === 'Show 6')).toMatchObject({ status: 'failed', error: 'tmdb_not_found' });
  });

  it('does not change the settings that the user made', async () => {
    expect(app.db.data.settings).not.toHaveProperty('defaultPreset');
    expect(app.db.data.profileOrder).toEqual(['p1080', 'p2160']);
  });

  it('skips what is done when the import runs again, and does not duplicate a title', async () => {
    const before = Object.keys(app.db.data.titles).length;
    const { body } = await preview();
    expect(row(body, 1)).toMatchObject({ status: 'imported' });
    expect(row(body, 6)).toMatchObject({ status: 'new', reason: 'tmdb_not_found' });
    const queued = await app.post('/migration/import', { planId: body.planId });
    // Only the title that failed before is tried again.
    expect(queued.body.queued).toBe(1);
    await runImport();
    expect(Object.keys(app.db.data.titles)).toHaveLength(before);
  });

  it('shows a title that is in the library already as matched, or as a conflict when its folder differs', async () => {
    // The user added Show 1 by hand in another folder after the ledger was cleared.
    app.db.data.ledger = {};
    app.db.data.titles['tv:5001']!.folder = 'Other folder';
    const { body } = await preview();
    expect(row(body, 1)).toMatchObject({ status: 'conflict', reason: 'folder_differs' });
    expect(row(body, 2)).toMatchObject({ status: 'matched' });
    app.db.data.titles['tv:5001']!.folder = 'Show 1';
  });

  it('keeps the pending titles when TMDB is down, and finishes them later', async () => {
    delete app.db.data.titles['tv:5002'];
    app.db.data.ledger = {};
    const { body } = await preview();
    await app.post('/migration/import', { planId: body.planId, select: ['x'] });
    expect(Object.values(app.db.data.ledger)).toHaveLength(0);

    const again = await preview();
    const queued = await app.post('/migration/import', { planId: again.body.planId, select: [row(again.body, 2).ledgerKey] });
    expect(queued.body.queued).toBe(1);
    tmdbDown = true;
    await expect(runImport()).rejects.toMatchObject({ code: 'unavailable' });
    tmdbDown = false;
    expect(Object.values(app.db.data.ledger)[0]!.status).toBe('pending');
    expect(app.db.data.titles['tv:5002']).toBeUndefined();

    await runImport();
    expect(Object.values(app.db.data.ledger)[0]!.status).toBe('imported');
    expect(app.db.data.titles['tv:5002']).toBeDefined();
  });

  it('shows the progress of the ledger', async () => {
    expect((await app.get('/migration/status')).body).toMatchObject({ pending: 0, imported: 1 });
  });
});
