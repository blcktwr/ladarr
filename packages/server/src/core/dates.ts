/// <reference lib="esnext.temporal" />
import { db } from './db.ts';

// A date without a time is a date in the time zone of the settings. A text that is not a date has no instant.
function midnight(date: string, days = 0) {
  try {
    return Temporal.PlainDate.from(date).add({ days }).toZonedDateTime(db.data.settings.timeZone).epochMilliseconds;
  } catch {
    return NaN;
  }
}
export const startOfDay = (date: string) => midnight(date);
export const endOfDay = (date: string) => midnight(date, 1) - 1;

// A TMDB air date has no time. Search from the start of that date.
export const episodeEligibleAt = (airDate: string | null) => (airDate ? startOfDay(airDate.slice(0, 10)) : null);

// A release date at midnight UTC is a date without a time. It starts at the beginning of that date.
// A date with another time is a known instant.
export const isDateOnly = (iso: string) => iso.endsWith('T00:00:00.000Z');
export function releaseInstant(iso: string) {
  return isDateOnly(iso) ? startOfDay(iso.slice(0, 10)) : Date.parse(iso);
}
