import type { Availability, MediaType } from '@ladarr/shared/enums';
import { endOfDay, episodeEligibleAt, startOfDay } from '../core/dates.ts';
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
    // Include episodes with no air date and those that air on the day monitoring starts.
    return !episode.airDate || endOfDay(episode.airDate.slice(0, 10)) >= title.futureFrom;
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

export function movieEligibleAt(title: Title) {
  return title.meta.date ? startOfDay(title.meta.date.slice(0, 10)) : null;
}

export function availability(title: Title, clock: Clock): Availability {
  if (title.mediaType === 'movie') {
    if (present(clock, title.fileId)) return 'available';
    const at = movieEligibleAt(title);
    return at !== null ? (at <= clock.now ? 'missing' : 'waiting') : title.manualRelease ? 'missing' : 'waiting';
  }
  const { eligible, available } = seriesCounts(title, clock);
  // A series is upcoming only while no episode has aired. Monitoring decides what is missing, not whether it is out.
  if (!title.episodes.some((episode) => aired(episode, clock))) return 'waiting';
  return available >= eligible ? 'available' : 'missing';
}

const bySeasonNumber = (a: Episode, b: Episode) => a.season - b.season || a.number - b.number;

// Takes the fresh TMDB episodes and keeps the choices and files of the user. An episode that TMDB drops stays when the
// caller says that a saved map, an acquisition, or an import step still refers to it.
export function mergeEpisodes(existing: Episode[], fetched: EpisodeMeta[], keep: (episode: Episode) => boolean = () => false): Episode[] {
  const before = new Map(existing.map((episode) => [episodeKey(episode), episode]));
  const merged = fetched.map((meta) => {
    const old = before.get(episodeKey(meta));
    return { ...meta, override: old?.override ?? null, fileId: old?.fileId ?? null };
  });
  const fresh = new Set(merged.map(episodeKey));
  // TMDB can drop an episode. The user keeps one that has a choice, a file, or a reference from the numbering.
  // A file links to its episode through fileId, so this check covers files too.
  const kept = existing.filter((episode) => !fresh.has(episodeKey(episode)) && (episode.override || episode.fileId || keep(episode)));
  return [...merged, ...kept].sort(bySeasonNumber);
}
