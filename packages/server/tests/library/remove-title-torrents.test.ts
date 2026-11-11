import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PlanPreview } from '@ladarr/shared/types';
import type { Services } from '../../src/app.ts';
import type { QueueEntry } from '../../src/library/downloads/queue.ts';
import { scanTitle } from '../../src/library/scan.ts';
import { startTestApp } from '../helpers/test-app.ts';
import { movie } from '../helpers/test-fixtures.ts';

let app: Awaited<ReturnType<typeof startTestApp>>;
let dir: string;
let movies: string;
const removed: { hash: string; deleteFiles: boolean }[] = [];

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
              remove: async (hash: string, deleteFiles = false) => {
                removed.push({ hash, deleteFiles });
              },
            },
          }
        : undefined,
  } as unknown as Services['clients'];
  app = await startTestApp({
    services: { clients, queue: {} as Services['queue'], finder: {} as Services['finder'], poller: {} as Services['poller'] },
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
  Object.assign(app.db.data, { titles: {}, files: {}, imports: {}, queue: {}, jobs: {} });
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
});
