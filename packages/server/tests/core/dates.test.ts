import { describe, expect, it } from 'vitest';
import { endOfDay, episodeEligibleAt, releaseInstant, startOfDay } from '../../src/core/dates.ts';

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

describe('days', () => {
  it('starts and ends a date in UTC', () => {
    expect(iso(startOfDay('2020-07-15'))).toBe('2020-07-15T00:00:00.000Z');
    expect(iso(endOfDay('2020-07-15'))).toBe('2020-07-15T23:59:59.999Z');
  });
});

describe('eligibility times', () => {
  it('has no time for an unknown air date', () => {
    expect(episodeEligibleAt(null)).toBeNull();
  });

  it('turns an air date into the end of that date', () => {
    expect(iso(episodeEligibleAt('2008-01-20'))).toBe('2008-01-20T23:59:59.999Z');
  });

  it('treats a midnight UTC release as a date, and another time as an instant', () => {
    expect(iso(releaseInstant('2020-07-15T00:00:00.000Z'))).toBe('2020-07-15T00:00:00.000Z');
    expect(iso(releaseInstant('2020-07-15T07:30:00.000Z'))).toBe('2020-07-15T07:30:00.000Z');
  });
});
