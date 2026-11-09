import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/core/db.ts';
import { createEvents } from '../../src/core/events.ts';
import { availability, seriesCounts, type Episode, type Title } from '../../src/library/library.ts';
import { scanTitle } from '../../src/library/scan.ts';
import { libraryScanHandler } from '../../src/jobs/library-scan.ts';
import { startTestApp } from '../helpers/test-app.ts';

let dir: string;
let tv: string;
let movies: string;
let db: Db;

const clock = () => ({ now: Date.now(), timeZone: 'UTC', region: 'US', files: db.data.files });
const write = (path: string, bytes = 10) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, Buffer.alloc(bytes));
};

const episode = (season: number, number: number): Episode => ({ tmdbId: season * 100 + number, season, number, name: `E${number}`, airDate: '2000-01-01', runtime: 45, override: null, fileId: null });

function title(key: string, mediaType: 'movie' | 'tv', folder: string | null, episodes: Episode[] = []): Title {
  return {
    key,
    mediaType,
    tmdbId: 1,
    meta: { mediaType, tmdbId: 1, title: 'T', year: 2000, overview: '', posterPath: null, originalLanguage: 'en', originalTitle: 'T', aliases: [], date: null, status: 'Ended', rating: null, votes: 0, backdropPath: null, runtime: 45, imdbId: null, tvdbId: null, releaseDates: [{ region: 'US', kind: 'digital', date: '2000-01-01T00:00:00.000Z' }], seasons: [] },
    refreshedAt: 0,
    addedAt: 0,
    paused: false,
    policy: 'all',
    futureFrom: 0,
    seriesType: 'standard',
    preset: null,
    rootId: mediaType === 'movie' ? 'movies' : 'tv',
    folder,
    manualRelease: false,
    seasonOverrides: {},
    episodesLoadedAt: 1,
    episodes,
    fileId: null,
  };
}

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'ladarr-scan-')));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

beforeEach(async () => {
  rmSync(join(dir, 'lib'), { recursive: true, force: true });
  tv = join(dir, 'lib', 'tv');
  movies = join(dir, 'lib', 'movies');
  mkdirSync(tv, { recursive: true });
  mkdirSync(movies, { recursive: true });
  db = await openDb('unused.json');
  const dev = statSync(tv).dev;
  db.data.roots = { tv: { id: 'tv', path: tv, mediaType: 'tv', dev }, movies: { id: 'movies', path: movies, mediaType: 'movie', dev } };
});

describe('movie scan', () => {
  it('records the largest video file, and ignores samples, subtitles and other files', async () => {
    write(join(movies, 'Film (2000)', 'Film (2000).mkv'), 500);
    write(join(movies, 'Film (2000)', 'Sample', 'sample.mkv'), 900);
    write(join(movies, 'Film (2000)', 'film-sample.mkv'), 900);
    write(join(movies, 'Film (2000)', 'Film (2000).srt'), 700);
    write(join(movies, 'Film (2000)', 'Extras', 'Featurette.mp4'), 100);
    db.data.titles['movie:1'] = title('movie:1', 'movie', 'Film (2000)');

    const result = await scanTitle(db, 'movie:1');
    expect(result).toMatchObject({ status: 'ok', added: 1, extraFiles: ['Film (2000)/Extras/Featurette.mp4'] });
    const file = db.data.files[db.data.titles['movie:1']!.fileId!]!;
    expect(file).toMatchObject({ path: 'Film (2000)/Film (2000).mkv', sizeBytes: 500, missing: false, titleKey: 'movie:1' });
    expect(availability(db.data.titles['movie:1']!, clock())).toBe('available');
  });

  it('keeps its file when a bigger one appears, and does not add a second record when it runs again', async () => {
    write(join(movies, 'Film', 'a.mkv'), 100);
    db.data.titles['movie:1'] = title('movie:1', 'movie', 'Film');
    await scanTitle(db, 'movie:1');
    const first = db.data.titles['movie:1']!.fileId;
    write(join(movies, 'Film', 'b.mkv'), 900);
    const result = await scanTitle(db, 'movie:1');
    expect(db.data.titles['movie:1']!.fileId).toBe(first);
    expect(result).toMatchObject({ added: 0, updated: 1, extraFiles: ['Film/b.mkv'] });
    expect(Object.keys(db.data.files)).toHaveLength(1);
  });

  it('marks a file that is gone as missing, keeps the record, and takes a new file after that', async () => {
    write(join(movies, 'Film', 'a.mkv'), 100);
    db.data.titles['movie:1'] = title('movie:1', 'movie', 'Film');
    await scanTitle(db, 'movie:1');
    const id = db.data.titles['movie:1']!.fileId!;
    rmSync(join(movies, 'Film', 'a.mkv'));

    expect(await scanTitle(db, 'movie:1')).toMatchObject({ status: 'ok', missing: 1 });
    expect(db.data.files[id]!.missing).toBe(true);
    expect(db.data.titles['movie:1']!.fileId).toBe(id);
    expect(availability(db.data.titles['movie:1']!, clock())).toBe('missing');

    write(join(movies, 'Film', 'a.mkv'), 100);
    await scanTitle(db, 'movie:1');
    expect(db.data.files[id]!.missing).toBe(false);

    rmSync(join(movies, 'Film', 'a.mkv'));
    await scanTitle(db, 'movie:1');
    write(join(movies, 'Film', 'new.mkv'), 50);
    await scanTitle(db, 'movie:1');
    expect(db.data.files[id]).toBeUndefined();
    expect(db.data.files[db.data.titles['movie:1']!.fileId!]!.path).toBe('Film/new.mkv');
  });
});

