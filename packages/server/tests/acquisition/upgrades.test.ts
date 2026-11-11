import { describe, expect, it } from 'vitest';
import { decide, type Context, type Want } from '../../src/library/grab/decide.ts';
import { emptyData, set, type Db, type MediaFile } from '../../src/core/db.ts';
import { episode, indexer, movie, NOW, release, title } from '../helpers/test-fixtures.ts';
import { manualUpgradeTargets, upgradeQualities } from '../../src/library/grab/upgrades.ts';
import type { Profile } from '../../src/library/grab/quality.ts';

const MIB = 1024 * 1024;

const profile = (id: string, items: string[][]): Profile => ({ id, name: id, items });
const chain = (...resolutions: number[]): Profile[] => resolutions.map((resolution) => profile(`p${resolution}`, [[`webdl-${resolution}`]]));
// A chain with explicit groups, the best first. Each argument is one profile of the chain.
const grouped = (...profiles: string[][][]): Profile[] => profiles.map((items, index) => profile(`p${index}`, items));
// The profiles of the default data, in the order of the chain.
const defaultChain = (): Profile[] => {
  const data = emptyData();
  return data.profileOrder.map((id) => data.profiles[id]!);
};

// A database with the given chain and files. A file `f0` belongs to the title under test unless another ID is given.
const dbWith = (profiles: Profile[], files: Partial<MediaFile>[] = []) => {
  const data = emptyData();
  data.profiles = Object.fromEntries(profiles.map((item) => [item.id, item]));
  data.profileOrder = profiles.map((item) => item.id);
  files.forEach((file, i) => {
    data.files[`f${i}`] = { id: `f${i}`, titleKey: 'x', path: `Show/Season 01/Show - S01E0${i + 1}.mkv`, sizeBytes: 1, mtimeMs: 1, episodes: [{ season: 1, number: i + 1 }], missing: false, addedAt: 1, ...file };
  });
  const db = { data } as Db;
  set(db);
  return db;
};

describe('the qualities that an upgrade can reach', () => {
  it('lists the qualities of the chain that are above a file, best first', () => {
    const db = dbWith(chain(2160, 1080), [{ source: 'webdl', resolution: 720 }]);
    expect(upgradeQualities(movie({ fileId: 'f0' }))).toEqual([
      { id: 'webdl-2160', label: 'WEB-DL 2160p' },
      { id: 'webdl-1080', label: 'WEB-DL 1080p' },
    ]);
  });

  it('lists a quality once, in the order of its group', () => {
    const db = dbWith(grouped([['webdl-1080', 'webrip-1080'], ['webdl-1080'], ['bluray-1080']]), [{ source: 'bluray', resolution: 1080 }]);
    expect(upgradeQualities(movie({ fileId: 'f0' }))).toEqual([
      { id: 'webdl-1080', label: 'WEB-DL 1080p' },
      { id: 'webrip-1080', label: 'WEBRip 1080p' },
    ]);
  });

  it('lists only the qualities that the chain defines, and the nearest one alone', () => {
    const db = dbWith(chain(720), [{ source: 'webdl', resolution: 480 }]);
    expect(upgradeQualities(movie({ fileId: 'f0' }))).toEqual([{ id: 'webdl-720', label: 'WEB-DL 720p' }]);
  });

  it('takes a better source at the same resolution', () => {
    const db = dbWith(grouped([['webdl-1080'], ['webrip-1080'], ['bluray-1080']]), [{ source: 'webrip', resolution: 1080 }]);
    expect(upgradeQualities(movie({ fileId: 'f0' }))).toEqual([{ id: 'webdl-1080', label: 'WEB-DL 1080p' }]);
  });

  it('gives no quality when the file already has the best quality of the chain', () => {
    const db = dbWith(chain(1080), [{ source: 'webdl', resolution: 1080 }]);
    expect(upgradeQualities(movie({ fileId: 'f0' }))).toEqual([]);
  });

  it('takes every quality of the chain when the quality of the file is not in it', () => {
    const db = dbWith(chain(1080, 2160), [{ source: 'webdl', resolution: 720 }]);
    expect(upgradeQualities(movie({ fileId: 'f0' }))).toEqual([
      { id: 'webdl-1080', label: 'WEB-DL 1080p' },
      { id: 'webdl-2160', label: 'WEB-DL 2160p' },
    ]);
  });

  it('lists the default chain in its order above a 720p file', () => {
    const db = dbWith(defaultChain(), [{ source: 'webdl', resolution: 720 }]);
    expect(upgradeQualities(movie({ fileId: 'f0' }))).toEqual([
      { id: 'webdl-1080', label: 'WEB-DL 1080p' },
      { id: 'webrip-1080', label: 'WEBRip 1080p' },
      { id: 'bluray-1080', label: 'BluRay 1080p' },
      { id: 'webdl-2160', label: 'WEB-DL 2160p' },
      { id: 'webrip-2160', label: 'WEBRip 2160p' },
      { id: 'bluray-2160', label: 'BluRay 2160p' },
    ]);
  });

  it('lists the 2160p qualities above a 1080p WEB-DL file of the default chain', () => {
    const db = dbWith(defaultChain(), [{ source: 'webdl', resolution: 1080 }]);
    expect(upgradeQualities(movie({ fileId: 'f0' }))).toEqual([
      { id: 'webdl-2160', label: 'WEB-DL 2160p' },
      { id: 'webrip-2160', label: 'WEBRip 2160p' },
      { id: 'bluray-2160', label: 'BluRay 2160p' },
    ]);
  });

  it('gives no quality above a 2160p WEB-DL file of the default chain', () => {
    const db = dbWith(defaultChain(), [{ source: 'webdl', resolution: 2160 }]);
    expect(upgradeQualities(movie({ fileId: 'f0' }))).toEqual([]);
  });

  it('reads the quality from the file name when the file has no source', () => {
    const db = dbWith(defaultChain(), [{ path: 'Movie Name (2019) 720p BluRay.mkv' }]);
    // A BluRay 720p is not in the default chain, so it is worse than every quality of the chain.
    expect(upgradeQualities(movie({ fileId: 'f0' }))).toEqual([
      { id: 'webdl-1080', label: 'WEB-DL 1080p' },
      { id: 'webrip-1080', label: 'WEBRip 1080p' },
      { id: 'bluray-1080', label: 'BluRay 1080p' },
      { id: 'webdl-2160', label: 'WEB-DL 2160p' },
      { id: 'webrip-2160', label: 'WEBRip 2160p' },
      { id: 'bluray-2160', label: 'BluRay 2160p' },
    ]);
  });

  it('skips a file with no known source or resolution, a missing file, and a file for several episodes', () => {
    const db = dbWith(chain(1080, 2160), [
      { source: 'webdl' },
      { source: 'unknown', resolution: 720 },
      { source: 'webdl', resolution: 720, missing: true },
      { source: 'webdl', resolution: 720, episodes: [{ season: 1, number: 1 }, { season: 1, number: 2 }] },
    ]);
    expect(upgradeQualities(movie({ fileId: 'f0' }))).toEqual([]);
    expect(upgradeQualities(movie({ fileId: 'f1' }))).toEqual([]);
    expect(upgradeQualities(movie({ fileId: 'f2' }))).toEqual([]);
    expect(upgradeQualities(movie({ fileId: 'f3' }))).toEqual([]);
    expect(upgradeQualities(movie({ fileId: 'nope' }))).toEqual([]);
  });

  it('skips an unmonitored episode, and gives none for a paused title', () => {
    const db = dbWith(chain(1080, 2160), [{ source: 'webdl', resolution: 720 }]);
    const show = title({ episodes: [episode(1, 1, '2020-01-01', { fileId: 'f0', override: 'unmonitored' })] });
    expect(upgradeQualities(show)).toEqual([]);
    expect(upgradeQualities({ ...show, paused: true })).toEqual([]);
  });
});

