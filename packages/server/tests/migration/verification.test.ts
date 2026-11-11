import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFinder } from '../../src/library/grab/finder.ts';
import type { IndexerService } from '../../src/library/grab/torznab.ts';
import { emptyData, open, type Db } from '../../src/core/db.ts';
import { createEvents } from '../../src/core/events.ts';
import { enqueue, type Job } from '../../src/core/jobs.ts';
import { createQueue, type Queue } from '../../src/library/downloads/queue.ts';
import type { Clients } from '../../src/library/downloads/client-api.ts';
import { ClientError, type ClientHandle, type Torrent } from '../../src/library/downloads/qbittorrent.ts';
import { libraryVerifyHandler } from '../../src/jobs/library-verify.ts';
import { verifySweepHandler } from '../../src/jobs/verify-sweep.ts';
import type { Episode, Title } from '../../src/library/library.ts';
import { requestVerification } from '../../src/library/verification.ts';
import { startTestApp } from '../helpers/test-app.ts';
import { backupZip, sonarrDatabase, SONARR_SERIES } from '../helpers/test-backup.ts';
import { createTmdb, type Tmdb } from '../../src/metadata/tmdb.ts';
import { buildPlan } from '../../src/migration/migration.ts';
import type { SourceData } from '../../src/migration/migration-source.ts';

const HASH = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

const torrent = (hash: string, complete: boolean, status = complete ? 'uploading' : 'downloading') =>
  ({ hash, name: `Download ${hash.slice(0, 4)}`, sizeBytes: 1000, progress: complete ? 1 : 0.5, complete, status }) as Torrent;

function episode(season: number, number: number, extra: Partial<Episode> = {}): Episode {
  return { tmdbId: number, season, number, name: `Episode ${number}`, airDate: null, runtime: null, override: null, fileId: null, ...extra };
}

function title(key: string, mediaType: 'tv' | 'movie', episodes: Episode[] = []): Title {
  return {
    key,
    mediaType,
    tmdbId: Number(key.split(':')[1]),
    meta: { mediaType, tmdbId: 1, title: 'Test', year: 2000, overview: '', posterPath: null, originalLanguage: 'en', originalTitle: 'Test', aliases: [], date: null, status: '', rating: null, votes: 0, backdropPath: null, runtime: null, imdbId: null, tvdbId: null, releaseDates: [], seasons: [] },
    metaLoadedAt: Date.now(),
    refreshedAt: Date.now(),
    addedAt: Date.now(),
    paused: false,
    policy: 'all',
    futureFrom: 0,
    seriesType: 'standard',
    preset: null,
    rootId: 'tv',
    folder: null,
    manualRelease: false,
    seasonOverrides: {},
    episodesLoadedAt: mediaType === 'tv' ? Date.now() : null,
    episodes,
    fileId: null,
  };
}

type Fake = { clients: Clients; handle: ClientHandle; calls: string[]; fail: boolean };

function fakeClients(list: Torrent[]): Fake {
  const state = { calls: [], fail: false } as unknown as Fake;
  const handle = {
    id: 'client-1',
    config: {},
    api: {
      async byHashes(hashes: string[]) {
        state.calls.push(...hashes);
        if (state.fail) throw new ClientError('unreachable', 'no');
        return list.filter((item) => hashes.includes(item.hash));
      },
      async setPaused(hash: string) {
        state.calls.push(`resume:${hash}`);
      },
    },
  } as unknown as ClientHandle;
  state.handle = handle;
  state.clients = { all: () => [handle], get: (id) => (id === 'client-1' ? handle : undefined), next: () => handle };
  return state;
}

