import { existsSync, mkdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SearchResult } from '@ladarr/shared/types';
import type { MediaType, Tmdb } from '../../src/metadata/tmdb.ts';
import { episode, title } from '../helpers/test-fixtures.ts';
import { noLink } from '../helpers/test-import.ts';
import { startPipeline, until } from '../helpers/test-pipeline.ts';

const E01 = 'Show.Name.S01E01.1080p.WEB-DL.mkv';
const E02 = 'Show.Name.S01E02.1080p.WEB-DL.mkv';
const SHOW_FILE = 'Show Name (2020)/Season 01/Show Name - S01E01 - Episode 1.mkv';

const SHOW: SearchResult = { mediaType: 'tv', tmdbId: 1, title: 'Show Name', year: 2020, overview: '', posterPath: null, originalLanguage: 'en' };
const MOVIE: SearchResult = { mediaType: 'movie', tmdbId: 2, title: 'Movie Name', year: 2019, overview: '', posterPath: null, originalLanguage: 'en' };
const EPISODES = [1, 2, 3].map((number) => ({ tmdbId: 100 + number, season: 1, number, name: `Episode ${number}`, airDate: `2020-01-0${number}`, runtime: 45 }));

// A small TMDB. The name in the request decides which titles come back.
const tmdb = {
  search: async (query: string) => {
    const text = query.toLowerCase();
    return [MOVIE, SHOW].filter((result) => text && result.title.toLowerCase().includes(text));
  },
  details: async (mediaType: MediaType, id: number) => ({
    ...title().meta,
    mediaType,
    tmdbId: id,
    title: mediaType === 'tv' ? SHOW.title : MOVIE.title,
    year: mediaType === 'tv' ? SHOW.year : MOVIE.year,
    seasons: mediaType === 'tv' ? [{ seasonNumber: 1, episodeCount: EPISODES.length, airDate: '2020-01-01' }] : [],
  }),
  season: async (_id: number, seasonNumber: number) => EPISODES.map((item) => ({ ...item, season: seasonNumber })),
} as unknown as Tmdb;