describe('the files of a manual upgrade', () => {
  it('finds the files below the chosen quality and gives their resolution', () => {
    const db = dbWith(chain(1080, 2160), [{ source: 'webdl', resolution: 720 }, { source: 'webdl', resolution: 1080 }]);
    const show = title({ episodes: [episode(1, 1, '2020-01-01', { fileId: 'f0' }), episode(1, 2, '2020-01-01', { fileId: 'f1' })] });
    const targets = manualUpgradeTargets(show, 'webdl-1080');
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ title: show, season: 1, number: 1, resolution: 720 });
    expect(targets[0]!.file.id).toBe('f0');
  });

  it('takes a better source at the same resolution', () => {
    const db = dbWith(grouped([['webdl-1080'], ['webrip-1080'], ['bluray-1080']]), [{ source: 'webrip', resolution: 1080 }]);
    expect(manualUpgradeTargets(movie({ fileId: 'f0' }), 'webdl-1080')).toMatchObject([{ season: null, number: null, resolution: 1080 }]);
  });

  it('takes the movie file of a movie', () => {
    const db = dbWith(chain(1080, 2160), [{ source: 'webdl', resolution: 720 }]);
    const targets = manualUpgradeTargets(movie({ fileId: 'f0' }), 'webdl-2160');
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ season: null, number: null, resolution: 720 });
  });

  it('gives no target for a quality that the chain cannot reach', () => {
    const db = dbWith(chain(1080, 2160), [{ source: 'webdl', resolution: 720 }]);
    expect(manualUpgradeTargets(movie({ fileId: 'f0' }), 'webdl-720')).toEqual([]);
    expect(manualUpgradeTargets(movie({ fileId: 'f0' }), 'remux-1080')).toEqual([]);
    expect(manualUpgradeTargets(movie({ fileId: 'f0' }), 'webdl-2160')).toHaveLength(1);
  });

  it('skips a file with no known source or resolution, a missing file, a file for several episodes, and a file with no record', () => {
    const db = dbWith(chain(1080, 2160), [
      { source: 'webdl' },
      { source: 'unknown', resolution: 720 },
      { source: 'webdl', resolution: 720, missing: true },
      { source: 'webdl', resolution: 720, episodes: [{ season: 1, number: 1 }, { season: 1, number: 2 }] },
    ]);
    expect(manualUpgradeTargets(movie({ fileId: 'f0' }), 'webdl-1080')).toEqual([]);
    expect(manualUpgradeTargets(movie({ fileId: 'f1' }), 'webdl-1080')).toEqual([]);
    expect(manualUpgradeTargets(movie({ fileId: 'f2' }), 'webdl-1080')).toEqual([]);
    expect(manualUpgradeTargets(movie({ fileId: 'f3' }), 'webdl-1080')).toEqual([]);
    expect(manualUpgradeTargets(movie({ fileId: 'nope' }), 'webdl-1080')).toEqual([]);
  });

  it('reads the quality from the file name when the file has no source', () => {
    const db = dbWith(chain(1080, 2160), [{ path: 'Movie Name (2019) 720p BluRay.mkv' }]);
    expect(manualUpgradeTargets(movie({ fileId: 'f0' }), 'webdl-1080')).toMatchObject([{ season: null, number: null, resolution: 720 }]);
  });

  it('takes a monitored episode only, and none for a paused title', () => {
    const db = dbWith(chain(1080, 2160), [{ source: 'webdl', resolution: 720 }]);
    const show = title({ episodes: [episode(1, 1, '2020-01-01', { fileId: 'f0', override: 'unmonitored' })] });
    expect(manualUpgradeTargets(show, 'webdl-1080')).toEqual([]);
    const monitored = title({ episodes: [episode(1, 1, '2020-01-01', { fileId: 'f0' })] });
    expect(manualUpgradeTargets(monitored, 'webdl-1080')).toHaveLength(1);
    expect(manualUpgradeTargets({ ...monitored, paused: true }, 'webdl-1080')).toEqual([]);
  });
});

