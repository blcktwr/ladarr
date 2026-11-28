import { describe, expect, it } from 'vitest';
import {
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
