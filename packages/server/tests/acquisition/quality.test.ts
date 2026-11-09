import { describe, expect, it } from 'vitest';
import { chainFileRank, defaultProfiles, defaultSizes, evaluate, evaluateChain, fileRank, qualityOf, RANK_STRIDE, QUALITY_TABLE_VERSION, QUALITIES, type Profile, type Rejection, type Release } from '../../src/library/grab/quality.ts';

const GIB = 1024 ** 3;
// The sample runtimes in docs/quality-presets.md.
const MOVIE = 120;
const EPISODE = 45;
const PACK = 10 * EPISODE;

const release = (source: Release['source'], resolution: number | null, gib: number, audioLanguages: string[] | null = ['en']): Release => ({
  source,
  resolution,
  sizeBytes: gib * GIB,
  audioLanguages,
});

const profiles = defaultProfiles();
const sizes = defaultSizes();
type Sample = { name: string; preset: keyof typeof profiles; release: Release; runtime: number | null; expected: Rejection[] };

// Each sample is a release that people see. The table must give the same answer for it in every version 1 build.
const samples: Sample[] = [
  { name: 'movie WEB-DL 1080p, 7 GiB', preset: 'p1080', release: release('webdl', 1080, 7), runtime: MOVIE, expected: [] },
  { name: 'movie WEB-DL 1080p, 1 GiB is a low-bitrate copy', preset: 'p1080', release: release('webdl', 1080, 1), runtime: MOVIE, expected: ['size_below_min'] },
  { name: 'movie WEB-DL 1080p, 40 GiB is too large', preset: 'p1080', release: release('webdl', 1080, 40), runtime: MOVIE, expected: ['size_above_max'] },
  { name: 'movie BluRay 1080p remux, 30 GiB', preset: 'p1080', release: release('bluray', 1080, 30), runtime: MOVIE, expected: [] },
  { name: 'movie BluRay 1080p, 4 GiB is a small encode', preset: 'p1080', release: release('bluray', 1080, 4), runtime: MOVIE, expected: ['size_below_min'] },
  { name: 'movie CAM', preset: 'p1080', release: release('cam', 1080, 3), runtime: MOVIE, expected: ['quality_rejected'] },
  { name: 'movie telesync', preset: 'p1080', release: release('telesync', 1080, 3), runtime: MOVIE, expected: ['quality_rejected'] },
  { name: 'release with an unknown quality', preset: 'p1080', release: release('unknown', null, 3), runtime: MOVIE, expected: ['quality_rejected'] },
  { name: 'episode WEB-DL 2160p, 6.5 GiB', preset: 'p2160', release: release('webdl', 2160, 6.5), runtime: EPISODE, expected: [] },
  { name: 'episode WEB-DL 2160p in the 1080p preset', preset: 'p1080', release: release('webdl', 2160, 6.5), runtime: EPISODE, expected: ['quality_not_in_profile'] },
  { name: 'episode HDTV 1080p', preset: 'p1080', release: release('hdtv', 1080, 2), runtime: EPISODE, expected: ['quality_not_in_profile'] },
  { name: 'season pack WEBRip 1080p, 25 GiB', preset: 'p1080', release: release('webrip', 1080, 25), runtime: PACK, expected: [] },
  { name: 'season pack WEBRip 1080p, 80 GiB', preset: 'p1080', release: release('webrip', 1080, 80), runtime: PACK, expected: ['size_above_max'] },
];

describe('preset samples', () => {
  it.each(samples)('$name', ({ preset, release, runtime, expected }) => {
    expect(evaluate(profiles[preset]!, sizes, release, { runtimeMinutes: runtime }).rejections).toEqual(expected);
  });
});

describe('quality table', () => {
  it('has version 2', () => {
    expect(QUALITY_TABLE_VERSION).toBe(2);
  });

  it('keeps minimum below preferred below maximum where the table sets all three', () => {
    for (const { min, preferred, max } of Object.values(sizes)) {
      if (preferred === null || max === null) continue;
      expect(min).toBeLessThan(preferred);
      expect(preferred).toBeLessThan(max);
    }
  });

  it('has no size limit for a quality that version 1 did not set', () => {
    expect(sizes['hdtv-720']).toEqual({ min: 0, preferred: null, max: null });
    expect(Object.keys(sizes)).toHaveLength(QUALITIES.length);
  });

  it('puts WEB-DL first, then WEBRip, then BluRay, in the profiles of version 1', () => {
    const rank = (source: Release['source']) => evaluate(profiles.p1080!, sizes, release(source, 1080, 7), { runtimeMinutes: MOVIE }).rank;
    expect([rank('webdl'), rank('webrip'), rank('bluray')]).toEqual([0, 1, 2]);
    expect(rank('hdtv')).toBeNull();
  });

  it('reads the quality of a release from its source and resolution', () => {
    expect(qualityOf('webdl', 1080)).toBe('webdl-1080');
    expect(qualityOf('bluray', 576)).toBe('bluray-480');
    expect(qualityOf('dvd', null)).toBe('dvd');
    expect(qualityOf('webdl', null)).toBeNull();
    expect(qualityOf('webdl', 1440)).toBeNull();
    expect(qualityOf('cam', 1080)).toBeNull();
  });
});

