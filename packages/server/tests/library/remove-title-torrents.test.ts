import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PlanPreview } from '@ladarr/shared/types';
import { withDefaults } from '../../src/core/db.ts';
import { createEvents } from '../../src/core/events.ts';
import { createQueue } from '../../src/library/downloads/queue.ts';
import { scanTitle } from '../../src/library/scan.ts';
import { startTestApp } from '../helpers/test-app.ts';
import { episode, movie, title } from '../helpers/test-fixtures.ts';
import type { QueueEntry, Services } from '../../src/types.ts';

let app: Awaited<ReturnType<typeof startTestApp>>;
let dir: string;
let movies: string;
const removed: { hash: string; deleteFiles: boolean }[] = [];
// The files of each torrent. A torrent that is not here holds one episode of each of two seasons.
const manifests: Record<string, string[]> = {};
const queue = createQueue(createEvents(), () => {});

const FILE = 'Film (2000)/Film (2000).mkv';

const entry = {
  id: 'movie:2',
  titleKey: 'movie:2',
  season: null,
  number: null,
  stage: 'downloading',
  branch: null,
  reason: null,
  revision: 0,
  createdAt: 0,
  stageSince: 0,
  completedAt: null,
  clearedAt: null,
  priority: null,
  attempt: 0,
  attempts: [],
  history: [],
  search: null,
  release: { guid: 'release', indexerId: 1, indexerName: 'Indexer', title: 'Release', sizeBytes: 1, infoHash: 'hash', link: null, magnet: null, kind: 'single', seeders: 1, manual: false },
  transferHash: 'hash',
  clientId: 'client',
  manualMatch: null,
  importResult: null,
} as unknown as QueueEntry;

const plan = (body: unknown) => app.post('/library/plans', body);
const preview = async (body: unknown) => (await plan(body)).body as PlanPreview;
const apply = (planId: string) => app.post(`/library/plans/${planId}/apply`);

beforeAll(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'ladarr-remove-title-')));
  movies = join(dir, 'movies');
  mkdirSync(movies);
  const clients = {
    get: (id: string) =>
      id === 'client'
        ? {
            api: {
              files: async (hash: string) => (manifests[hash] ?? ['Show.S01E01.mkv', 'Show.S02E01.mkv']).map((name) => ({ name })),
              remove: async (hash: string, deleteFiles = false) => {
                if (hash === 'offline') throw new Error('Client unreachable');
                removed.push({ hash, deleteFiles });
              },
            },
          }
        : undefined,
  } as unknown as Services['clients'];
  app = await startTestApp({
    services: { clients, queue, finder: {} as Services['finder'], poller: {} as Services['poller'] },
  });
  app.db.data.roots = { movies: { id: 'movies', path: movies, mediaType: 'movie', dev: statSync(movies).dev } };
});
afterAll(() => {
  app.close();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  rmSync(movies, { recursive: true, force: true });
  mkdirSync(movies);
  Object.assign(app.db.data, { titles: {}, files: {}, imports: {}, queue: {}, queueItems: {}, jobs: {}, verifications: {} });
  app.db.data.downloadClients = [{ id: 'client', enabled: true } as (typeof app.db.data.downloadClients)[number]];
  app.db.data.seerr.requests = {};
  for (const hash of Object.keys(manifests)) delete manifests[hash];
  app.db.data.roots.movies!.dev = statSync(movies).dev;
  removed.length = 0;
});
afterEach(() => {
  removed.length = 0;
});

async function seedFilm() {
  mkdirSync(join(movies, 'Film (2000)'), { recursive: true });
  writeFileSync(join(movies, FILE), 'the film');
  app.db.data.titles['movie:2'] = movie({ rootId: 'movies', folder: 'Film (2000)' });
  await scanTitle('movie:2');
  app.db.data.queue['movie:2'] = entry;
}

describe('removal of a title and its torrent', () => {
  it('keeps a pack with files from another season even if only one season uses it in the queue', async () => {
    const show = title({ rootId: 'movies', episodes: [episode(1, 1), episode(2, 1)] });
    app.db.data.titles[show.key] = show;
    app.db.data.queue['tv:1:1x1'] = { ...entry, id: 'tv:1:1x1', titleKey: show.key, season: 1, number: 1 };
    const body = await preview({ action: 'remove', keys: [show.key], season: 1, deleteFiles: true });

    expect((await apply(body.planId)).body).toMatchObject({ changed: 1, skipped: [] });
    expect(removed).toEqual([]);
    expect(show.seasonOverrides).toEqual({ 1: 'unmonitored' });
  });

  it('keeps the torrent and the files when the user does not delete the files', async () => {
    await seedFilm();
    const body = await preview({ action: 'remove', keys: ['movie:2'] });

    const result = (await apply(body.planId)).body as { changed: number };

    expect(result.changed).toBe(1);
    expect(app.db.data.titles['movie:2']).toBeUndefined();
    expect(removed).toEqual([]);
    expect(existsSync(join(movies, FILE))).toBe(true);
  });

  it('removes the torrent with its files when the user deletes the files', async () => {
    await seedFilm();
    const body = await preview({ action: 'remove', keys: ['movie:2'], deleteFiles: true });

    await apply(body.planId);

    expect(removed).toEqual([{ hash: 'hash', deleteFiles: true }]);
    expect(existsSync(join(movies, FILE))).toBe(false);
  });

  it('deletes an external download recorded only on an imported file', async () => {
    await seedFilm();
    delete app.db.data.queue['movie:2'];
    const file = Object.values(app.db.data.files)[0]!;
    file.download = { clientId: 'client', hash: 'external', external: true };
    const body = await preview({ action: 'remove', keys: ['movie:2'], deleteFiles: true });
    expect((await apply(body.planId)).body).toMatchObject({ changed: 1, deleted: 1, skipped: [] });
    expect(removed).toEqual([{ hash: 'external', deleteFiles: true }]);
  });

  it('keeps a download that a file of another title still uses', async () => {
    await seedFilm();
    const file = Object.values(app.db.data.files)[0]!;
    app.db.data.files.other = { ...file, id: 'other', titleKey: 'movie:3', download: { clientId: 'client', hash: 'hash', external: true } };
    const body = await preview({ action: 'remove', keys: ['movie:2'], deleteFiles: true });
    expect((await apply(body.planId)).body).toMatchObject({ changed: 1, deleted: 1 });
    expect(removed).toEqual([]);
  });

  it.each([['client', 'offline'], ['missing', 'hash']])('keeps the title for another attempt if %s cannot delete %s', async (clientId, hash) => {
    await seedFilm();
    delete app.db.data.queue['movie:2'];
    const file = Object.values(app.db.data.files)[0]!;
    file.download = { clientId, hash, external: true };
    const body = await preview({ action: 'remove', keys: ['movie:2'], deleteFiles: true });
    expect((await apply(body.planId)).body).toMatchObject({ changed: 0, skipped: [{ key: 'movie:2', reason: 'torrent_not_deleted' }] });
    expect(app.db.data.titles['movie:2']).toBeDefined();
    expect(app.db.data.files[file.id]?.download).toEqual({ clientId, hash, external: true });
    expect(existsSync(join(movies, FILE))).toBe(true);
  });
});

