// A date without a time is a date in UTC. The day starts at 00:00 UTC and ends at 23:59:59.999 UTC.
export const startOfDay = (date: string) => Date.parse(`${date}T00:00:00.000Z`);
export const endOfDay = (date: string) => Date.parse(`${date}T23:59:59.999Z`);

// A TMDB air date has no time. The episode is eligible at the end of that date.
export const episodeEligibleAt = (airDate: string | null) => (airDate ? endOfDay(airDate.slice(0, 10)) : null);

// A release date at midnight UTC is a date without a time. It starts at the beginning of that date.
// A date with another time is a known instant.
export const isDateOnly = (iso: string) => iso.endsWith('T00:00:00.000Z');
export function releaseInstant(iso: string) {
  return isDateOnly(iso) ? startOfDay(iso.slice(0, 10)) : Date.parse(iso);
}