describe('series scan', () => {
  const episodes = () => [episode(1, 1), episode(1, 2), episode(1, 3), episode(1, 4)];

  it('matches files to episodes, and counts each episode of a multi-episode file once', async () => {
    write(join(tv, 'Show', 'Season 01', 'Show.S01E01.1080p.mkv'));
    write(join(tv, 'Show', 'Season 01', 'Show.S01E02E03.mkv'));
    write(join(tv, 'Show', 'Season 01', 'random.mkv'));
    write(join(tv, 'Show', 'Season 01', 'Show.S09E01.mkv'));
    db.data.titles['tv:1'] = title('tv:1', 'tv', 'Show', episodes());

    const result = await scanTitle(db, 'tv:1');
    expect(result).toMatchObject({ status: 'ok', added: 2, unmatched: ['Show/Season 01/random.mkv'], unknownEpisodes: ['Show/Season 01/Show.S09E01.mkv'] });
    const eps = db.data.titles['tv:1']!.episodes;
    expect(eps.map((e) => Boolean(e.fileId))).toEqual([true, true, true, false]);
    expect(eps[1]!.fileId).toBe(eps[2]!.fileId);
    const file = db.data.files[eps[1]!.fileId!]!;
    expect(file.episodes).toEqual([{ season: 1, number: 2 }, { season: 1, number: 3 }]);
    expect(seriesCounts(db.data.titles['tv:1']!, clock())).toMatchObject({ eligible: 4, available: 3 });
  });

  it('keeps the file that an episode has, and reports a second file for it', async () => {
    write(join(tv, 'Show', 'Show.S01E01.mkv'));
    db.data.titles['tv:1'] = title('tv:1', 'tv', 'Show', episodes());
    await scanTitle(db, 'tv:1');
    const first = db.data.titles['tv:1']!.episodes[0]!.fileId;
    write(join(tv, 'Show', 'Show.S01E01.proper.mkv'));
    const result = await scanTitle(db, 'tv:1');
    expect(result.duplicates).toEqual(['Show/Show.S01E01.proper.mkv']);
    expect(db.data.titles['tv:1']!.episodes[0]!.fileId).toBe(first);
  });

  it('marks the files of a removed episode as missing and shows the episode as missing', async () => {
    write(join(tv, 'Show', 'Show.S01E01.mkv'));
    write(join(tv, 'Show', 'Show.S01E02.mkv'));
    db.data.titles['tv:1'] = title('tv:1', 'tv', 'Show', episodes());
    await scanTitle(db, 'tv:1');
    rmSync(join(tv, 'Show', 'Show.S01E02.mkv'));
    expect((await scanTitle(db, 'tv:1')).missing).toBe(1);
    expect(seriesCounts(db.data.titles['tv:1']!, clock())).toMatchObject({ eligible: 4, available: 1 });
    expect(db.data.titles['tv:1']!.episodes[1]!.fileId).toBeTruthy();
  });
});

