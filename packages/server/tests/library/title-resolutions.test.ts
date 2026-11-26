import { describe, expect, it } from 'vitest';
import { detail } from '../../src/helpers/library.ts';
import { emptyData, set } from '../../src/core/db.ts';
import { episode, movie, NOW, title } from '../helpers/test-fixtures.ts';
import type { Db, MediaFile } from '../../src/types.ts';

const file = (id: string, extra: Partial<MediaFile> = {}): MediaFile => ({
  id,
  titleKey: 'movie:2',
  path: `Movie.Name.2019.${id}.mkv`,
  sizeBytes: 1,
  mtimeMs: 1,
  episodes: [],
  missing: false,
  addedAt: NOW,
  source: 'webdl',
  resolution: 1080,
  ...extra,
});

const dbWith = (...files: MediaFile[]) => {
  const data = emptyData();
  for (const item of files) data.files[item.id] = item;
  set({ data } as Db);
};

describe('the downloaded qualities of a title', () => {
  it('lists each source and resolution of a series once, with the highest resolution first', () => {
    dbWith(
      file('f0', { titleKey: 'tv:1', resolution: 1080, episodes: [{ season: 1, number: 1 }] }),
      file('f1', { titleKey: 'tv:1', resolution: 720, episodes: [{ season: 1, number: 2 }] }),
      file('f2', { titleKey: 'tv:1', resolution: 2160, episodes: [{ season: 1, number: 3 }] }),
      file('f3', { titleKey: 'tv:1', source: 'bluray', resolution: 1080, episodes: [{ season: 1, number: 4 }] }),
      file('f4', { titleKey: 'tv:1', resolution: 1080, episodes: [{ season: 1, number: 5 }] }),
    );
    const show = title({
      episodes: [
        episode(1, 1, '2020-01-01', { fileId: 'f0' }),
        episode(1, 2, '2020-01-01', { fileId: 'f1' }),
        episode(1, 3, '2020-01-01', { fileId: 'f2' }),
        episode(1, 4, '2020-01-01', { fileId: 'f3' }),
        episode(1, 5, '2020-01-01', { fileId: 'f4' }),
      ],
    });
    const qualities = detail(show).downloadedQualities;
    expect(qualities).toEqual(expect.arrayContaining([
      { resolution: 2160, label: 'WEB-DL 2160p' },
      { resolution: 1080, label: 'WEB-DL 1080p' },
      { resolution: 1080, label: 'BluRay 1080p' },
      { resolution: 720, label: 'WEB-DL 720p' },
    ]));
    expect(qualities.map(({ resolution }) => resolution)).toEqual([2160, 1080, 1080, 720]);
  });

  it('gives the source and resolution of a movie file', () => {
    dbWith(file('f0', { resolution: 2160 }));
    expect(detail(movie({ fileId: 'f0' })).downloadedQualities).toEqual([{ resolution: 2160, label: 'WEB-DL 2160p' }]);
  });

  it('lists the quality of a version that the title does not point to', () => {
    dbWith(file('f0', { resolution: 2160 }), file('f1', { resolution: 1080 }));
    expect(detail(movie({ fileId: 'f0' })).downloadedQualities).toEqual([
      { resolution: 2160, label: 'WEB-DL 2160p' },
      { resolution: 1080, label: 'WEB-DL 1080p' },
    ]);
  });

  it('skips a missing version that the title does not point to', () => {
    dbWith(file('f0', { resolution: 2160 }), file('f1', { resolution: 1080, missing: true }));
    expect(detail(movie({ fileId: 'f0' })).downloadedQualities).toEqual([{ resolution: 2160, label: 'WEB-DL 2160p' }]);
  });

  it('skips a missing file, and still shows the other versions', () => {
    dbWith(file('f0', { resolution: 2160, missing: true }), file('f1', { resolution: 1080 }));
    const qualities = [{ resolution: 1080, label: 'WEB-DL 1080p' }];
    expect(detail(movie({ fileId: 'f0' })).downloadedQualities).toEqual(qualities);
    expect(detail(movie({ fileId: 'f1' })).downloadedQualities).toEqual(qualities);
    expect(detail(movie({ fileId: 'nope' })).downloadedQualities).toEqual(qualities);
  });

  it('reads the source and resolution from the file name when the record has no source', () => {
    dbWith(file('f0', { path: 'Movie.Name.2019.720p.BluRay-GRP.mkv', source: null, resolution: null }));
    expect(detail(movie({ fileId: 'f0' })).downloadedQualities).toEqual([{ resolution: 720, label: 'BluRay 720p' }]);
  });

  it('lists only the resolution when the source is unknown', () => {
    dbWith(file('f0', { path: 'Movie.Name.2019.1080p.mkv', source: null, resolution: null }));
    expect(detail(movie({ fileId: 'f0' })).downloadedQualities).toEqual([{ resolution: 1080, label: '1080p' }]);
  });

  it('gives no quality for a title with no file, or only missing files or files with no resolution', () => {
    dbWith(
      file('f0', { resolution: null }),
      file('f1', { missing: true }),
    );
    expect(detail(movie({ fileId: 'f0' })).downloadedQualities).toEqual([]);
    expect(detail(movie({ fileId: 'f1' })).downloadedQualities).toEqual([]);
    dbWith();
    expect(detail(movie()).downloadedQualities).toEqual([]);
  });
});