async function setup({ mediaType = 'tv' as 'tv' | 'movie', episodes = [episode(1, 1, { airDate: '2001-01-01' }), episode(1, 2, { airDate: '2001-01-01' })], list = [] as Torrent[] } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ladarr-verify-')));
  mkdirSync(join(dir, 'tv'), { recursive: true });
  mkdirSync(join(dir, 'movies'), { recursive: true });
  const db: Db = await open('unused.json');
  Object.assign(db.data, emptyData());
  db.data.roots = {
    tv: { id: 'tv', path: join(dir, 'tv'), mediaType: 'tv', dev: statSync(join(dir, 'tv')).dev },
    movie: { id: 'movie', path: join(dir, 'movies'), mediaType: 'movie', dev: statSync(join(dir, 'movies')).dev },
  };
  const events = createEvents();
  const queue: Queue = createQueue(events, () => {});
  const finder = createFinder({ queue, indexers: {} as IndexerService, enqueue: (input) => enqueue(input) });
  const fake = fakeClients(list);
  const key = mediaType === 'tv' ? 'tv:1' : 'movie:1';
  const item = title(key, mediaType, episodes);
  if (mediaType === 'movie') item.rootId = 'movie';
  db.data.titles[key] = item;
  const handler = libraryVerifyHandler({ queue, clients: fake.clients, finder, events });
  const run = () => handler.run({ payload: { key } } as Job, { signal: new AbortController().signal });
  return { dir, db, queue, finder, fake, key, run, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('library verification', () => {
  const cleanups: (() => void)[] = [];
  afterAll(() => cleanups.forEach((cleanup) => cleanup()));

  it('attaches a complete torrent and searches the episode that it does not cover', async () => {
    const test = await setup({ list: [torrent(HASH, true)] });
    cleanups.push(test.cleanup);
    requestVerification((input) => enqueue(input), test.key, { downloads: [{ hash: HASH, episodes: [{ season: 1, number: 1 }], at: 1, id: 5, failed: false }] });
    await test.run();
    expect(test.db.data.queue[`${test.key}:1x1`]).toMatchObject({ stage: 'validating', transferHash: HASH, clientId: 'client-1' });
    expect(test.db.data.queue[`${test.key}:1x1`]!.release).toMatchObject({ external: true, manual: true });
    expect(test.db.data.queue[`${test.key}:1x2`]).toMatchObject({ stage: 'queued', transferHash: null });
    expect(test.db.data.verifications[test.key]!.pending).toBe(false);
  });

  it('leaves the episode to the search when the torrent is not in the client', async () => {
    const test = await setup({ list: [] });
    cleanups.push(test.cleanup);
    requestVerification((input) => enqueue(input), test.key, { downloads: [{ hash: HASH, episodes: [{ season: 1, number: 1 }], at: 1, id: 5, failed: false }] });
    await test.run();
    expect(test.db.data.queue[`${test.key}:1x1`]).toMatchObject({ stage: 'queued', transferHash: null });
  });

  it('searches when the newest event failed and the torrent is not complete', async () => {
    const test = await setup({ list: [torrent(HASH, false)] });
    cleanups.push(test.cleanup);
    requestVerification((input) => enqueue(input), test.key, { downloads: [{ hash: HASH, episodes: [{ season: 1, number: 1 }], at: 1, id: 9, failed: true }] });
    await test.run();
    expect(test.db.data.queue[`${test.key}:1x1`]).toMatchObject({ stage: 'queued', transferHash: null });
  });

  it('resumes a stopped partial torrent', async () => {
    const test = await setup({ list: [torrent(HASH, false, 'paused')] });
    cleanups.push(test.cleanup);
    requestVerification((input) => enqueue(input), test.key, { downloads: [{ hash: HASH, episodes: [{ season: 1, number: 1 }], at: 1, id: 5, failed: false }] });
    await test.run();
    expect(test.fake.calls).toContain(`resume:${HASH}`);
    expect(test.db.data.queue[`${test.key}:1x1`]).toMatchObject({ stage: 'downloading' });
  });

  it('keeps the work pending and starts no search when the client is unreachable', async () => {
    const test = await setup({ list: [] });
    cleanups.push(test.cleanup);
    test.fake.fail = true;
    requestVerification((input) => enqueue(input), test.key, { downloads: [{ hash: HASH, episodes: [{ season: 1, number: 1 }], at: 1, id: 5, failed: false }] });
    await expect(test.run()).rejects.toMatchObject({ kind: 'outage' });
    expect(test.db.data.verifications[test.key]!.pending).toBe(true);
    expect(Object.keys(test.db.data.queue)).toHaveLength(0);
  });

  it('applies the monitoring of each episode and uses the air date of the source', async () => {
    const test = await setup({ episodes: [episode(1, 1), episode(2, 1, { airDate: '2001-01-01' })] });
    cleanups.push(test.cleanup);
    test.db.data.titles[test.key]!.seasonOverrides = { 2: 'unmonitored' };
    requestVerification((input) => enqueue(input), test.key, {
      episodes: [
        { season: 1, number: 1, monitored: false, airDateUtc: '2001-02-03T00:00:00Z' },
        { season: 2, number: 1, monitored: true, airDateUtc: null },
      ],
    });
    await test.run();
    const [first, second] = test.db.data.titles[test.key]!.episodes;
    expect(first).toMatchObject({ override: 'unmonitored', airDate: '2001-02-03T00:00:00Z' });
    expect(second).toMatchObject({ override: 'monitored', airDate: '2001-01-01' });
    // The episode of the unmonitored season is not searched even though the source monitors it? It is: the source wins.
    expect(test.db.data.queue[`${test.key}:2x1`]).toBeDefined();
    expect(test.db.data.queue[`${test.key}:1x1`]).toBeUndefined();
  });

  it('attaches a movie torrent before its release date, and starts no search without a date', async () => {
    const attached = await setup({ mediaType: 'movie', list: [torrent(HASH, true)] });
    cleanups.push(attached.cleanup);
    requestVerification((input) => enqueue(input), attached.key, { downloads: [{ hash: HASH, episodes: [], at: 1, id: 5, failed: false }] });
    await attached.run();
    expect(attached.db.data.queue[attached.key]).toMatchObject({ stage: 'validating', transferHash: HASH });

    const missing = await setup({ mediaType: 'movie', episodes: [] });
    cleanups.push(missing.cleanup);
    requestVerification((input) => enqueue(input), missing.key, { downloads: [] });
    await missing.run();
    expect(missing.db.data.queue[missing.key]).toBeUndefined();
  });

  it('skips a hash that another title works with', async () => {
    const test = await setup({ list: [torrent(HASH, true)] });
    cleanups.push(test.cleanup);
    const other = title('tv:2', 'tv', [episode(1, 1)]);
    test.db.data.titles['tv:2'] = other;
    test.queue.ensure('tv:2', 1, 1);
    test.db.data.queue['tv:2:1x1']!.transferHash = HASH;
    requestVerification((input) => enqueue(input), test.key, { downloads: [{ hash: HASH, episodes: [{ season: 1, number: 1 }], at: 1, id: 5, failed: false }] });
    await test.run();
    expect(test.db.data.queue[`${test.key}:1x1`]).toMatchObject({ stage: 'queued', transferHash: null });
  });

  it('returns a blocked import to the search after a delay', async () => {
    const test = await setup();
    cleanups.push(test.cleanup);
    requestVerification((input) => enqueue(input), test.key, { downloads: [] });
    const entry = test.queue.ensure(test.key, 1, 1);
    test.queue.startAttempt(entry, 'attached download');
    test.queue.move(entry, { stage: 'validating', reason: { code: 'torrent_missing' } }, 'torrent gone');
    entry.stageSince = Date.now() - 31 * 60_000;
    await test.run();
    expect(test.db.data.queue[`${test.key}:1x1`]).toMatchObject({ stage: 'queued', branch: null, reason: null, transferHash: null });
  });

  it('merges a second import into the waiting work without losing a hash', async () => {
    const test = await setup();
    cleanups.push(test.cleanup);
    const enqueueJob = (input: Parameters<typeof enqueue>[0]) => enqueue(input);
    requestVerification(enqueueJob, test.key, { downloads: [{ hash: HASH, episodes: [{ season: 1, number: 1 }], at: 1, id: 1, failed: false }] });
    requestVerification(enqueueJob, test.key, { downloads: [{ hash: OTHER, episodes: [{ season: 1, number: 2 }], at: 2, id: 2, failed: false }] });
    expect(test.db.data.verifications[test.key]!.downloads.map((download) => download.hash).sort()).toEqual([HASH, OTHER].sort());
    expect(Object.values(test.db.data.jobs).filter((job) => job.dedupeKey === `verify:${test.key}`)).toHaveLength(1);
  });
});

describe('verification on a resume', () => {
  let app: Awaited<ReturnType<typeof startTestApp>>;
  let dir: string;
  beforeAll(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'ladarr-verify-api-')));
    mkdirSync(join(dir, 'tv'), { recursive: true });
    app = await startTestApp();
    await app.post('/roots', { path: join(dir, 'tv'), mediaType: 'tv' });
  });
  afterAll(() => {
    app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('starts the verification when the user resumes a paused title', async () => {
    const key = 'tv:77';
    app.db.data.titles[key] = { ...title(key, 'tv', [episode(1, 1, { airDate: '2001-01-01' })]), paused: true, rootId: Object.keys(app.db.data.roots)[0]! };
    const { status } = await app.patch(`/library/${key}`, { paused: false });
    expect(status).toBe(200);
    expect(app.db.data.verifications[key]).toMatchObject({ pending: true });
    expect(Object.values(app.db.data.jobs).some((job) => job.dedupeKey === `verify:${key}`)).toBe(true);
  });
});