// The client gets the torrent of a target of the series.
function link(season: number, number: number, hash: string, clientId = 'client') {
  const target = queue.ensure('tv:1', season, number);
  queue.request(target, 'test');
  Object.assign(target, { transferHash: hash, clientId });
  queue.resolve(target, 'downloading', 'test');
  return target;
}

describe('removal of everything that a title used', () => {
  const remove = async (season?: number) => {
    const body = await preview({ action: 'remove', keys: ['tv:1'], deleteFiles: true, ...(season === undefined ? {} : { season }) });
    return (await apply(body.planId)).body;
  };
  const hashes = () => removed.map(({ hash }) => hash).sort();

  beforeEach(() => {
    app.db.data.titles['tv:1'] = title({ rootId: 'movies', episodes: [episode(1, 1), episode(2, 1)] });
  });

  it.each(['fallback', 'restart', 'request'] as const)('deletes the torrent that a target left behind after %s', async (way) => {
    const target = link(1, 1, 'old');
    if (way === 'fallback') queue.fallback(target, 'test');
    else if (way === 'restart') queue.restart(target);
    else {
      queue.complete(target, 'test');
      queue.request(target, 'test');
    }
    expect(target.transferHash).toBeNull();

    expect(await remove()).toMatchObject({ changed: 1, skipped: [] });
    expect(removed).toEqual([{ hash: 'old', deleteFiles: true }]);
  });

  it('deletes the earlier torrents of the removed season only, and the others with the title', async () => {
    manifests.first = ['Show.S01E01.mkv'];
    manifests.second = ['Show.S02E01.mkv'];
    queue.fallback(link(1, 1, 'first'), 'test');
    queue.fallback(link(2, 1, 'second'), 'test');

    await remove(1);
    expect(hashes()).toEqual(['first']);

    removed.length = 0;
    await remove();
    expect(hashes()).toEqual(['second']);
  });

  it.each([[['Show.S01E01.mkv', 'extra.mkv']], [['video.mkv']], [[]]])('deletes the torrent of a removed season with the files %j', async (files) => {
    manifests.hash = files;
    link(1, 1, 'hash');

    expect(await remove(1)).toMatchObject({ changed: 1, skipped: [] });
    expect(hashes()).toEqual(['hash']);
  });

  it('deletes a pack that a season removal kept when the title goes', async () => {
    link(1, 1, 'pack');

    await remove(1);
    expect(removed).toEqual([]);

    await remove();
    expect(hashes()).toEqual(['pack']);
  });

  it('removes a title whose earlier torrent was in a client that is gone', async () => {
    queue.fallback(link(1, 1, 'old', 'gone'), 'test');

    expect(await remove()).toMatchObject({ changed: 1, skipped: [] });
    expect(removed).toEqual([]);
  });

  it('removes the verification and the Seerr requests of the title only', async () => {
    const state = { downloads: [], episodes: [], pending: true, updatedAt: 0 };
    app.db.data.verifications = { 'tv:1': { key: 'tv:1', ...state }, 'tv:3': { key: 'tv:3', ...state } };
    const request = { seasons: [], createdAt: 0, updatedAt: 0 };
    app.db.data.seerr.requests = { 1: { id: 1, mediaType: 'tv', tmdbId: 1, ...request }, 2: { id: 2, mediaType: 'movie', tmdbId: 1, ...request } };

    await remove();

    expect(Object.keys(app.db.data.verifications)).toEqual(['tv:3']);
    expect(Object.keys(app.db.data.seerr.requests)).toEqual(['2']);
  });

  it('records the torrent that a target of an older file has now', () => {
    link(1, 1, 'hash');
    delete app.db.data.titles['tv:1']!.torrents;

    const loaded = withDefaults(structuredClone(app.db.data));

    expect(loaded.titles['tv:1']!.torrents).toEqual([{ clientId: 'client', hash: 'hash', season: 1, number: 1 }]);
  });
});
