import { describe, expect, it } from 'vitest';
import { decide, type Context, type Want } from '../../src/acquisition/decide.ts';
import { emptyData, type Db, type MediaFile } from '../../src/core/db.ts';
import { episode, indexer, movie, NOW, release, title } from '../helpers/test-fixtures.ts';
import { manualUpgradeTargets, upgradeResolutions } from '../../src/acquisition/upgrades.ts';
import type { Profile } from '../../src/acquisition/quality.ts';

const MIB = 1024 * 1024;

const profile = (id: string, items: string[][]): Profile => ({ id, name: id, items });
const chain = (...resolutions: number[]): Profile[] => resolutions.map((resolution) => profile(`p${resolution}`, [[`webdl-${resolution}`]]));

// A database with the given chain and files. A file `f0` belongs to the title under test unless another ID is given.
const dbWith = (profiles: Profile[], files: Partial<MediaFile>[] = []) => {
  const data = emptyData();
  data.profiles = Object.fromEntries(profiles.map((item) => [item.id, item]));
  data.profileOrder = profiles.map((item) => item.id);
  files.forEach((file, i) => {
    data.files[`f${i}`] = { id: `f${i}`, titleKey: 'x', path: `Show/Season 01/Show - S01E0${i + 1}.mkv`, sizeBytes: 1, mtimeMs: 1, episodes: [{ season: 1, number: i + 1 }], missing: false, addedAt: 1, ...file };
  });
  return { data } as Db;
};

describe('the resolutions that an upgrade can reach', () => {
  it('lists the resolutions of the chain that are above a file, in ascending order', () => {
    const db = dbWith(chain(2160, 1080), [{ source: 'webdl', resolution: 720 }]);
    expect(upgradeResolutions(db, movie({ fileId: 'f0' }))).toEqual([1080, 2160]);
  });

  it('lists only the levels that the chain defines, and the nearest one alone', () => {
    const db = dbWith(chain(720), [{ source: 'webdl', resolution: 480 }]);
    expect(upgradeResolutions(db, movie({ fileId: 'f0' }))).toEqual([720]);
  });

  it('gives no resolution when the chain does not go above the file', () => {
    const db = dbWith(chain(1080), [{ source: 'webdl', resolution: 1080 }]);
    expect(upgradeResolutions(db, movie({ fileId: 'f0' }))).toEqual([]);
  });

  it('reads the resolution from the file name when the file has no source', () => {
    const db = dbWith(chain(1080, 2160), [{ path: 'Movie Name (2019) 720p BluRay.mkv' }]);
    expect(upgradeResolutions(db, movie({ fileId: 'f0' }))).toEqual([1080, 2160]);
  });

  it('skips a file with no known resolution, a missing file, and a file for several episodes', () => {
    const db = dbWith(chain(1080, 2160), [
      { source: 'webdl' },
      { source: 'webdl', resolution: 720, missing: true },
      { source: 'webdl', resolution: 720, episodes: [{ season: 1, number: 1 }, { season: 1, number: 2 }] },
    ]);
    expect(upgradeResolutions(db, movie({ fileId: 'f0' }))).toEqual([]);
    expect(upgradeResolutions(db, movie({ fileId: 'f1' }))).toEqual([]);
    expect(upgradeResolutions(db, movie({ fileId: 'f2' }))).toEqual([]);
    expect(upgradeResolutions(db, movie({ fileId: 'nope' }))).toEqual([]);
  });

  it('skips an unmonitored episode, and gives none for a paused title', () => {
    const db = dbWith(chain(1080, 2160), [{ source: 'webdl', resolution: 720 }]);
    const show = title({ episodes: [episode(1, 1, '2020-01-01', { fileId: 'f0', override: 'unmonitored' })] });
    expect(upgradeResolutions(db, show)).toEqual([]);
    expect(upgradeResolutions(db, { ...show, paused: true })).toEqual([]);
  });
});