describe('safety', () => {
  it('records nothing when the root is not there, so a missing mount deletes nothing', async () => {
    write(join(movies, 'Film', 'a.mkv'));
    db.data.titles['movie:1'] = title('movie:1', 'movie', 'Film');
    await scanTitle(db, 'movie:1');
    const id = db.data.titles['movie:1']!.fileId!;

    rmSync(movies, { recursive: true });
    expect((await scanTitle(db, 'movie:1')).status).toBe('root_unavailable');
    expect(db.data.files[id]!.missing).toBe(false);
    expect(db.data.titles['movie:1']!.fileId).toBe(id);
  });

  it('records nothing when another disk is mounted at the root', async () => {
    write(join(movies, 'Film', 'a.mkv'));
    db.data.titles['movie:1'] = title('movie:1', 'movie', 'Film');
    await scanTitle(db, 'movie:1');
    db.data.roots.movies!.dev += 1;
    expect((await scanTitle(db, 'movie:1')).status).toBe('root_unavailable');
    expect(Object.values(db.data.files).every((file) => !file.missing)).toBe(true);
  });

  it('marks the files as missing when the root is healthy but the folder of the title is gone', async () => {
    write(join(movies, 'Film', 'a.mkv'));
    db.data.titles['movie:1'] = title('movie:1', 'movie', 'Film');
    await scanTitle(db, 'movie:1');
    rmSync(join(movies, 'Film'), { recursive: true });
    expect(await scanTitle(db, 'movie:1')).toMatchObject({ status: 'folder_missing', missing: 1 });
  });

  it('refuses a folder that leaves the root', async () => {
    write(join(dir, 'lib', 'outside', 'a.mkv'));
    db.data.titles['movie:1'] = title('movie:1', 'movie', '../outside');
    expect((await scanTitle(db, 'movie:1')).status).toBe('no_folder');
    expect(Object.keys(db.data.files)).toHaveLength(0);
  });

  it('does not follow a folder link, and ignores a file link that leaves the root', async () => {
    write(join(dir, 'lib', 'elsewhere', 'big.mkv'), 999);
    mkdirSync(join(movies, 'Film'), { recursive: true });
    write(join(movies, 'Film', 'real.mkv'), 5);
    symlinkSync(join(dir, 'lib', 'elsewhere'), join(movies, 'Film', 'linked-folder'));
    symlinkSync(join(dir, 'lib', 'elsewhere', 'big.mkv'), join(movies, 'Film', 'linked-file.mkv'));
    db.data.titles['movie:1'] = title('movie:1', 'movie', 'Film');
    await scanTitle(db, 'movie:1');
    expect(db.data.files[db.data.titles['movie:1']!.fileId!]!.path).toBe('Film/real.mkv');
  });

  it('does nothing for a title without a folder, or an unknown title', async () => {
    db.data.titles['movie:1'] = title('movie:1', 'movie', null);
    expect((await scanTitle(db, 'movie:1')).status).toBe('no_folder');
    expect((await scanTitle(db, 'movie:9')).status).toBe('no_folder');
  });
});

describe('scan job and API', () => {
  it('runs from the job handler', async () => {
    write(join(movies, 'Film', 'a.mkv'));
    db.data.titles['movie:1'] = title('movie:1', 'movie', 'Film');
    const handler = libraryScanHandler({ db, events: createEvents() });
    await handler.run({ payload: { key: 'movie:1' } } as never, { signal: new AbortController().signal });
    expect(db.data.titles['movie:1']!.fileId).toBeTruthy();
  });

  it('queues a rescan, and refuses a title without a folder', async () => {
    const app = await startTestApp();
    try {
      app.db.data.titles['movie:1'] = title('movie:1', 'movie', 'Film');
      app.db.data.titles['movie:2'] = title('movie:2', 'movie', null);
      const queued = await app.post('/library/movie:1/rescan');
      expect(queued.status).toBe(202);
      expect(app.db.data.jobs[queued.body.jobId]).toMatchObject({ type: 'library.scan', payload: { key: 'movie:1' } });
      expect((await app.post('/library/movie:2/rescan')).body).toEqual({ error: 'no_folder' });
    } finally {
      app.close();
    }
  });
});