describe('a profile that the user makes', () => {
  // WEB-DL and WEBRip of 1080p are one group. BluRay 1080p is better. HDTV 720p is the worst that the profile takes.
  const custom: Profile = { id: '3', name: 'Mixed', items: [['bluray-1080'], ['webdl-1080', 'webrip-1080'], ['hdtv-720']] };
  const rank = (source: Release['source'], resolution: number) => evaluate(custom, sizes, release(source, resolution, 7), { runtimeMinutes: MOVIE }).rank;

  it('gives the qualities of one group the same rank', () => {
    expect([rank('bluray', 1080), rank('webdl', 1080), rank('webrip', 1080), rank('hdtv', 720)]).toEqual([0, 1, 1, 2]);
    expect(rank('webdl', 720)).toBeNull();
  });

  it('uses the size of the quality of the release, and no size where the quality has none', () => {
    const tiny = (source: Release['source'], resolution: number) => evaluate(custom, sizes, release(source, resolution, 0.01), { runtimeMinutes: MOVIE }).rejections;
    expect(tiny('webdl', 1080)).toEqual(['size_below_min']);
    expect(tiny('hdtv', 720)).toEqual([]);
  });

  it('takes the size that the user sets for a quality', () => {
    const own = { ...sizes, 'hdtv-720': { min: 10, preferred: null, max: 50 } };
    expect(evaluate(custom, own, release('hdtv', 720, 0.5), { runtimeMinutes: MOVIE }).rejections).toEqual(['size_below_min']);
    expect(evaluate(custom, own, release('hdtv', 720, 20), { runtimeMinutes: MOVIE }).rejections).toEqual(['size_above_max']);
  });

  it('ranks a file by its quality, and a file with no resolution by the best rank of its source', () => {
    expect(fileRank(custom, 'webrip', 1080)).toBe(1);
    expect(fileRank(custom, 'webrip', null)).toBe(1);
    expect(fileRank(custom, 'hdtv', null)).toBe(2);
    // A quality that the profile does not take is worse than every group. A source that is not known gives no rank.
    expect(fileRank(custom, 'dvd', null)).toBe(3);
    expect(fileRank(custom, 'unknown', null)).toBeNull();
  });
});

describe('unknown runtime', () => {
  it.each([null, 0])('skips the size check without a division (%s)', (runtime) => {
    const result = evaluate(profiles.p1080!, sizes, release('webdl', 1080, 5), { runtimeMinutes: runtime });
    expect(result).toMatchObject({ accepted: true, unchecked: ['size'], mibPerMinute: null });
  });

  it('still applies the checks that need no runtime', () => {
    expect(evaluate(profiles.p1080!, sizes, release('cam', 1080, 5), { runtimeMinutes: null }).rejections).toEqual(['quality_rejected']);
  });
});

describe('audio language', () => {
  const strict = { language: 'es', strict: true };
  const check = (languages: string[] | null, audio: { language: string; strict: boolean } | null) =>
    evaluate(profiles.p1080!, sizes, release('webdl', 1080, 7, languages), { runtimeMinutes: MOVIE, audio }).rejections;

  it('rejects a release whose audio is not known when the preference is strict', () => {
    expect(check(null, strict)).toEqual(['audio_unverified']);
  });
  it('rejects a release without the language', () => {
    expect(check(['en'], strict)).toEqual(['audio_language_missing']);
  });
  it('accepts a release with the language', () => {
    expect(check(['en', 'es'], strict)).toEqual([]);
  });
  it('ignores audio when the preference is not strict, or not set', () => {
    expect(check(null, { language: 'es', strict: false })).toEqual([]);
    expect(check(null, null)).toEqual([]);
  });
});

describe('a chain of profiles', () => {
  // The second profile of the chain takes 480p only.
  const p480: Profile = { id: 'p480', name: '480p', items: [['webdl-480'], ['webrip-480'], ['bluray-480']] };
  const chain = [profiles.p1080!, p480];

  it('accepts a 480p release in the second profile after the first one passes', () => {
    const result = evaluateChain(chain, sizes, release('webdl', 480, 2), { runtimeMinutes: MOVIE });
    expect(result).toMatchObject({ accepted: true, rank: RANK_STRIDE, profile: { id: 'p480' } });
    // The group inside the profile moves the rank after the stride of the profile.
    expect(evaluateChain(chain, sizes, release('webrip', 480, 2), { runtimeMinutes: MOVIE }).rank).toBe(RANK_STRIDE + 1);
  });

  it('accepts a 1080p release in the first profile, with a better rank than the 480p one', () => {
    const high = evaluateChain(chain, sizes, release('webdl', 1080, 7), { runtimeMinutes: MOVIE });
    const low = evaluateChain(chain, sizes, release('webdl', 480, 2), { runtimeMinutes: MOVIE });
    expect(high).toMatchObject({ accepted: true, rank: 0, profile: { id: 'p1080' } });
    expect(high.rank!).toBeLessThan(low.rank!);
  });

  it('rejects a quality that no profile of the chain takes', () => {
    const result = evaluateChain(chain, sizes, release('webdl', 720, 7), { runtimeMinutes: MOVIE });
    expect(result).toMatchObject({ accepted: false, rejections: ['quality_not_in_profile'], rank: null, profile: null });
  });

  it('rejects every release when the chain is empty', () => {
    const result = evaluateChain([], sizes, release('webdl', 1080, 7), { runtimeMinutes: MOVIE });
    expect(result).toMatchObject({ accepted: false, rejections: ['quality_not_in_profile'], rank: null, profile: null });
  });

  it('gives a file the rank of the first profile that takes it', () => {
    expect(chainFileRank(chain, 'webdl', 1080)).toEqual({ rank: 0, profileIndex: 0 });
    expect(chainFileRank(chain, 'webdl', 480)).toEqual({ rank: RANK_STRIDE, profileIndex: 1 });
  });

  it('puts a file that no profile takes after the whole chain', () => {
    expect(chainFileRank(chain, 'webdl', 720)).toEqual({ rank: chain.length * RANK_STRIDE, profileIndex: null });
  });

  it('gives no rank for a file of unknown source', () => {
    expect(chainFileRank(chain, 'unknown', 1080)).toBeNull();
  });
});