describe('the files of a manual upgrade', () => {
  it('finds the files below the chosen resolution and gives their resolution', () => {
    const db = dbWith(chain(1080, 2160), [{ source: 'webdl', resolution: 720 }, { source: 'webdl', resolution: 1080 }]);
    const show = title({ episodes: [episode(1, 1, '2020-01-01', { fileId: 'f0' }), episode(1, 2, '2020-01-01', { fileId: 'f1' })] });
    const targets = manualUpgradeTargets(db, show, 1080);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ title: show, season: 1, number: 1, resolution: 720 });
    expect(targets[0]!.file.id).toBe('f0');
  });

  it('takes the movie file of a movie', () => {
    const db = dbWith(chain(1080, 2160), [{ source: 'webdl', resolution: 720 }]);
    const targets = manualUpgradeTargets(db, movie({ fileId: 'f0' }), 2160);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ season: null, number: null, resolution: 720 });
  });

  it('gives no target for a resolution that the chain cannot reach', () => {
    const db = dbWith(chain(1080, 2160), [{ source: 'webdl', resolution: 720 }]);
    expect(manualUpgradeTargets(db, movie({ fileId: 'f0' }), 720)).toEqual([]);
    expect(manualUpgradeTargets(db, movie({ fileId: 'f0' }), 1440)).toEqual([]);
    expect(manualUpgradeTargets(db, movie({ fileId: 'f0' }), 2160)).toHaveLength(1);
  });

  it('skips a file with no known resolution, a missing file, a file for several episodes, and a file with no record', () => {
    const db = dbWith(chain(1080, 2160), [
      { source: 'webdl' },
      { source: 'webdl', resolution: 720, missing: true },
      { source: 'webdl', resolution: 720, episodes: [{ season: 1, number: 1 }, { season: 1, number: 2 }] },
    ]);
    expect(manualUpgradeTargets(db, movie({ fileId: 'f0' }), 1080)).toEqual([]);
    expect(manualUpgradeTargets(db, movie({ fileId: 'f1' }), 1080)).toEqual([]);
    expect(manualUpgradeTargets(db, movie({ fileId: 'f2' }), 1080)).toEqual([]);
    expect(manualUpgradeTargets(db, movie({ fileId: 'nope' }), 1080)).toEqual([]);
  });

  it('reads the resolution from the file name when the file has no source', () => {
    const db = dbWith(chain(1080, 2160), [{ path: 'Movie Name (2019) 720p BluRay.mkv' }]);
    expect(manualUpgradeTargets(db, movie({ fileId: 'f0' }), 1080)).toMatchObject([{ season: null, number: null, resolution: 720 }]);
  });

  it('takes a monitored episode only, and none for a paused title', () => {
    const db = dbWith(chain(1080, 2160), [{ source: 'webdl', resolution: 720 }]);
    const show = title({ episodes: [episode(1, 1, '2020-01-01', { fileId: 'f0', override: 'unmonitored' })] });
    expect(manualUpgradeTargets(db, show, 1080)).toEqual([]);
    const monitored = title({ episodes: [episode(1, 1, '2020-01-01', { fileId: 'f0' })] });
    expect(manualUpgradeTargets(db, monitored, 1080)).toHaveLength(1);
    expect(manualUpgradeTargets(db, { ...monitored, paused: true }, 1080)).toEqual([]);
  });
});

describe('a release for a manual upgrade', () => {
  // The chain takes WEB-DL at 480p, 720p, 1080p, and 2160p.
  const data = () => {
    const quality = emptyData();
    quality.profiles = { p: profile('p', [['webdl-2160'], ['webdl-1080'], ['webdl-720'], ['webdl-480']]) };
    quality.profileOrder = ['p'];
    return quality;
  };
  const ctx = (quality = data()): Context => ({
    settings: quality.settings,
    quality,
    indexers: { 1: indexer() },
    blocked: () => false,
    downloading: () => false,
    hasFile: () => true,
    hasMovieFile: () => true,
    now: NOW,
  });
  const show = title({ episodes: [episode(1, 1, '2020-01-01', { fileId: 'f' })] });
  const wantAt = (upgradeResolution: number): Want => ({ kind: 'episode', title: show, season: 1, number: 1, upgradeResolution });
  const size = 60 * 45 * MIB;
  const codes = (name: string) => decide(release(name, { sizeBytes: size }), wantAt(1080), ctx()).rejections;

  it('takes a release at the chosen resolution', () => {
    expect(codes('Show.Name.S01E01.1080p.WEB-DL-GRP')).toEqual([]);
    expect(decide(release('Movie.Name.2019.1080p.WEB-DL-GRP'), { kind: 'movie', title: movie({ fileId: 'f' }), upgradeResolution: 1080 }, ctx()).rejections).toEqual([]);
  });

  it('refuses a higher resolution', () => {
    expect(codes('Show.Name.S01E01.2160p.WEB-DL-GRP')).toEqual(['not_an_upgrade']);
  });

  it('refuses a lower resolution, including the resolution of the file', () => {
    expect(codes('Show.Name.S01E01.720p.WEB-DL-GRP')).toEqual(['not_an_upgrade']);
    expect(codes('Show.Name.S01E01.480p.WEB-DL-GRP')).toEqual(['not_an_upgrade']);
  });

  it('refuses a release with no known resolution', () => {
    expect(codes('Show.Name.S01E01.WEB-DL-GRP')).toContain('not_an_upgrade');
  });

  it('keeps the quality check of the chain', () => {
    // The chain takes WEB-DL only, so a WEBRip is out even at the chosen resolution.
    expect(codes('Show.Name.S01E01.1080p.WEBRip-GRP')).toEqual(['quality_not_in_profile']);
  });

  it('refuses a release for several episodes, because the file of the target holds one episode', () => {
    const both = title({ episodes: [episode(1, 1, '2020-01-01', { fileId: 'f' }), episode(1, 2)] });
    const d = decide(release('Show.Name.S01E01E02.1080p.WEB-DL-GRP', { sizeBytes: 2 * size }), { kind: 'episode', title: both, season: 1, number: 1, upgradeResolution: 1080 }, { ...ctx(), hasFile: (item) => Boolean(item.fileId) });
    expect(d.rejections).toEqual(['upgrade_needs_single']);
  });

  it('keeps the other checks: identity and blocklist', () => {
    expect(codes('Other.Show.S01E01.1080p.WEB-DL-GRP')).toEqual(['wrong_title']);
    expect(decide(release('Show.Name.S01E01.1080p.WEB-DL-GRP', { sizeBytes: size }), wantAt(1080), { ...ctx(), blocked: () => true }).rejections).toEqual(['blocklisted']);
  });
});
