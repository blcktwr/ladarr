import { beforeEach, describe, expect, it } from 'vitest';
import { open, type Db, type MediaFile } from '../../src/core/db.ts';
import { PlanError } from '../../src/library/imports/plan.ts';
import { seriesCounts, type Episode, type Title } from '../../src/library/library.ts';
import { applyCorrection, correctionOf, type EpisodeRef } from '../../src/library/mapping.ts';

let db: Db;

const clock = () => ({ now: Date.now(), files: db.data.files });
const ref = (season: number, number: number): EpisodeRef => ({ season, number });

const episode = (season: number, number: number): Episode => ({ tmdbId: season * 100 + number, season, number, name: `E${number}`, airDate: '2000-01-01', runtime: 45, override: null, fileId: null });

function title(key: string, mediaType: 'movie' | 'tv', episodes: Episode[] = []): Title {
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
    folder: mediaType === 'movie' ? 'Film' : 'Show',
    manualRelease: false,
    seasonOverrides: {},
    episodesLoadedAt: 1,
    episodes,
    fileId: null,
  };
}

function file(id: string, titleKey: string, path: string, episodes: EpisodeRef[] = [], missing = false): MediaFile {
  return { id, titleKey, path, sizeBytes: 10, mtimeMs: 1, episodes, missing, addedAt: 1 };
}

const errorOf = (run: () => void) => {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('no error');
};

const failureOf = (key: string) => errorOf(() => correctionOf(key, []));

beforeEach(async () => {
  db = await open('unused.json');
});

describe('correction rows', () => {
  it('gives a file a second episode and reports the new pointer', () => {
    db.data.titles['tv:1'] = title('tv:1', 'tv', [episode(1, 1), episode(1, 2)]);
    db.data.files.a = file('a', 'tv:1', 'Show/a.mkv', [ref(1, 1)]);
    db.data.titles['tv:1']!.episodes[0]!.fileId = 'a';

    const correction = correctionOf('tv:1', [{ path: 'Show/a.mkv', episodes: [ref(1, 1), ref(1, 2)] }]);

    expect(correction.titleKey).toBe('tv:1');
    expect(correction.rows).toEqual([{ fileId: 'a', path: 'Show/a.mkv', from: [ref(1, 1)], to: [ref(1, 1), ref(1, 2)], status: 'change', reason: null }]);
    expect(correction.pointers).toEqual([{ season: 1, number: 2, from: null, to: 'Show/a.mkv' }]);
  });

  it('sorts the episodes of a row', () => {
    db.data.titles['tv:1'] = title('tv:1', 'tv', [episode(1, 1), episode(1, 2), episode(1, 3)]);
    db.data.files.a = file('a', 'tv:1', 'Show/a.mkv', [ref(1, 2), ref(1, 1)]);

    const [row] = correctionOf('tv:1', [{ path: 'Show/a.mkv', episodes: [ref(1, 3), ref(1, 1), ref(1, 2)] }]).rows;

    expect(row).toMatchObject({ from: [ref(1, 1), ref(1, 2)], to: [ref(1, 1), ref(1, 2), ref(1, 3)] });

    // An episode twice in one entry is a mistake of the client, not something to repair.
    const duplicate = correctionOf('tv:1', [{ path: 'Show/a.mkv', episodes: [ref(1, 1), ref(1, 3), ref(1, 1)] }]);
    expect(duplicate.rows).toHaveLength(1);
    expect(duplicate.rows[0]).toMatchObject({ status: 'blocked', reason: 'duplicate' });
    expect(errorOf(() => applyCorrection(duplicate))).toMatchObject({ code: 'mapping_blocked' });
  });

  it('keeps the coverage of a file with no entry', () => {
    db.data.titles['tv:1'] = title('tv:1', 'tv', [episode(1, 1), episode(1, 2)]);
    db.data.files.a = file('a', 'tv:1', 'Show/a.mkv', [ref(1, 1)]);
    db.data.files.b = file('b', 'tv:1', 'Show/b.mkv', [ref(1, 2)]);
    db.data.titles['tv:1']!.episodes[0]!.fileId = 'a';
    db.data.titles['tv:1']!.episodes[1]!.fileId = 'b';

    const correction = correctionOf('tv:1', [{ path: 'Show/a.mkv', episodes: [ref(1, 1)] }]);

    expect(correction.rows).toEqual([
      { fileId: 'a', path: 'Show/a.mkv', from: [ref(1, 1)], to: [ref(1, 1)], status: 'same', reason: null },
      { fileId: 'b', path: 'Show/b.mkv', from: [ref(1, 2)], to: [ref(1, 2)], status: 'same', reason: null },
    ]);
    expect(correction.pointers).toEqual([]);
  });

  it('never shows a file record of another title', () => {
    db.data.titles['tv:1'] = title('tv:1', 'tv', [episode(1, 1)]);
    db.data.titles['tv:2'] = title('tv:2', 'tv', [episode(1, 1)]);
    db.data.files.a = file('a', 'tv:1', 'Show/a.mkv', [ref(1, 1)]);
    db.data.files.other = file('other', 'tv:2', 'Other/x.mkv', [ref(1, 1)]);

    const correction = correctionOf('tv:1', []);

    expect(correction.rows.map((row) => row.path)).toEqual(['Show/a.mkv']);
    expect(correction.rows.every((row) => row.fileId !== 'other')).toBe(true);
  });

  it('gives one same row per file and no pointer change when the entries are empty', () => {
    db.data.titles['tv:1'] = title('tv:1', 'tv', [episode(1, 1), episode(1, 2)]);
    db.data.files.a = file('a', 'tv:1', 'Show/a.mkv', [ref(1, 1)]);
    db.data.files.b = file('b', 'tv:1', 'Show/b.mkv', [ref(1, 2)]);
    db.data.titles['tv:1']!.episodes[0]!.fileId = 'a';
    db.data.titles['tv:1']!.episodes[1]!.fileId = 'b';

    const correction = correctionOf('tv:1', []);

    expect(correction.rows.map((row) => [row.path, row.status, row.reason, row.from, row.to])).toEqual([
      ['Show/a.mkv', 'same', null, [ref(1, 1)], [ref(1, 1)]],
      ['Show/b.mkv', 'same', null, [ref(1, 2)], [ref(1, 2)]],
    ]);
    expect(correction.pointers).toEqual([]);
  });
});

