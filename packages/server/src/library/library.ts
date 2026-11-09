import type { Availability, MediaType, Override, Policy } from '@ladarr/shared/enums';
import { episodeEligibleAt, releaseInstant } from '../core/dates.ts';
import type { EpisodeMeta, TitleMeta } from '../metadata/tmdb.ts';

export type { Availability, Override, Policy };

// The TMDB part replaces on each refresh. `override` and `fileId` belong to ladarr, so a refresh keeps them.
export type Episode = EpisodeMeta & { override: Override | null; fileId: string | null };

// `meta` holds the TMDB facts. Every other field is a choice of the user or a fact of ladarr,
// and a refresh never changes it. This keeps a refresh from changing a policy.
export type Title = {
  key: string;
  mediaType: MediaType;
  tmdbId: number;
  meta: TitleMeta;
  // Null while the refresh job fetches the TMDB facts of a title that entered the queue first.
  // A record from before this field always has the facts, so it lacks the field.
  metaLoadedAt?: number | null;
  refreshedAt: number;
  addedAt: number;
  // Paused is a control state. It does not change the policy that applies after a resume.
  paused: boolean;
  policy: Policy;
  // With the Future policy, an episode is monitored when it airs at this time or later.
  futureFrom: number;
  seriesType: 'standard' | 'anime';
  // Null uses the default preset of the settings.
  preset: string | null;
  rootId: string;
  // The folder of the title, relative to its root. Null until a folder is known.
  folder: string | null;
  // A movie with this flag can be searched before a known digital or physical release date.
  manualRelease: boolean;
  seasonOverrides: Record<string, Override>;
  // Null until the first refresh has fetched the seasons.
  episodesLoadedAt: number | null;
  episodes: Episode[];
  // The managed file of a movie.
  fileId: string | null;
};

export const titleKey = (mediaType: MediaType, tmdbId: number) => `${mediaType}:${tmdbId}`;
const episodeKey = (episode: { season: number; number: number }) => `${episode.season}x${episode.number}`;

// A file that is gone from the disk does not make an episode or a movie available.
type Clock = { now: number; timeZone: string; files: Record<string, { missing: boolean }> };
const present = (clock: Clock, fileId: string | null) => Boolean(fileId && clock.files[fileId] && !clock.files[fileId]!.missing);

export function isMonitored(title: Title, episode: Episode, { timeZone }: Pick<Clock, 'timeZone'>) {
  if (episode.override) return episode.override === 'monitored';
  const season = title.seasonOverrides[episode.season];
  if (season) return season === 'monitored';
  // Specials are outside the policy. The user selects them one by one.
  if (episode.season === 0) return false;
  if (title.policy === 'future') {
    const airs = episodeEligibleAt(episode.airDate, timeZone);
    // An episode without a date has not aired, so it is in the future.
    return airs === null || airs >= title.futureFrom;
  }
  return true;
}

export function seriesCounts(title: Title, clock: Clock, include: (episode: Episode) => boolean = () => true) {
  const { now, timeZone } = clock;
  let total = 0;
  let eligible = 0;
  let available = 0;
  let upcoming = 0;
  for (const episode of title.episodes) {
    if (!include(episode)) continue;
    total++;
    if (!isMonitored(title, episode, { timeZone })) continue;
    const airs = episodeEligibleAt(episode.airDate, timeZone);
    if (airs === null || airs > now) upcoming++;
    else {
      eligible++;
      if (present(clock, episode.fileId)) available++;
    }
  }
  return { total, eligible, available, upcoming };
}

// The earliest known digital or physical release in the region. A theatrical release alone gives no date.
export function movieEligibleAt(title: Title, { region, timeZone }: { region: string; timeZone: string }) {
  const times = title.meta.releaseDates
    .filter((date) => date.region === region && (date.kind === 'digital' || date.kind === 'physical'))
    .map((date) => releaseInstant(date.date, timeZone));
  return times.length ? Math.min(...times) : null;
}

export function availability(title: Title, clock: Clock & { region: string }): Availability {
  if (title.mediaType === 'movie') {
    if (present(clock, title.fileId)) return 'available';
    const at = movieEligibleAt(title, clock);
    return title.manualRelease || (at !== null && at <= clock.now) ? 'missing' : 'waiting';
  }
  const { eligible, available } = seriesCounts(title, clock);
  if (eligible === 0) return 'waiting';
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
