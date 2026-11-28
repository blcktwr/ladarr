import { describe, expect, it } from 'vitest';
import {
  assignSeasons,
  catalogPoint,
  catalogPoints,
  NO_NUMBERING,
  rangeOfCatalog,
  rangeOfRelease,
  releasePoint,
  releaseSeasons,
  validateNumbering,
} from '@ladarr/shared/numbering';
import type { Numbering, NumberingRange } from '@ladarr/shared/types';

// The confirmed correspondence: catalog episode 13 is release episode 1 of season 2.
const confirmed = (extra: Partial<NumberingRange> = {}): NumberingRange => ({ season: 1, from: 13, to: 13, releaseSeason: 2, releaseFrom: 1, ...extra });
// The full correspondence that the user saves after the pack confirms it: 1x13..1x23 are 2x01..2x11.
const full = (): NumberingRange => confirmed({ to: 23 });
const numbering = (ranges: NumberingRange[], revision = 1): Numbering => ({ revision, ranges });
const single = numbering([confirmed()]);
const complete = numbering([full()]);

describe('the conversion of one episode', () => {
  it('converts the confirmed episode to its release episode and back', () => {
    expect(releasePoint(single, { season: 1, number: 13 })).toEqual({ season: 2, number: 1 });
    expect(catalogPoint(single, { season: 2, number: 1 })).toEqual({ season: 1, number: 13 });
  });

  it('converts both ends of a full range', () => {
    expect(releasePoint(complete, { season: 1, number: 13 })).toEqual({ season: 2, number: 1 });
    expect(releasePoint(complete, { season: 1, number: 23 })).toEqual({ season: 2, number: 11 });
    expect(catalogPoint(complete, { season: 2, number: 1 })).toEqual({ season: 1, number: 13 });
    expect(catalogPoint(complete, { season: 2, number: 11 })).toEqual({ season: 1, number: 23 });
  });

  it('does not extend the range to the episode after it', () => {
    expect(releasePoint(complete, { season: 1, number: 24 })).toEqual({ season: 1, number: 24 });
    expect(catalogPoint(complete, { season: 2, number: 12 })).toEqual({ season: 2, number: 12 });
  });

  it('keeps the identity outside the ranges', () => {
    expect(releasePoint(complete, { season: 1, number: 12 })).toEqual({ season: 1, number: 12 });
    expect(catalogPoint(complete, { season: 1, number: 12 })).toEqual({ season: 1, number: 12 });
  });

  it('reports the ranges of a catalog and a release point', () => {
    expect(rangeOfCatalog(complete, 1, 13)).toEqual(full());
    expect(rangeOfCatalog(complete, 1, 12)).toBeNull();
    expect(rangeOfRelease(complete, 2, 1)).toEqual(full());
    expect(rangeOfRelease(complete, 2, 12)).toBeNull();
  });
});

describe('a collision with the identity', () => {
  it('gives the release point to the range, so the catalogue target cannot claim it', () => {
    expect(catalogPoint(single, { season: 2, number: 1 })).toEqual({ season: 1, number: 13 });
    expect(releasePoint(single, { season: 2, number: 1 })).toBeNull();
  });

  it('refuses the whole set of numbers when one of them cannot be converted', () => {
    // The second range claims catalog episode 2x12 for release season 3, so the identity of release 2x12 is a collision.
    const ranges = numbering([full(), { season: 2, from: 12, to: 15, releaseSeason: 3, releaseFrom: 1 }]);
    expect(catalogPoints(ranges, 2, [1, 12])).toBeNull();
    // Every number that the ranges name still converts.
    expect(catalogPoints(ranges, 2, [1, 2])).toEqual({ season: 1, numbers: [13, 14] });
  });
});

describe('the release seasons of a catalog season', () => {
  it('gives the catalog season and the release season of the range', () => {
    expect(releaseSeasons(complete, 1)).toEqual([1, 2]);
    expect(releaseSeasons(NO_NUMBERING, 1)).toEqual([1]);
  });
});