describe('a re-import of a title that is in the library', () => {
  const hash = 'D'.repeat(40);
  let app: Awaited<ReturnType<typeof startTestApp>>;
  let dir: string;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const tmdbFetch = (async (input: URL | string) => {
    const path = new URL(String(input)).pathname.replace('/3', '');
    const show = /^\/tv\/(\d+)$/.exec(path);
    if (show) return json({ id: Number(show[1]), name: 'Show 1', first_air_date: '2001-01-01', status: 'Ended', seasons: [] });
    return json({}, 404);
  }) as unknown as typeof fetch;

  beforeAll(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'ladarr-verify-reimport-')));
    mkdirSync(join(dir, 'tv', 'Show 1'), { recursive: true });
    const tmdb = createTmdb({ apiKey: 'k', fetch: tmdbFetch, baseUrl: 'https://tmdb.test/3', spacingMs: 0, ttlMs: 0 });
    app = await startTestApp({ tmdb });
    await app.post('/roots', { path: join(dir, 'tv'), mediaType: 'tv' });
    const root = Object.keys(app.db.data.roots)[0]!;
    app.db.data.titles['tv:5001'] = { ...title('tv:5001', 'tv', [episode(1, 1, { airDate: '2001-01-01' })]), paused: true, rootId: root, folder: 'Show 1' };
  });
  afterAll(() => {
    app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('syncs the source facts and queues the verification, with no add request', async () => {
    const episodes = [{ id: 1, seriesId: 1, seasonNumber: 1, episodeNumber: 1, monitored: true, airDateUtc: '2001-01-01T00:00:00Z' }];
    const history = [{ id: 1, episodeId: 1, movieId: null, downloadId: hash, eventType: 1, date: '2001-01-02T00:00:00Z' }];
    const zip = backupZip(sonarrDatabase(237, { series: [SONARR_SERIES[0]!], episodes, history }));
    const { csrfToken } = await (await fetch(`${app.base}/auth/status`, { headers: { cookie: app.cookie } })).json();
    const sent = await fetch(`${app.base}/migration/backup?name=sonarr_backup_v4.0.20.3014_x.zip`, { method: 'POST', headers: { cookie: app.cookie, 'x-csrf-token': csrfToken, 'content-type': 'application/zip' }, body: new Blob([new Uint8Array(zip)]) });
    const backup = (await sent.json()) as { backupId: string };
    const preview = await app.post('/migration/preview', { backupId: backup.backupId, mappings: [{ from: '/tv', to: join(dir, 'tv') }] });
    expect(preview.body.rows[0]).toMatchObject({ status: 'matched' });
    expect(preview.body.counts).toMatchObject({ new: 0, verify: 1 });

    const imported = await app.post('/migration/import', { planId: preview.body.planId });
    expect(imported.body).toMatchObject({ queued: 0, verified: 1 });
    expect(app.db.data.titles['tv:5001']).toMatchObject({ paused: false, seasonOverrides: { 2: 'unmonitored' } });
    expect(app.db.data.verifications['tv:5001']!.downloads[0]).toMatchObject({ hash: hash.toLowerCase() });
  });
});

