import { describe, expect, it } from 'vitest';
import { detail } from '../../src/helpers/library.ts';
import { emptyData, set, type Db, type MediaFile } from '../../src/core/db.ts';
import { episode, movie, NOW, title } from '../helpers/test-fixtures.ts';

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

describe('the resolutions of a title', () => {
  it('lists the resolutions of the files of a series, the highest first, without duplicates', () => {
    dbWith(
      file('f0', { titleKey: 'tv:1', resolution: 1080, episodes: [{ season: 1, number: 1 }] }),
      file('f1', { titleKey: 'tv:1', resolution: 720, episodes: [{ season: 1, number: 2 }] }),
      file('f2', { titleKey: 'tv:1', resolution: 2160, episodes: [{ season: 1, number: 3 }] }),
    );
    const show = title({
      episodes: [
        episode(1, 1, '2020-01-01', { fileId: 'f0' }),
        episode(1, 2, '2020-01-01', { fileId: 'f1' }),
        episode(1, 3, '2020-01-01', { fileId: 'f2' }),
        episode(1, 4, '2020-01-01', { fileId: 'f0' }),
      ],
    });
    expect(detail(show).resolutions).toEqual([2160, 1080, 720]);
  });

  it('gives the resolution of the file of a movie', () => {
    dbWith(file('f0', { resolution: 2160 }));
    expect(detail(movie({ fileId: 'f0' })).resolutions).toEqual([2160]);
  });

  it('lists the resolution of a version that the title does not point to', () => {
    dbWith(file('f0', { resolution: 2160 }), file('f1', { resolution: 1080 }));
    expect(detail(movie({ fileId: 'f0' })).resolutions).toEqual([2160, 1080]);
  });

  it('skips a missing version that the title does not point to', () => {
    dbWith(file('f0', { resolution: 2160 }), file('f1', { resolution: 1080, missing: true }));
    expect(detail(movie({ fileId: 'f0' })).resolutions).toEqual([2160]);
  });

  it('skips a missing file, and still shows the other versions', () => {
    dbWith(file('f0', { resolution: 2160, missing: true }), file('f1', { resolution: 1080 }));
    expect(detail(movie({ fileId: 'f0' })).resolutions).toEqual([1080]);
    expect(detail(movie({ fileId: 'f1' })).resolutions).toEqual([1080]);
    expect(detail(movie({ fileId: 'nope' })).resolutions).toEqual([1080]);
  });

  it('reads the resolution from the file name when the file has no source', () => {
    dbWith(file('f0', { path: 'Movie.Name.2019.720p.BluRay-GRP.mkv', source: null, resolution: null }));
    expect(detail(movie({ fileId: 'f0' })).resolutions).toEqual([720]);
  });

  it('gives no resolution for a title with no file, or a file with no known resolution', () => {
    dbWith(file('f0', { source: 'webdl', resolution: null }));
    expect(detail(movie({ fileId: 'f0' })).resolutions).toEqual([]);
    expect(detail(movie()).resolutions).toEqual([]);
  });
});
