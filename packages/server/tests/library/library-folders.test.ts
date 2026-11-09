import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { guessTitle } from '../../src/library/tools/folders.ts';
import { startTestApp } from '../helpers/test-app.ts';
import { movie, title } from '../helpers/test-fixtures.ts';
import type { MediaType, Tmdb } from '../../src/metadata/tmdb.ts';

let app: Awaited<ReturnType<typeof startTestApp>>;
let dir: string;
let tv: string;
let movies: string;
let tmdbCalls: string[] = [];

const write = (path: string, text = 'data') => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
};

// TMDB answers after a short wait, so two requests can overlap.
const tmdb = {
  details: async (mediaType: MediaType, id: number) => {
    tmdbCalls.push(`${mediaType}:${id}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { ...title().meta, mediaType, tmdbId: id, title: `Title ${id}` };
  },
} as unknown as Tmdb;

beforeAll(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'ladarr-folders-')));
  tv = join(dir, 'tv');
  movies = join(dir, 'movies');
  mkdirSync(tv);
  mkdirSync(movies);
  app = await startTestApp({ tmdb });
});
afterAll(() => {
  app.close();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  for (const root of [tv, movies]) for (const name of readdirSync(root)) rmSync(join(root, name), { recursive: true, force: true });
  const dev = statSync(tv).dev;
  app.db.data.roots = { tv: { id: 'tv', path: tv, mediaType: 'tv', dev }, movies: { id: 'movies', path: movies, mediaType: 'movie', dev } };
  Object.assign(app.db.data, { titles: {}, files: {}, jobs: {} });
  tmdbCalls = [];
});

describe('guessTitle', () => {
  it.each([
    ['Film Name (2019)', 'Film Name', 2019],
    ['Film Name (2019) {tmdb-603}', 'Film Name', 2019],
    ['Film Name [imdbid-tt0133093] (1999)', 'Film Name', 1999],
    ['Film.Name.2019.1080p.BluRay.x264', 'Film Name', 2019],
    ['Film_Name_2019', 'Film Name', 2019],
    ['2001 A Space Odyssey 1968', '2001 A Space Odyssey', 1968],
    ['Mr. Robot', 'Mr. Robot', null],
    ['Show Name', 'Show Name', null],
    ['(2019)', '(2019)', 2019],
    ['  ', '  ', null],
  ])('reads %j as %j, %j', (name, expected, year) => {
    expect(guessTitle(name)).toEqual({ title: expected, year });
  });
});

describe('folders without a title', () => {
  it('lists the folders that have a video and no title, with the guess from the name', async () => {
    write(join(movies, 'Free Film (2001)', 'Free Film (2001).mkv'), '12345');
    write(join(movies, 'Free Film (2001)', 'poster.jpg'));
    write(join(tv, 'Free Show', 'Season 01', 'Free.Show.S01E01.mkv'), '12');
    write(join(tv, 'Free Show', 'Season 01', 'Free.Show.S01E02.mkv'), '123');
    const { body } = await app.get('/library/folders');
    expect(body.skipped).toEqual([]);
    expect(body.folders).toEqual([
      { rootId: 'movies', mediaType: 'movie', folder: 'Free Film (2001)', videoFiles: 1, sizeBytes: 5, guess: { title: 'Free Film', year: 2001 } },
      { rootId: 'tv', mediaType: 'tv', folder: 'Free Show', videoFiles: 2, sizeBytes: 5, guess: { title: 'Free Show', year: null } },
    ]);
  });

  it('skips a folder that a title uses, also when the title sits in a folder below it', async () => {
    write(join(movies, 'Used (2000)', 'a.mkv'));
    write(join(tv, 'Anime', 'Show', 'Show.S01E01.mkv'));
    write(join(tv, 'Other', 'Show.S01E01.mkv'));
    app.db.data.titles['movie:2'] = movie({ rootId: 'movies', folder: 'Used (2000)' });
    app.db.data.titles['tv:1'] = title({ rootId: 'tv', folder: 'Anime/Show' });
    expect((await app.get('/library/folders')).body.folders.map((f: { folder: string }) => f.folder)).toEqual(['Other']);
  });

  it('skips folders without a video, samples, hidden folders, the recovery folder, tool folders and folder links', async () => {
    write(join(movies, 'Only Art', 'poster.jpg'));
    write(join(movies, 'Only Sample', 'film-sample.mkv'));
    write(join(movies, '.ladarr-recovery', '2026-01-01', 'x-a.mkv'));
    write(join(movies, '.hidden', 'a.mkv'));
    write(join(movies, '@eaDir', 'a.mkv'));
    write(join(movies, '#recycle', 'a.mkv'));
    write(join(dir, 'elsewhere', 'a.mkv'));
    symlinkSync(join(dir, 'elsewhere'), join(movies, 'Linked'));
    write(join(movies, 'Real', 'a.mkv'));
    expect((await app.get('/library/folders')).body.folders.map((f: { folder: string }) => f.folder)).toEqual(['Real']);
  });

  it('reports a root that cannot be trusted and does not list its folders', async () => {
    write(join(movies, 'Film', 'a.mkv'));
    app.db.data.roots.movies!.dev += 1;
    const { body } = await app.get('/library/folders');
    expect(body.folders).toEqual([]);
    expect(body.skipped).toEqual([{ rootId: 'movies', path: movies }]);
  });
});

describe('adopt a folder', () => {
  const adopt = (body: Record<string, unknown>) => app.post('/library/folders/adopt', body);

  it('adds a movie with the folder, queues a scan, and starts no search', async () => {
    write(join(movies, 'Film (2001)', 'Film (2001).mkv'));
    const { status, body } = await adopt({ rootId: 'movies', folder: 'Film (2001)', tmdbId: 5 });
    expect(status).toBe(201);
    expect(body).toEqual({ key: 'movie:5' });
    expect(app.db.data.titles['movie:5']).toMatchObject({ rootId: 'movies', folder: 'Film (2001)', paused: false });
    const types = Object.values(app.db.data.jobs).map((job) => job.type);
    expect(types).toEqual(['library.scan']);
    // The folder is not free any more.
    expect((await app.get('/library/folders')).body.folders).toEqual([]);
  });

  it('adds a series with the Future policy, so the old episodes do not start downloads', async () => {
    write(join(tv, 'Show', 'Show.S01E01.mkv'));
    const { body } = await adopt({ rootId: 'tv', folder: 'Show', tmdbId: 9 });
    expect(app.db.data.titles['tv:9']).toMatchObject({ policy: 'future', folder: 'Show', seriesType: 'standard' });
    expect(Object.values(app.db.data.jobs).map((job) => job.type)).toEqual(['metadata.refresh']);
    expect(body).toEqual({ key: 'tv:9' });
  });

  it('gives the folder to one of two requests that run at the same time', async () => {
    write(join(movies, 'Film', 'a.mkv'));
    const results = await Promise.all([adopt({ rootId: 'movies', folder: 'Film', tmdbId: 1 }), adopt({ rootId: 'movies', folder: 'Film', tmdbId: 2 })]);
    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
    expect(results.find((result) => result.status === 409)!.body).toMatchObject({ error: 'folder_in_use' });
    expect(Object.values(app.db.data.titles).filter((t) => t.folder === 'Film')).toHaveLength(1);
    // The failed request did not even ask TMDB.
    expect(tmdbCalls).toHaveLength(1);
  });

  it('refuses a folder that a title uses already', async () => {
    write(join(movies, 'Film', 'a.mkv'));
    app.db.data.titles['movie:2'] = movie({ rootId: 'movies', folder: 'Film' });
    expect((await adopt({ rootId: 'movies', folder: 'Film', tmdbId: 5 })).body).toEqual({ error: 'folder_in_use', key: 'movie:2' });
    expect(app.db.data.titles['movie:5']).toBeUndefined();
  });

  it('gives the folder to a title that is in the library without one, and keeps the folder of a title that has one', async () => {
    write(join(movies, 'Film', 'a.mkv'));
    write(join(movies, 'Other', 'a.mkv'));
    app.db.data.titles['movie:2'] = movie({ rootId: 'movies', folder: null });
    const attached = await adopt({ rootId: 'movies', folder: 'Film', tmdbId: 2 });
    expect(attached).toMatchObject({ status: 200, body: { key: 'movie:2' } });
    expect(app.db.data.titles['movie:2']!.folder).toBe('Film');
    expect(Object.values(app.db.data.jobs).map((job) => job.type)).toEqual(['library.scan']);
    expect((await adopt({ rootId: 'movies', folder: 'Other', tmdbId: 2 })).body).toEqual({ error: 'already_in_library', key: 'movie:2' });
    expect(app.db.data.titles['movie:2']!.folder).toBe('Film');
    expect(tmdbCalls).toEqual([]);
  });

  it.each(['..', '.', '', '../movies', 'a/b', 'a\\b', '.ladarr-recovery', '.hidden', 'x'.repeat(256)])('rejects the folder name %j', async (folder) => {
    expect((await adopt({ rootId: 'movies', folder, tmdbId: 5 })).body).toEqual({ error: 'invalid_folder' });
    expect(tmdbCalls).toEqual([]);
  });

  it('rejects bad input, a missing folder, and a link to another folder', async () => {
    write(join(movies, 'Real', 'a.mkv'));
    symlinkSync(join(movies, 'Real'), join(movies, 'Alias'));
    expect((await adopt({ rootId: 'nope', folder: 'Real', tmdbId: 5 })).body).toEqual({ error: 'invalid_folder' });
    expect((await adopt({ rootId: 'movies', folder: 'Real', tmdbId: 'x' })).body).toEqual({ error: 'invalid_folder' });
    expect((await adopt({ rootId: 'movies', folder: 'Missing', tmdbId: 5 })).body).toEqual({ error: 'folder_not_found' });
    expect((await adopt({ rootId: 'movies', folder: 'Alias', tmdbId: 5 })).body).toEqual({ error: 'invalid_folder' });
    expect(Object.keys(app.db.data.titles)).toEqual([]);
  });

  it('refuses a root that cannot be trusted', async () => {
    write(join(movies, 'Real', 'a.mkv'));
    app.db.data.roots.movies!.dev += 1;
    expect((await adopt({ rootId: 'movies', folder: 'Real', tmdbId: 5 })).body).toMatchObject({ error: 'root_unusable' });
    expect(Object.keys(app.db.data.titles)).toEqual([]);
  });

  it('answers 503 when no metadata provider is connected', async () => {
    const bare = await startTestApp();
    try {
      expect((await bare.post('/library/folders/adopt', { rootId: 'x', folder: 'y', tmdbId: 1 })).body).toEqual({ error: 'metadata_unavailable' });
    } finally {
      bare.close();
    }
  });
});