describe('a release for a manual upgrade', () => {
  // The chain takes WEB-DL at 480p, 720p, 1080p, and 2160p, and WEBRip at 1080p.
  const data = () => {
    const quality = emptyData();
    quality.profiles = { p: profile('p', [['webdl-2160'], ['webdl-1080'], ['webrip-1080'], ['webdl-720'], ['webdl-480']]) };
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
  const wantAt = (upgradeQuality: string): Want => ({ kind: 'episode', title: show, season: 1, number: 1, upgradeQuality });
  const size = 60 * 45 * MIB;
  const codes = (name: string) => decide(release(name, { sizeBytes: size }), wantAt('webdl-1080'), ctx()).rejections;

  it('takes a release of the chosen quality', () => {
    expect(codes('Show.Name.S01E01.1080p.WEB-DL-GRP')).toEqual([]);
    expect(decide(release('Movie.Name.2019.1080p.WEB-DL-GRP'), { kind: 'movie', title: movie({ fileId: 'f' }), upgradeQuality: 'webdl-1080' }, ctx()).rejections).toEqual([]);
  });

  it('refuses another quality at the chosen resolution', () => {
    expect(codes('Show.Name.S01E01.1080p.WEBRip-GRP')).toEqual(['not_an_upgrade']);
  });

  it('refuses a better or a lower quality', () => {
    expect(codes('Show.Name.S01E01.2160p.WEB-DL-GRP')).toEqual(['not_an_upgrade']);
    expect(codes('Show.Name.S01E01.720p.WEB-DL-GRP')).toEqual(['not_an_upgrade']);
    expect(codes('Show.Name.S01E01.480p.WEB-DL-GRP')).toEqual(['not_an_upgrade']);
  });

  it('refuses a release with no known resolution', () => {
    expect(codes('Show.Name.S01E01.WEB-DL-GRP')).toContain('not_an_upgrade');
  });

  it('keeps the quality check of the chain', () => {
    // The chain takes no HDTV, so an HDTV release is out even at the chosen resolution.
    expect(codes('Show.Name.S01E01.1080p.HDTV-GRP')).toContain('quality_not_in_profile');
  });

  it('refuses a release for several episodes, because the file of the target holds one episode', () => {
    const both = title({ episodes: [episode(1, 1, '2020-01-01', { fileId: 'f' }), episode(1, 2)] });
    const d = decide(release('Show.Name.S01E01E02.1080p.WEB-DL-GRP', { sizeBytes: 2 * size }), { kind: 'episode', title: both, season: 1, number: 1, upgradeQuality: 'webdl-1080' }, { ...ctx(), hasFile: (item) => Boolean(item.fileId) });
    expect(d.rejections).toEqual(['upgrade_needs_single']);
  });

  it('keeps the other checks: identity and blocklist', () => {
    expect(codes('Other.Show.S01E01.1080p.WEB-DL-GRP')).toEqual(['wrong_title']);
    expect(decide(release('Show.Name.S01E01.1080p.WEB-DL-GRP', { sizeBytes: size }), wantAt('webdl-1080'), { ...ctx(), blocked: () => true }).rejections).toEqual(['blocklisted']);
  });
});