describe('pointers', () => {
  it('clears the pointer of an episode that the file no longer covers', () => {
    db.data.titles['tv:1'] = title('tv:1', 'tv', [episode(1, 1), episode(1, 2)]);
    db.data.files.a = file('a', 'tv:1', 'Show/a.mkv', [ref(1, 1), ref(1, 2)]);
    db.data.titles['tv:1']!.episodes[0]!.fileId = 'a';
    db.data.titles['tv:1']!.episodes[1]!.fileId = 'a';

    const correction = correctionOf('tv:1', [{ path: 'Show/a.mkv', episodes: [ref(1, 1)] }]);

    expect(correction.rows[0]).toMatchObject({ status: 'change', reason: null, from: [ref(1, 1), ref(1, 2)], to: [ref(1, 1)] });
    expect(correction.pointers).toEqual([{ season: 1, number: 2, from: 'Show/a.mkv', to: null }]);
  });

  it('moves an episode to the file that covers it', () => {
    db.data.titles['tv:1'] = title('tv:1', 'tv', [episode(1, 1), episode(1, 2)]);
    db.data.files.a = file('a', 'tv:1', 'Show/a.mkv', [ref(1, 1), ref(1, 2)]);
    db.data.files.b = file('b', 'tv:1', 'Show/b.mkv', []);
    db.data.titles['tv:1']!.episodes[1]!.fileId = 'a';

    const correction = correctionOf('tv:1', [
      { path: 'Show/a.mkv', episodes: [] },
      { path: 'Show/b.mkv', episodes: [ref(1, 2)] },
    ]);

    expect(correction.rows[0]).toMatchObject({ fileId: 'a', status: 'review', reason: 'episode_unknown', from: [ref(1, 1), ref(1, 2)], to: [] });
    expect(correction.rows[1]).toMatchObject({ fileId: 'b', status: 'change', reason: null, from: [], to: [ref(1, 2)] });
    expect(correction.pointers).toContainEqual({ season: 1, number: 2, from: 'Show/a.mkv', to: 'Show/b.mkv' });

    applyCorrection(correction);
    expect(db.data.files.a!.episodes).toEqual([]);
    expect(db.data.files.b!.episodes).toEqual([ref(1, 2)]);
    expect(db.data.titles['tv:1']!.episodes[1]!.fileId).toBe('b');
  });
});

describe('review rows', () => {
  it('keeps the coverage of a missing file', () => {
    db.data.titles['tv:1'] = title('tv:1', 'tv', [episode(1, 1), episode(1, 2)]);
    db.data.files.a = file('a', 'tv:1', 'Show/a.mkv', [ref(1, 1)], true);
    db.data.titles['tv:1']!.episodes[0]!.fileId = 'a';

    const correction = correctionOf('tv:1', [{ path: 'Show/a.mkv', episodes: [ref(1, 2)] }]);

    // A file that is gone keeps its coverage until a person removes it.
    expect(correction.rows[0]).toMatchObject({ fileId: 'a', status: 'review', reason: 'file_missing', from: [ref(1, 1)], to: [ref(1, 1)] });

    applyCorrection(correction);
    expect(db.data.files.a!.episodes).toEqual([ref(1, 1)]);
    expect(db.data.titles['tv:1']!.episodes[0]!.fileId).toBe('a');
  });
});