describe('the numbers of the episodes that move to another season', () => {
  // Season 2 starts at episode 3, so the number after its last episode is not its first free number.
  const catalog = [[1, 1], [1, 2], [1, 3], [2, 3], [2, 4]].map(([season, number]) => ({ season: season!, number: number! }));
  const move = (season: number, number: number, releaseSeason: number) => ({ season, number, releaseSeason, search: false });
  const save = (current: Numbering, ...edits: ReturnType<typeof move>[]) => assignSeasons(current, catalog, edits)!.numbering;
  const release = (map: Numbering, season: number, number: number) => releasePoint(map, { season, number });

  it('starts at 1 in an empty season', () => {
    const map = save(NO_NUMBERING, move(1, 2, 3), move(1, 3, 3));
    expect(map.ranges).toEqual([{ season: 1, from: 2, to: 3, releaseSeason: 3, releaseFrom: 1 }]);
  });

  it('gives the number after the last episode of the season', () => {
    const map = save(NO_NUMBERING, move(1, 1, 2));
    expect(map.ranges).toEqual([{ season: 1, from: 1, to: 1, releaseSeason: 2, releaseFrom: 5 }]);
    expect(release(map, 2, 3)).toEqual({ season: 2, number: 3 });
    expect(release(map, 2, 4)).toEqual({ season: 2, number: 4 });
  });

  it('numbers the moved episodes in the order of TMDB, not in the order of the edits', () => {
    const map = save(NO_NUMBERING, move(1, 3, 2), move(1, 1, 2));
    expect(release(map, 1, 1)).toEqual({ season: 2, number: 5 });
    expect(release(map, 1, 3)).toEqual({ season: 2, number: 6 });
  });

  it('numbers a second move after a saved move, and keeps the saved number', () => {
    const map = save(save(NO_NUMBERING, move(1, 3, 2)), move(1, 1, 2));
    expect(release(map, 1, 3)).toEqual({ season: 2, number: 5 });
    expect(release(map, 1, 1)).toEqual({ season: 2, number: 6 });
  });

  it('gives an episode that returns to its TMDB season its TMDB number again', () => {
    const map = save(save(NO_NUMBERING, move(1, 1, 2)), move(1, 1, 1));
    expect(map.ranges).toEqual([]);
    expect(release(map, 1, 1)).toEqual({ season: 1, number: 1 });
  });

  it('gives null when a returning episode finds its TMDB number taken', () => {
    // 2x4 leaves, 1x1 takes the number after 2x3, and 2x4 comes back.
    const taken = save(save(NO_NUMBERING, move(2, 4, 5)), move(1, 1, 2));
    expect(release(taken, 1, 1)).toEqual({ season: 2, number: 4 });
    expect(assignSeasons(taken, catalog, [move(2, 4, 2)])).toBeNull();
  });
});

describe('the validation of a saved map', () => {
  const check = (ranges: unknown[], revision: unknown = 0) => validateNumbering({ revision, ranges });

  it.each([
    ['a season that is not an integer', [confirmed({ season: 1.5 })]],
    ['a season below zero', [confirmed({ season: -1 })]],
    ['a first episode that is not an integer', [confirmed({ from: 13.5 })]],
    ['a last episode that is not an integer', [confirmed({ to: 13.5 })]],
    ['a first episode of zero', [confirmed({ from: 0 })]],
    ['a last episode before the first', [confirmed({ from: 15, to: 13 })]],
    ['a release first episode of zero', [confirmed({ releaseFrom: 0 })]],
    ['overlapping catalog ranges', [confirmed({ from: 13, to: 15, releaseSeason: 2, releaseFrom: 1 }), confirmed({ from: 15, to: 20, releaseSeason: 2, releaseFrom: 4 })]],
    ['overlapping release ranges', [confirmed({ from: 1, to: 2, releaseSeason: 2, releaseFrom: 1 }), confirmed({ from: 5, to: 6, releaseSeason: 2, releaseFrom: 2 })]],
  ])('rejects %s', (_name, ranges) => {
    expect(check(ranges)).toMatchObject({ ok: false });
  });

  it('accepts two disjoint ranges and sorts them', () => {
    const later = confirmed({ from: 20, to: 23, releaseSeason: 2, releaseFrom: 8 });
    const earlier = confirmed({ from: 13, to: 15, releaseSeason: 2, releaseFrom: 1 });
    const result = check([later, earlier]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.numbering.ranges).toEqual([earlier, later]);
  });

  it('keeps the revision that the user edited', () => {
    const result = check([], 7);
    expect(result).toEqual({ ok: true, numbering: { revision: 7, ranges: [] } });
  });
});
