import type { Availability, MediaType } from '@ladarr/shared/enums';
import { episodeEligibleAt, releaseInstant } from '../core/dates.ts';
import type { Clock, Episode, EpisodeMeta, Title } from '../types.ts';

export const titleKey = (mediaType: MediaType, tmdbId: number) => `${mediaType}:${tmdbId}`;
const episodeKey = (episode: { season: number; number: number }) => `${episode.season}x${episode.number}`;

const present = (clock: Clock, fileId: string | null) => Boolean(fileId && clock.files[fileId] && !clock.files[fileId]!.missing);

export function isMonitored(title: Title, episode: Episode) {
  if (episode.override) return episode.override === 'monitored';
  const season = title.seasonOverrides[episode.season];
  if (season) return season === 'monitored';
  // Specials are outside the policy. The user selects them one by one.
  if (episode.season === 0) return false;
  if (title.policy === 'future') {
    const airs = episodeEligibleAt(episode.airDate);
    // An episode without a date has not aired, so it is in the future.
    return airs === null || airs >= title.futureFrom;
  }
  return true;
}

export function seriesCounts(title: Title, clock: Clock, include: (episode: Episode) => boolean = () => true) {
  const { now } = clock;
  let total = 0;
  let eligible = 0;
  let available = 0;
  let upcoming = 0;
  for (const episode of title.episodes) {
    if (!include(episode)) continue;
    total++;
    if (!isMonitored(title, episode)) continue;
    const airs = episodeEligibleAt(episode.airDate);
    if (airs === null || airs > now) upcoming++;
    else {
      eligible++;
      if (present(clock, episode.fileId)) available++;
    }
  }
  return { total, eligible, available, upcoming };
}

// An episode without a date has not aired.
const aired = (episode: Episode, clock: Clock) => {
  const airs = episodeEligibleAt(episode.airDate);
  return airs !== null && airs <= clock.now;
};

// The earliest known digital or physical release in any region. A theatrical release alone gives no date.
export function movieEligibleAt(title: Title) {
  const times = title.meta.releaseDates.filter((date) => date.kind === 'digital' || date.kind === 'physical').map((date) => releaseInstant(date.date));
  return times.length ? Math.min(...times) : null;
}

export function availability(title: Title, clock: Clock): Availability {
  if (title.mediaType === 'movie') {
    if (present(clock, title.fileId)) return 'available';
    const at = movieEligibleAt(title);
    return title.manualRelease || (at !== null && at <= clock.now) ? 'missing' : 'waiting';
  }
  const { eligible, available } = seriesCounts(title, clock);
  // A series is upcoming only while no episode has aired. Monitoring decides what is missing, not whether it is out.
  if (!title.episodes.some((episode) => aired(episode, clock))) return 'waiting';
  return available >= eligible ? 'available' : 'missing';
}

const bySeasonNumber = (a: Episode, b: Episode) => a.season - b.season || a.number - b.number;

// Takes the fresh TMDB episodes and keeps the choices and files of the user.
export function mergeEpisodes(existing: Episode[], fetched: EpisodeMeta[]): Episode[] {
  const before = new Map(existing.map((episode) => [episodeKey(episode), episode]));
  const merged = fetched.map((meta) => {
    const old = before.get(episodeKey(meta));
    return { ...meta, override: old?.override ?? null, fileId: old?.fileId ?? null };
  });
  const fresh = new Set(merged.map(episodeKey));
  // TMDB can drop an episode. The user keeps one that has a choice or a file.
  // A file links to its episode through fileId, so this check covers files too.
  const kept = existing.filter((episode) => !fresh.has(episodeKey(episode)) && (episode.override || episode.fileId));
  return [...merged, ...kept].sort(bySeasonNumber);
}