async function startSourceTest(options: Parameters<typeof startPipeline>[0] = {}) {
  const pipe = await startPipeline(options);
  pipe.db.data.settings.defaultRoots = { movie: 'movie', tv: 'tv' };
  const inbox = join(pipe.dir, 'inbox');
  mkdirSync(inbox);
  const api = await pipe.api({ tmdb });

  const write = (base: string, files: Record<string, string>) => {
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(base, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
  };
  const finished = (id: string) => until(() => pipe.importStatus.run(id)?.finished && !pipe.db.data.imports[id]);
  const detect = (path: string) => api.post('/import/source/detect', { path });
  const preview = (body: Record<string, unknown>) => api.post('/import/source/preview', body);
  const start = (body: Record<string, unknown>) => api.post('/import/source', body);

  return {
    pipe,
    api,
    inbox,
    write,
    finished,
    detect,
    preview,
    start,
    async stop() {
      api.close();
      await pipe.stop();
    },
  };
}

let t: Awaited<ReturnType<typeof startSourceTest>> | undefined;
afterEach(async () => {
  await t?.stop();
  t = undefined;
});

describe('detect', () => {
  it('reads a series folder and finds its title in TMDB', async () => {
    t = await startSourceTest();
    t.write(t.inbox, {
      [E01]: 'one',
      [E02]: 'two',
      // A sample, a hidden folder, and a link to another folder are not part of the source.
      'Sample/Show.Name.S01E03.mkv': 'sample',
      '.hidden/Show.Name.S01E03.mkv': 'hidden',
      'notes.txt': 'not a video',
    });
    mkdirSync(join(t.pipe.dir, 'outside'));
    writeFileSync(join(t.pipe.dir, 'outside', 'Show.Name.S01E03.mkv'), 'secret');
    symlinkSync(join(t.pipe.dir, 'outside'), join(t.inbox, 'linked'));

    const { status, body } = await t.detect(t.inbox);
    expect(status).toBe(200);
    // The folder name gives no match, so the name of the files is used.
    expect(body.folder).toMatchObject({ path: realpathSync(t.inbox), mediaType: 'tv', guess: { title: 'Show Name', year: null }, videoFiles: 2, truncated: false });
    expect(body.folder.sizeBytes).toBe(6);
    expect(body.folder.results[0]).toMatchObject({ mediaType: 'tv', tmdbId: 1 });
    expect(t.pipe.db.data.titles).toEqual({});
  });

  it('reads a movie folder and takes the year from the name', async () => {
    t = await startSourceTest();
    t.write(t.inbox, { 'Movie.Name.2019.1080p.BluRay.x264-GRP.mkv': 'film' });
    const { body } = await t.detect(t.inbox);
    expect(body.folder).toMatchObject({ mediaType: 'movie', guess: { title: 'Movie Name', year: 2019 }, videoFiles: 1 });
    expect(body.folder.results[0]).toMatchObject({ mediaType: 'movie', tmdbId: 2 });
  });

  it('puts the results of the detected type first', async () => {
    t = await startSourceTest();
    t.write(t.inbox, { 'Name.2019.mkv': 'film' });
    const { body } = await t.detect(t.inbox);
    expect(body.folder.mediaType).toBe('movie');
    expect(body.folder.results.map((result: SearchResult) => result.mediaType)).toEqual(['movie', 'tv']);
  });

  it('accepts a folder inside a library folder', async () => {
    t = await startSourceTest();
    const folder = join(t.pipe.folders.tv, 'Untitled Show');
    t.write(folder, { [E01]: 'one' });
    expect((await t.detect(folder)).status).toBe(200);
  });

  it('refuses a path that it can not read, and changes nothing', async () => {
    t = await startSourceTest();
    const file = join(t.inbox, 'a.txt');
    writeFileSync(file, 'x');
    mkdirSync(join(t.pipe.dir, '.ladarr-hidden'));
    const cases: [Record<string, unknown>, number, string][] = [
      [{}, 400, 'path_not_absolute'],
      [{ path: 'inbox' }, 400, 'path_not_absolute'],
      [{ path: join(t.pipe.dir, 'nope') }, 404, 'folder_not_found'],
      [{ path: file }, 400, 'not_a_folder'],
      [{ path: '/' }, 400, 'folder_too_broad'],
      // The folder holds a library folder, so an import would write the library into itself.
      [{ path: t.pipe.dir }, 400, 'folder_has_library'],
      [{ path: join(t.pipe.dir, '.ladarr-hidden') }, 400, 'folder_not_allowed'],
    ];
    for (const [body, status, error] of cases) {
      expect(await t.detect(body.path as string)).toMatchObject({ status, body: { error } });
    }
    // An empty folder has nothing to import.
    expect((await t.detect(t.inbox)).body).toEqual({ error: 'nothing_to_import' });
    expect(t.pipe.db.data.titles).toEqual({});
    expect(t.pipe.db.data.imports).toEqual({});
  });

  it('answers 503 when no metadata provider is connected', async () => {
    const pipe = await startPipeline();
    const inbox = join(pipe.dir, 'inbox');
    mkdirSync(inbox);
    writeFileSync(join(inbox, E01), 'one');
    const api = await pipe.api();
    try {
      expect(await api.post('/import/source/detect', { path: inbox })).toMatchObject({ status: 503, body: { error: 'metadata_unavailable' } });
    } finally {
      api.close();
      await pipe.stop();
    }
  });
});

describe('preview', () => {
  it('shows the plan of a series that is not in the catalog, and changes nothing', async () => {
    t = await startSourceTest();
    // The worker schedules its periodic jobs before the first request.
    const jobs = Object.values(t.pipe.db.data.jobs).map((job) => job.id).sort();
    t.write(t.inbox, {
      [E01]: 'one',
      [E02]: 'two',
      'Show.Name.S01E04.mkv': 'four',
      'readme.mkv': 'x',
      'extra/Show.Name.S01E02.720p.mkv': 'tw',
    });
    const { status, body } = await t.preview({ path: t.inbox, mediaType: 'tv', tmdbId: 1 });
    expect(status).toBe(200);
    expect(body.preview).toMatchObject({
      titleKey: 'tv:1',
      created: true,
      rootId: 'tv',
      rootPath: realpathSync(t.pipe.folders.tv),
      folder: 'Show Name (2020)',
      plan: {
        titleKey: 'tv:1',
        importable: 2,
        nameMatch: true,
        truncated: false,
        coverage: [{ season: 1, total: 3, covered: 2, missing: [3] }],
      },
    });
    expect(body.preview.plan.files.map((file: { rel: string; status: string }) => [file.rel, file.status])).toEqual([
      [E01, 'new'],
      [E02, 'new'],
      ['Show.Name.S01E04.mkv', 'unknown_episode'],
      ['extra/Show.Name.S01E02.720p.mkv', 'duplicate'],
      ['readme.mkv', 'unmatched'],
    ]);
    expect(body.preview.plan.steps).toBeUndefined();
    expect(t.pipe.db.data.titles).toEqual({});
    expect(t.pipe.db.data.files).toEqual({});
    expect(t.pipe.db.data.imports).toEqual({});
    expect(Object.values(t.pipe.db.data.jobs).map((job) => job.id).sort()).toEqual(jobs);
  });

  it('uses a title that is in the catalog, and its folder', async () => {
    t = await startSourceTest();
    t.pipe.db.data.titles['tv:1'] = title({ key: 'tv:1', tmdbId: 1, rootId: 'tv', folder: 'Old Show', episodes: [episode(1, 1), episode(1, 2)], episodesLoadedAt: 1 });
    t.write(t.inbox, { [E01]: 'one' });
    const { body } = await t.preview({ path: t.inbox, mediaType: 'tv', tmdbId: 1 });
    expect(body.preview).toMatchObject({ created: false, folder: 'Old Show', plan: { importable: 1 } });
    expect(body.preview.plan.files[0]).toMatchObject({ status: 'new', dest: 'Old Show/Season 01/Show Name - S01E01 - Episode 1.mkv' });
  });

  it('refuses a request that is not valid', async () => {
    t = await startSourceTest();
    const cases: [Record<string, unknown>, number, string][] = [
      [{ path: t.inbox, mediaType: 'tv' }, 400, 'invalid_title'],
      [{ path: t.inbox, mediaType: 'x', tmdbId: 1 }, 400, 'invalid_title'],
      [{ path: t.inbox, mediaType: 'tv', tmdbId: 0 }, 400, 'invalid_title'],
      [{ path: join(t.pipe.dir, 'nope'), mediaType: 'tv', tmdbId: 1 }, 404, 'folder_not_found'],
    ];
    for (const [body, status, error] of cases) {
      expect(await t.preview(body)).toMatchObject({ status, body: { error } });
    }
    expect(t.pipe.db.data.titles).toEqual({});
  });

  it('needs a default library folder and a healthy one', async () => {
    t = await startSourceTest();
    t.write(t.inbox, { [E01]: 'one' });
    t.pipe.db.data.settings.defaultRoots.tv = null;
    expect(await t.preview({ path: t.inbox, mediaType: 'tv', tmdbId: 1 })).toMatchObject({ status: 409, body: { error: 'root_required' } });
    t.pipe.db.data.settings.defaultRoots.tv = 'tv';
    t.pipe.db.data.roots.tv = { id: 'tv', path: join(t.pipe.dir, 'gone'), mediaType: 'tv', dev: 0 };
    expect(await t.preview({ path: t.inbox, mediaType: 'tv', tmdbId: 1 })).toMatchObject({ status: 409, body: { error: 'root_unavailable' } });
    expect(t.pipe.db.data.titles).toEqual({});
  });
});

describe('start', () => {
  it('adds the series to the catalog and links the files into the library', async () => {
    t = await startSourceTest();
    t.write(t.inbox, { [E01]: 'one', [E02]: 'two' });
    const started = await t.start({ path: t.inbox, mediaType: 'tv', tmdbId: 1 });
    expect(started.status).toBe(202);
    expect(started.body).toMatchObject({ titleKey: 'tv:1', created: true, total: 2 });
    await t.finished(started.body.id);

    const show = t.pipe.db.data.titles['tv:1']!;
    expect(show).toMatchObject({ rootId: 'tv', folder: 'Show Name (2020)', policy: 'all', episodesLoadedAt: expect.any(Number) });
    expect(show.episodes.map((item) => [item.number, Boolean(item.fileId)])).toEqual([
      [1, true],
      [2, true],
      [3, false],
    ]);

    const library = join(t.pipe.folders.tv, SHOW_FILE);
    expect(existsSync(library)).toBe(true);
    expect(statSync(library).ino).toBe(statSync(join(t.inbox, E01)).ino);
    expect(statSync(library).nlink).toBe(2);
    // The source stays as it is.
    expect(existsSync(join(t.inbox, E01))).toBe(true);
    expect(statSync(join(t.inbox, E01)).nlink).toBe(2);
    expect(t.pipe.db.data.imports).toEqual({});
    expect(Object.values(t.pipe.db.data.jobs).some((job) => job.dedupeKey === 'initial:tv:1')).toBe(true);
    expect(t.pipe.importStatus.run(started.body.id)!.problems).toEqual([]);

    const detail = await t.api.get('/library/tv:1');
    expect(detail.body.title).toMatchObject({ availability: 'missing', counts: { available: 2, eligible: 3 } });
  });

  it('adds a movie and marks it available', async () => {
    t = await startSourceTest();
    t.write(t.inbox, { 'Movie.Name.2019.1080p.BluRay.x264-GRP.mkv': 'film' });
    const started = await t.start({ path: t.inbox, mediaType: 'movie', tmdbId: 2 });
    expect(started.body).toMatchObject({ titleKey: 'movie:2', created: true, total: 1 });
    await t.finished(started.body.id);
    expect(t.pipe.db.data.titles['movie:2']).toMatchObject({ rootId: 'movie', folder: 'Movie Name (2019)' });
    expect(existsSync(join(t.pipe.folders.movies, 'Movie Name (2019)', 'Movie Name (2019).mkv'))).toBe(true);
    expect((await t.api.get('/library/movie:2')).body.title.availability).toBe('available');
  });

  it('imports into a title that is in the catalog already', async () => {
    t = await startSourceTest();
    t.pipe.db.data.titles['tv:1'] = title({ key: 'tv:1', tmdbId: 1, rootId: 'tv', folder: 'Old Show', episodes: [episode(1, 1), episode(1, 2)], episodesLoadedAt: 1 });
    t.write(t.inbox, { [E01]: 'one', [E02]: 'two' });
    const started = await t.start({ path: t.inbox, mediaType: 'tv', tmdbId: 1 });
    expect(started.body).toMatchObject({ titleKey: 'tv:1', created: false, total: 2 });
    await t.finished(started.body.id);
    expect(Object.keys(t.pipe.db.data.titles)).toEqual(['tv:1']);
    expect(existsSync(join(t.pipe.folders.tv, 'Old Show', 'Season 01', 'Show Name - S01E02 - Episode 2.mkv'))).toBe(true);
  });

  it('starts nothing when no file can be imported, and adds no title', async () => {
    t = await startSourceTest();
    t.write(t.inbox, { 'Show.Name.S01E09.mkv': 'nine' });
    expect((await t.preview({ path: t.inbox, mediaType: 'tv', tmdbId: 1 })).body.preview.plan.importable).toBe(0);
    expect(await t.start({ path: t.inbox, mediaType: 'tv', tmdbId: 1 })).toMatchObject({ status: 409, body: { error: 'nothing_to_import' } });
    expect(t.pipe.db.data.titles).toEqual({});
    expect(t.pipe.db.data.imports).toEqual({});
  });

  it('does not start a second journal for a title that has one', async () => {
    t = await startSourceTest();
    t.pipe.db.data.imports['busy'] = { id: 'busy', hash: 'manual:busy', titleKey: 'tv:1', steps: [], createdAt: 0 };
    t.write(t.inbox, { [E01]: 'one' });
    expect(await t.start({ path: t.inbox, mediaType: 'tv', tmdbId: 1 })).toMatchObject({ status: 409, body: { error: 'title_busy' } });
    expect(t.pipe.db.data.titles).toEqual({});
  });

  it('never copies a file when the disk allows no hard link', async () => {
    t = await startSourceTest({ fs: { link: noLink('EXDEV') } });
    t.write(t.inbox, { [E01]: 'one', [E02]: 'two' });
    const started = await t.start({ path: t.inbox, mediaType: 'tv', tmdbId: 1 });
    await t.finished(started.body.id);
    const run = t.pipe.importStatus.run(started.body.id)!;
    expect(run.problems.map((problem) => problem.code)).toEqual(['hard_link_unavailable', 'hard_link_unavailable']);
    expect(existsSync(join(t.pipe.folders.tv, SHOW_FILE))).toBe(false);
    expect(statSync(join(t.inbox, E01)).nlink).toBe(1);
    expect(t.pipe.db.data.files).toEqual({});
  });

  it('checks each file before it publishes it', async () => {
    t = await startSourceTest({ probe: async () => ({ ok: false, reason: 'unreadable' }) });
    t.write(t.inbox, { [E01]: 'one' });
    const started = await t.start({ path: t.inbox, mediaType: 'tv', tmdbId: 1 });
    await t.finished(started.body.id);
    expect(t.pipe.importStatus.run(started.body.id)!.problems.map((problem) => problem.code)).toEqual(['file_unreadable']);
    expect(existsSync(join(t.pipe.folders.tv, SHOW_FILE))).toBe(false);
  });

  it('refuses a start that has no healthy destination', async () => {
    t = await startSourceTest();
    t.write(t.inbox, { [E01]: 'one' });
    t.pipe.db.data.settings.defaultRoots.tv = null;
    expect(await t.start({ path: t.inbox, mediaType: 'tv', tmdbId: 1 })).toMatchObject({ status: 409, body: { error: 'root_required' } });
    expect(t.pipe.db.data.titles).toEqual({});
  });
});