describe('blocked rows', () => {
  it('blocks a path that is not a file of the title', () => {
    db.data.titles['tv:1'] = title('tv:1', 'tv', [episode(1, 1)]);
    db.data.files.a = file('a', 'tv:1', 'Show/a.mkv', [ref(1, 1)]);

    const rows = correctionOf('tv:1', [{ path: 'Show/x.mkv', episodes: [ref(1, 1)] }]).rows;

    expect(rows.find((row) => row.path === 'Show/x.mkv')).toMatchObject({ status: 'blocked', reason: 'path_unknown' });
    expect(rows.find((row) => row.path === 'Show/a.mkv')).toMatchObject({ status: 'same' });
  });

  it('blocks episodes of more than one season', () => {
    db.data.titles['tv:1'] = title('tv:1', 'tv', [episode(1, 1), episode(2, 1)]);
    db.data.files.a = file('a', 'tv:1', 'Show/a.mkv', []);

    const rows = correctionOf('tv:1', [{ path: 'Show/a.mkv', episodes: [ref(2, 1), ref(1, 1)] }]).rows;

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'blocked', reason: 'mixed_season' });
  });

  it('blocks an episode that the title does not have', () => {
    db.data.titles['tv:1'] = title('tv:1', 'tv', [episode(1, 1), episode(1, 2)]);
    db.data.files.a = file('a', 'tv:1', 'Show/a.mkv', []);

    const rows = correctionOf('tv:1', [{ path: 'Show/a.mkv', episodes: [ref(1, 9)] }]).rows;

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'blocked', reason: 'episode_missing' });
  });

  it('blocks both entries that give the same episode', () => {
    db.data.titles['tv:1'] = title('tv:1', 'tv', [episode(1, 1), episode(1, 2)]);
    db.data.files.a = file('a', 'tv:1', 'Show/a.mkv', []);
    db.data.files.b = file('b', 'tv:1', 'Show/b.mkv', []);

    const rows = correctionOf('tv:1', [
      { path: 'Show/a.mkv', episodes: [ref(1, 1)] },
      { path: 'Show/b.mkv', episodes: [ref(1, 1), ref(1, 2)] },
    ]).rows;

    expect(rows.map((row) => [row.path, row.status, row.reason])).toEqual([
      ['Show/a.mkv', 'blocked', 'shared_episode'],
      ['Show/b.mkv', 'blocked', 'shared_episode'],
    ]);
  });
});

describe('apply', () => {
  it('writes the coverage of each file and the file of each episode', () => {
    db.data.titles['tv:1'] = title('tv:1', 'tv', [episode(1, 1), episode(1, 2), episode(1, 3)]);
    db.data.files.a = file('a', 'tv:1', 'Show/a.mkv', []);
    db.data.files.b = file('b', 'tv:1', 'Show/b.mkv', []);
    expect(seriesCounts(db.data.titles['tv:1']!, clock()).available).toBe(0);

    const correction = correctionOf('tv:1', [
      { path: 'Show/a.mkv', episodes: [ref(1, 1), ref(1, 2)] },
      { path: 'Show/b.mkv', episodes: [ref(1, 3)] },
    ]);
    applyCorrection(correction);

    expect(db.data.files.a!.episodes).toEqual([ref(1, 1), ref(1, 2)]);
    expect(db.data.files.b!.episodes).toEqual([ref(1, 3)]);
    expect(db.data.titles['tv:1']!.episodes.map((one) => one.fileId)).toEqual(['a', 'a', 'b']);
    expect(seriesCounts(db.data.titles['tv:1']!, clock()).available).toBe(3);
  });

  it('changes nothing on a second apply of the same correction', () => {
    db.data.titles['tv:1'] = title('tv:1', 'tv', [episode(1, 1), episode(1, 2)]);
    db.data.files.a = file('a', 'tv:1', 'Show/a.mkv', [ref(1, 1)]);
    db.data.files.b = file('b', 'tv:1', 'Show/b.mkv', []);
    db.data.titles['tv:1']!.episodes[0]!.fileId = 'a';

    const correction = correctionOf('tv:1', [
      { path: 'Show/a.mkv', episodes: [ref(1, 2)] },
      { path: 'Show/b.mkv', episodes: [] },
    ]);
    applyCorrection(correction);
    const before = structuredClone({ files: db.data.files, pointers: db.data.titles['tv:1']!.episodes.map((one) => one.fileId) });

    applyCorrection(correction);

    expect({ files: db.data.files, pointers: db.data.titles['tv:1']!.episodes.map((one) => one.fileId) }).toEqual(before);
  });
});

describe('errors', () => {
  it('refuses an unknown title key and a movie', () => {
    expect(failureOf('tv:9')).toBeInstanceOf(PlanError);
    expect(failureOf('tv:9')).toMatchObject({ code: 'title_not_found' });

    db.data.titles['movie:1'] = title('movie:1', 'movie');

    expect(failureOf('movie:1')).toBeInstanceOf(PlanError);
    expect(failureOf('movie:1')).toMatchObject({ code: 'not_a_series' });
  });
});
