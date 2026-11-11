import type { CalendarEvent, CalendarUndated } from '@ladarr/shared/types';
import type { MediaType } from '@ladarr/shared/enums';
import { type Db, db } from '../../core/db.ts';
import { episodeEligibleAt, isDateOnly, releaseInstant } from '../../core/dates.ts';
import { availability, isMonitored, movieEligibleAt, type Title } from '../library.ts';

export const MAX_EVENTS = 5_000;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const addDays = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
export const isDay = (value: unknown): value is string => typeof value === 'string' && DAY.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && addDays(value, 0) === value;

// The date of an instant, as the day in UTC.
export function dayOf(at: number) {
  return new Date(at).toISOString().slice(0, 10);
}

// `limit` cuts the list of events. The JSON answer has a limit. The feed has none, because a cut feed looks complete.
export type CalendarQuery = { from: string; to: string; type?: MediaType; monitored: boolean; limit?: number };

// The first digital or physical release in any region, as a day. The day has a time only when TMDB gave one.
function movieRelease(title: Title) {
  const at = movieEligibleAt(title);
  if (at === null) return null;
  const raw = title.meta.releaseDates.find((date) => (date.kind === 'digital' || date.kind === 'physical') && releaseInstant(date.date) === at)!.date;
  return isDateOnly(raw) ? { day: raw.slice(0, 10), at: null } : { day: dayOf(at), at };
}

// The dated targets in a range of days, and the titles that have no date.
// Monitoring follows the episode, the season, and the policy of the title, like the library. A movie has no choice to make. Paused is a separate flag.
export function calendarEvents({ from, to, type, monitored, limit = MAX_EVENTS }: CalendarQuery, now = Date.now()) {
  const clock = { now, files: db.data.files };
  const hasFile = (fileId: string | null) => Boolean(fileId && db.data.files[fileId] && !db.data.files[fileId]!.missing);
  const events: CalendarEvent[] = [];
  const undated: CalendarUndated[] = [];

  for (const title of Object.values(db.data.titles)) {
    if (type && title.mediaType !== type) continue;
    const base = { titleKey: title.key, mediaType: title.mediaType, title: title.meta.title, year: title.meta.year };
    const paused = title.paused;

    if (title.mediaType === 'movie') {
      const release = movieRelease(title);
      if (!release) undated.push({ ...base, count: 1 });
      else if (release.day >= from && release.day <= to) {
        events.push({ ...base, id: title.key, season: null, number: null, episodeName: null, day: release.day, at: release.at, availability: availability(title, clock), monitored: true, paused });
      }
      continue;
    }

    let unknown = 0;
    for (const episode of title.episodes) {
      const day = episode.airDate?.slice(0, 10);
      if (day && (day < from || day > to)) continue;
      const watched = isMonitored(title, episode);
      if (monitored && !watched) continue;
      if (!day) {
        unknown++;
        continue;
      }
      const released = episodeEligibleAt(episode.airDate)! <= now;
      events.push({
        ...base,
        id: `${title.key}:${episode.season}x${episode.number}`,
        season: episode.season,
        number: episode.number,
        episodeName: episode.name,
        day,
        at: null,
        availability: hasFile(episode.fileId) ? 'available' : watched && released ? 'missing' : 'waiting',
        monitored: watched,
        paused,
      });
    }
    if (unknown) undated.push({ ...base, count: unknown });
  }

  const byName = (a: { title: string }, b: { title: string }) => a.title.localeCompare(b.title);
  events.sort((a, b) => a.day.localeCompare(b.day) || byName(a, b) || (a.season ?? 0) - (b.season ?? 0) || (a.number ?? 0) - (b.number ?? 0));
  undated.sort(byName);
  return { events: events.slice(0, limit), undated, truncated: events.length > limit };
}
