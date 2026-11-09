// Building a formatter is slow, and a library list asks for thousands of dates. So the code builds one for each zone.
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatterFor(timeZone: string) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

// Offset of a time zone from UTC at one instant, in ms. East of UTC is positive.
function offsetMs(timeZone: string, at: number) {
  const parts = formatterFor(timeZone).formatToParts(at);
  const value = Object.fromEntries(parts.map((part) => [part.type, Number(part.value)]));
  const wallAsUtc = Date.UTC(value.year!, value.month! - 1, value.day!, value.hour!, value.minute!, value.second!);
  return wallAsUtc - (at - (at % 1000));
}

// The UTC instant at which the wall clock of the time zone shows the given date and time.
function wallClockToInstant(date: string, hour: number, minute: number, second: number, ms: number, timeZone: string) {
  const [year, month, day] = date.split('-').map(Number);
  const guess = Date.UTC(year!, month! - 1, day!, hour, minute, second, ms);
  // The second pass uses the offset at the first result, which matters near a change of the clock.
  const first = guess - offsetMs(timeZone, guess);
  return guess - offsetMs(timeZone, first);
}

// Many episodes share a date, so the results are kept. The map is cleared when it grows too large.
const MAX_MEMO = 50_000;
const memo = new Map<string, number>();
function memoized(kind: 'start' | 'end', date: string, timeZone: string) {
  const key = `${kind}|${timeZone}|${date}`;
  let value = memo.get(key);
  if (value === undefined) {
    if (memo.size >= MAX_MEMO) memo.clear();
    value = kind === 'start' ? wallClockToInstant(date, 0, 0, 0, 0, timeZone) : wallClockToInstant(date, 23, 59, 59, 999, timeZone);
    memo.set(key, value);
  }
  return value;
}

export const startOfDay = (date: string, timeZone: string) => memoized('start', date, timeZone);
export const endOfDay = (date: string, timeZone: string) => memoized('end', date, timeZone);

// A TMDB air date has no time. The episode is eligible at the end of that date in the user's time zone.
export const episodeEligibleAt = (airDate: string | null, timeZone: string) => (airDate ? endOfDay(airDate.slice(0, 10), timeZone) : null);

// A release date at midnight UTC is a date without a time. It starts at the beginning of that date in the user's time zone.
// A date with another time is a known instant.
export const isDateOnly = (iso: string) => iso.endsWith('T00:00:00.000Z');
export function releaseInstant(iso: string, timeZone: string) {
  return isDateOnly(iso) ? startOfDay(iso.slice(0, 10), timeZone) : Date.parse(iso);
}