describe('the retry of a pending verification', () => {
  it('starts a pending verification again, whatever stopped it', async () => {
    const db: Db = await open('unused.json');
    Object.assign(db.data, emptyData());
    db.data.titles['tv:1'] = title('tv:1', 'tv', [episode(1, 1)]);
    db.data.verifications['tv:1'] = { key: 'tv:1', downloads: [], episodes: [], pending: true, updatedAt: 1 };
    const handler = verifySweepHandler({ enqueue: (input) => enqueue(input) });
    await handler.run({} as Job, { signal: new AbortController().signal });
    expect(Object.values(db.data.jobs).some((job) => job.dedupeKey === 'verify:tv:1')).toBe(true);
  });
});

describe('the source facts of an add', () => {
  it('keeps a movie that Radarr searched before its release searchable', async () => {
    const db: Db = await open('unused.json');
    Object.assign(db.data, emptyData());
    const source: SourceData = {
      app: 'radarr',
      version: 'x',
      namespace: 'radarr:test',
      profiles: [],
      titles: [
        {
          sourceId: 1,
          mediaType: 'movie',
          title: 'Movie',
          year: 2000,
          tmdbId: 1,
          tvdbId: null,
          path: null,
          monitored: true,
          qualityProfileId: 1,
          seriesType: 'standard',
          seasons: [],
          minimumAvailability: 'inCinemas',
        },
      ],
    };
    const plan = await buildPlan({} as Tmdb, source, []);
    expect(plan.requests.get('radarr:test:1')).toMatchObject({ manualRelease: true });
  });
});

describe('the sweep', () => {
  it('searches an episode that aired more than seven days ago and has no entry', async () => {
    const db: Db = await open('unused.json');
    Object.assign(db.data, emptyData());
    const queue = createQueue(createEvents(), () => {});
    const finder = createFinder({ queue, indexers: {} as IndexerService, enqueue: (input) => enqueue(input) });
    const key = 'tv:90';
    db.data.titles[key] = title(key, 'tv', [episode(1, 1, { airDate: '2001-01-01' })]);
    finder.sweep();
    expect(db.data.queue[`${key}:1x1`]).toMatchObject({ stage: 'queued' });
  });
});
