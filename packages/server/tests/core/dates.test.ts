import { beforeEach, describe, expect, it } from 'vitest';
import { endOfDay, episodeEligibleAt, releaseInstant, startOfDay } from '../../src/core/dates.ts';
import { open } from '../../src/core/db.ts';
import type { Db } from '../../src/types.ts';

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

let db: Db;
beforeEach(async () => {
  db = await open('unused.json');
});
const setZone = (timeZone: string) => Object.assign(db.data.settings, { timeZone });

describe('days', () => {
  it('starts and ends a date in UTC by default', () => {
    expect(iso(startOfDay('2020-07-15'))).toBe('2020-07-15T00:00:00.000Z');
    expect(iso(endOfDay('2020-07-15'))).toBe('2020-07-15T23:59:59.999Z');
  });

  it('follows the daylight saving time of the time zone', () => {
    setZone('America/New_York');
    // The clocks go forward on 2020-03-08, so that day has 23 hours.
    expect(iso(startOfDay('2020-03-08'))).toBe('2020-03-08T05:00:00.000Z');
    expect(iso(endOfDay('2020-03-08'))).toBe('2020-03-09T03:59:59.999Z');
    expect(iso(startOfDay('2020-03-09'))).toBe('2020-03-09T04:00:00.000Z');
    // The clocks go back on 2020-11-01, so that day has 25 hours.
    expect(iso(startOfDay('2020-11-01'))).toBe('2020-11-01T04:00:00.000Z');
    expect(iso(endOfDay('2020-11-01'))).toBe('2020-11-02T04:59:59.999Z');
  });
});

describe('eligibility times', () => {
  it('has no time for an unknown air date', () => {
    expect(episodeEligibleAt(null)).toBeNull();
  });

  it('makes an episode eligible at the start of its UTC air date by default', () => {
    expect(iso(episodeEligibleAt('2008-01-20'))).toBe('2008-01-20T00:00:00.000Z');
  });

  it('treats a midnight UTC release as a date, and another time as an instant', () => {
    expect(iso(releaseInstant('2020-07-15T00:00:00.000Z'))).toBe('2020-07-15T00:00:00.000Z');
    expect(iso(releaseInstant('2020-07-15T07:30:00.000Z'))).toBe('2020-07-15T07:30:00.000Z');
  });

  it.each([
    { zone: 'America/Argentina/Buenos_Aires', start: '2020-07-15T03:00:00.000Z', end: '2020-07-16T02:59:59.999Z' },
    { zone: 'Asia/Tokyo', start: '2020-07-14T15:00:00.000Z', end: '2020-07-15T14:59:59.999Z' },
  ])('starts a date without a time at local midnight in $zone', ({ zone, start, end }) => {
    setZone(zone);
    expect(iso(startOfDay('2020-07-15'))).toBe(start);
    expect(iso(endOfDay('2020-07-15'))).toBe(end);
    expect(iso(episodeEligibleAt('2020-07-15'))).toBe(start);
    expect(iso(releaseInstant('2020-07-15T00:00:00.000Z'))).toBe(start);
    expect(iso(releaseInstant('2020-07-15T07:30:00.000Z'))).toBe('2020-07-15T07:30:00.000Z');
  });
});
