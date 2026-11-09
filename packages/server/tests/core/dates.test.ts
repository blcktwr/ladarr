import { describe, expect, it } from 'vitest';
import { endOfDay, episodeEligibleAt, releaseInstant, startOfDay } from '../../src/core/dates.ts';

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

describe('end of a date in a time zone', () => {
  it('uses the offset of the zone', () => {
    expect(iso(endOfDay('2008-01-20', 'UTC'))).toBe('2008-01-20T23:59:59.999Z');
    expect(iso(endOfDay('2020-01-20', 'America/Argentina/Buenos_Aires'))).toBe('2020-01-21T02:59:59.999Z');
    // Argentina used summer time in January 2008.
    expect(iso(endOfDay('2008-01-20', 'America/Argentina/Buenos_Aires'))).toBe('2008-01-21T01:59:59.999Z');
    expect(iso(endOfDay('2008-01-20', 'Asia/Tokyo'))).toBe('2008-01-20T14:59:59.999Z');
  });

  it('follows summer time', () => {
    expect(iso(endOfDay('2024-01-15', 'America/New_York'))).toBe('2024-01-16T04:59:59.999Z');
    expect(iso(endOfDay('2024-07-15', 'America/New_York'))).toBe('2024-07-16T03:59:59.999Z');
  });

  it('is right on the day that the clock changes', () => {
    // New York moved to summer time on 2024-03-10 at 02:00. The day ended at UTC-4.
    expect(iso(endOfDay('2024-03-10', 'America/New_York'))).toBe('2024-03-11T03:59:59.999Z');
    expect(iso(endOfDay('2024-11-03', 'America/New_York'))).toBe('2024-11-04T04:59:59.999Z');
  });

  it('handles a zone with a half-hour offset', () => {
    expect(iso(endOfDay('2024-01-15', 'Asia/Kolkata'))).toBe('2024-01-15T18:29:59.999Z');
  });
});

describe('start of a date', () => {
  it('uses the offset of the zone', () => {
    expect(iso(startOfDay('2020-07-15', 'America/Argentina/Buenos_Aires'))).toBe('2020-07-15T03:00:00.000Z');
    expect(iso(startOfDay('2020-07-15', 'UTC'))).toBe('2020-07-15T00:00:00.000Z');
  });
});

describe('eligibility times', () => {
  it('has no time for an unknown air date', () => {
    expect(episodeEligibleAt(null, 'UTC')).toBeNull();
  });

  it('turns an air date into the end of that date', () => {
    expect(iso(episodeEligibleAt('2008-01-20', 'UTC'))).toBe('2008-01-20T23:59:59.999Z');
  });

  it('treats a midnight UTC release as a date, and another time as an instant', () => {
    expect(iso(releaseInstant('2020-07-15T00:00:00.000Z', 'America/Argentina/Buenos_Aires'))).toBe('2020-07-15T03:00:00.000Z');
    expect(iso(releaseInstant('2020-07-15T07:30:00.000Z', 'America/Argentina/Buenos_Aires'))).toBe('2020-07-15T07:30:00.000Z');
  });
});
