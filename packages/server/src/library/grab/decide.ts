import { type Data, type Settings, db, profilesFor } from '../../core/db.ts';
import type { Indexer } from './indexers.ts';
import { isMonitored, type Episode, type Title } from '../library.ts';
import { evaluateChain, explainProfile, qualityLabel, qualityOf, RANK_STRIDE, type Profile, type SizeLimits } from './quality.ts';
import { normalizeTitle, parseRelease, type ParsedRelease } from './release.ts';
import type { Covered } from '../downloads/queue.ts';
import type { RawRelease } from './torznab.ts';
import { episodeEligibleAt } from '../../core/dates.ts';

// What a search looks for. A season want accepts a pack only.
// `upgradeResolution` is the resolution of a manual upgrade. The want then accepts a release of exactly that resolution.
export type Want =
  | { kind: 'movie'; title: Title; upgradeResolution?: number }
  | { kind: 'episode'; title: Title; season: number; number: number; upgradeResolution?: number }
  | { kind: 'season'; title: Title; season: number };

export type Context = {
  settings: Settings;
  // The quality profiles and the sizes of the qualities.
  quality: Pick<Data, 'profiles' | 'profileOrder' | 'qualitySizes'>;
  // The indexers by ID. A release from an indexer that is gone is rejected.
  indexers: Record<string, Indexer>;
  blocked: (release: RawRelease, hash: string | null) => boolean;
  // True when an active queue entry has this hash already.
  downloading: (hash: string) => boolean;
  hasFile: (episode: Episode) => boolean;
  hasMovieFile: (title: Title) => boolean;
  now: number;
  // A manual choice skips the preferences. It never skips the safety checks.
  manual?: boolean;
};

export type Decision = {
  release: RawRelease;
  parsed: ParsedRelease;
  rejections: string[];
  accepted: boolean;
  kind: 'single' | 'multi' | 'pack';
  covers: Covered[];
  mibPerMinute: number | null;
  // The rank of the release in the profile of the title. A lower rank is better.
  rank: number;
  indexerPriority: number;
  distance: number;
  hash: string | null;
  // The quality that the release has, or null when its name does not say.
  quality: string | null;
  // The size limits of that quality in the profile. Null when the profile does not take the quality.
  limits: SizeLimits | null;
};

// The text for each code. It is the key of the web i18n, and it names the affected title in the user interface, so it has no title in it.
export const REJECTION_TEXT: Record<string, string> = {
  wrong_title: 'The title of the release is not this title.',
  year_missing: 'The release has no year, so the movie cannot be identified.',
  year_mismatch: 'The year of the release is not the year of the movie.',
  not_a_movie: 'The release is for a series.',
  not_an_episode: 'The release has no season and episode.',
  not_a_pack: 'The release is not a full season.',
  wrong_season: 'The release is for another season.',
  wrong_episode: 'The release is for other episodes.',
  daily_ambiguous: 'The air date matches more than one episode, or none.',
  multi_season_pack: 'The release holds more than one season.',
  covers_available_episode: 'The release covers an episode that is available already.',
  pack_has_unwanted_episodes: 'The season has episodes that cannot be taken now.',
  already_available: 'A file is available for this target.',
  not_an_upgrade: 'The quality of the release is not better than the quality of the current file.',
  upgrade_needs_single: 'The release is for several episodes. It cannot replace the file of one episode.',
  already_downloading: 'This release is in the queue.',
  blocklisted: 'The release is on the blocklist.',
  no_download_link: 'The release has no download link.',
  indexer_removed: 'The indexer of the release was removed.',
  quality_rejected: 'The quality is not good enough (for example a camera copy).',
  quality_not_in_profile: 'The quality of the release is not in any quality profile of the title.',
  size_below_min: 'The file is smaller than the quality allows for this runtime.',
  size_above_max: 'The file is larger than the quality allows for this runtime.',
  audio_unverified: 'The name of the release does not say which audio it has.',
  audio_language_missing: 'The release does not have the audio language that you selected.',
};

const alias = (title: Title) => [title.meta.title, title.meta.originalTitle, ...title.meta.aliases].filter(Boolean).map(normalizeTitle);

export function titleMatches(parsedTitle: string, title: Title) {
  const wanted = normalizeTitle(parsedTitle);
  return wanted !== '' && alias(title).includes(wanted);
}

const episodeAired = (title: Title, episode: Episode, ctx: Pick<Context, 'settings' | 'now'>) => {
  const at = episodeEligibleAt(episode.airDate, ctx.settings.timeZone);
  return at !== null && at <= ctx.now;
};

export function decide(release: RawRelease, want: Want, ctx: Context): Decision {
  const { title } = want;
  const parsed = parseRelease(release.title);
  const rejections: string[] = [];
  let covers: Covered[] = [];
  let kind: Decision['kind'] = 'single';
  const reject = (code: string) => void rejections.push(code);

  // Identity: is this release the target?
  if (!titleMatches(parsed.title, title)) reject('wrong_title');
  if (want.kind === 'movie') {
    if (parsed.season !== null || parsed.pack || parsed.multiSeason || parsed.airDate) reject('not_a_movie');
    else if (parsed.year === null) reject('year_missing');
    else if (parsed.year !== title.meta.year) reject('year_mismatch');
  } else if (want.kind === 'episode') {
    let numbers = parsed.episodes;
    let season = parsed.season;
    if (parsed.airDate) {
      // A daily release names a date. It matches only when one episode aired that day.
      const same = title.episodes.filter((episode) => episode.airDate === parsed.airDate);
      if (same.length === 1) {
        season = same[0]!.season;
        numbers = [same[0]!.number];
      } else reject('daily_ambiguous');
    } else if (parsed.pack || parsed.multiSeason) reject(parsed.multiSeason ? 'multi_season_pack' : 'not_an_episode');
    else if (season === null || !numbers.length) reject('not_an_episode');
    if (!rejections.includes('daily_ambiguous') && season !== null && numbers.length) {
      if (season !== want.season) reject('wrong_season');
      else if (!numbers.includes(want.number)) reject('wrong_episode');
      else {
        covers = numbers.map((number) => ({ season: season!, number }));
        if (numbers.length > 1) kind = 'multi';
        // The other episodes of a multi-episode file must not have a file now.
        const others = numbers.filter((number) => number !== want.number).map((number) => title.episodes.find((e) => e.season === season && e.number === number));
        if (others.some((episode) => !episode || ctx.hasFile(episode)) && !ctx.manual) reject('covers_available_episode');
      }
    }
  } else {
    kind = 'pack';
    if (parsed.multiSeason) reject('multi_season_pack');
    else if (!parsed.pack) reject('not_a_pack');
    else if (parsed.season !== want.season) reject('wrong_season');
    else {
      const inSeason = title.episodes.filter((episode) => episode.season === want.season);
      covers = inSeason.map((episode) => ({ season: episode.season, number: episode.number }));
      // A pack must not bring back an episode that the user has, or one that the user did not ask for.
      const unwanted = inSeason.some((episode) => episodeAired(title, episode, ctx) && (!isMonitored(title, episode, ctx.settings) || ctx.hasFile(episode)));
      if (unwanted && !ctx.manual) reject('pack_has_unwanted_episodes');
      if (!inSeason.length) reject('wrong_season');
    }
  }

  // Quality and size.
  const profiles = profilesFor(ctx.quality, title);
  const runtimeOf = (episode: Episode | undefined) => episode?.runtime ?? title.meta.runtime;
  const runtimes =
    want.kind === 'movie'
      ? [title.meta.runtime]
      : want.kind === 'season'
        ? title.episodes.filter((e) => e.season === want.season).map(runtimeOf)
        : covers.map((c) => runtimeOf(title.episodes.find((e) => e.season === c.season && e.number === c.number)));
  const runtimeMinutes = runtimes.length && runtimes.every((value): value is number => typeof value === 'number' && value > 0) ? runtimes.reduce((sum, value) => sum + value, 0) : null;
  const audio = parsed.audioLanguages?.filter((language) => language !== 'multi') ?? null;
  const quality = evaluateChain(profiles, ctx.quality.qualitySizes, { source: parsed.source, resolution: parsed.resolution, sizeBytes: release.sizeBytes, audioLanguages: audio?.length ? audio : null }, { runtimeMinutes, audio: ctx.settings.audio });
  // A manual choice may skip the preferences of the profile. It does not skip a camera copy of unknown source: the user sees the warning.
  if (!ctx.manual) rejections.push(...quality.rejections);

  // Policy of the library and of the indexer.
  const indexer = ctx.indexers[release.indexerId];
  const app = want.title.mediaType === 'movie' ? 'radarr' : 'sonarr';
  const push = indexer?.push[app];
  if (!indexer || !push) reject('indexer_removed');
  if (!release.link && !release.magnet) reject('no_download_link');
  const hash = release.infoHash;
  if (ctx.blocked(release, hash)) reject('blocklisted');
  if (hash && ctx.downloading(hash)) reject('already_downloading');
  // A want with `upgradeResolution` is for a target that has a file. The release must have exactly the chosen resolution.
  if (want.kind !== 'season' && want.upgradeResolution !== undefined) {
    if (parsed.resolution !== want.upgradeResolution) reject('not_an_upgrade');
    // The file of the target holds one episode. A file for several episodes would leave the other episodes without a file.
    if (kind === 'multi') reject('upgrade_needs_single');
  } else if (want.kind === 'movie' && ctx.hasMovieFile(title) && !ctx.manual) reject('already_available');
  else if (want.kind === 'episode') {
    const episode = title.episodes.find((e) => e.season === want.season && e.number === want.number);
    if (episode && ctx.hasFile(episode) && !ctx.manual) reject('already_available');
  }

  return {
    release,
    parsed,
    rejections: [...new Set(rejections)],
    accepted: rejections.length === 0,
    kind,
    covers,
    mibPerMinute: quality.mibPerMinute,
    rank: quality.rank ?? profiles.length * RANK_STRIDE,
    indexerPriority: push?.priority ?? 50,
    distance: quality.limits?.preferred != null && quality.mibPerMinute !== null ? Math.abs(quality.mibPerMinute - quality.limits.preferred) : 0,
    hash,
    quality: qualityOf(parsed.source, parsed.resolution),
    limits: quality.limits,
  };
}

// The order of the spec: quality rank, indexer priority, distance from the preferred size, seeders, then a stable key.
// A larger file does not win by size alone.
export function compareDecisions(a: Decision, b: Decision) {
  return (
    a.rank - b.rank ||
    a.indexerPriority - b.indexerPriority ||
    a.distance - b.distance ||
    (b.release.seeders ?? 0) - (a.release.seeders ?? 0) ||
    `${a.release.indexerId}:${a.release.guid}`.localeCompare(`${b.release.indexerId}:${b.release.guid}`)
  );
}

export const bestOf = (decisions: Decision[]) => decisions.filter((d) => d.accepted).sort(compareDecisions)[0];

// The codes that stopped the most releases, most frequent first.
export function topRejections(decisions: Decision[], limit = 3) {
  const counts = new Map<string, number>();
  for (const decision of decisions) for (const code of decision.rejections) counts.set(code, (counts.get(code) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([code]) => code);
}

// Every code that stopped a release, with the number of releases and the text that the user reads.
export function rejectionSummary(decisions: Decision[]) {
  const counts = new Map<string, number>();
  for (const decision of decisions) for (const code of decision.rejections) counts.set(code, (counts.get(code) ?? 0) + 1);
  return [...counts]
    .map(([code, count]) => ({ code, text: REJECTION_TEXT[code] ?? code, count }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
}

const pad = (value: number | null | undefined) => (value === null || value === undefined ? '?' : String(value).padStart(2, '0'));

export type ExplainedDecision = {
  release: string;
  indexer: string;
  quality: string;
  sizeBytes: number;
  sizePerMinute: number | null;
  seeders: number | null;
  accepted: boolean;
  reasons: { code: string; text: string; detail?: string }[];
};

// One decision as a person reads it: the release, its quality and size, and the reason of each rejection with the
// numbers that made it. A log then says why a release did not match, not only a code.
export function explainDecision(decision: Decision, options: { profiles: Profile[]; indexer: string; year?: number | null; season?: number | null; number?: number | null; audioLanguage?: string | null }): ExplainedDecision {
  const { parsed, release } = decision;
  const quality = qualityLabel(parsed.source, parsed.resolution);
  const profileQualities = options.profiles.map((profile) => explainProfile(profile).qualities.join(', ')).join(' | ');
  const detail = (code: string): string | undefined => {
    switch (code) {
      case 'wrong_title':
        return `the release names "${parsed.title}"`;
      case 'year_missing':
        return `the release has no year; the title is ${options.year ?? 'unknown'}`;
      case 'year_mismatch':
        return `the release is ${parsed.year}; the title is ${options.year}`;
      case 'wrong_season':
        return `the release is S${pad(parsed.season)}; the target is S${pad(options.season)}`;
      case 'wrong_episode':
        return `the release is E${parsed.episodes.map((number) => pad(number)).join(', ')}; the target is E${pad(options.number)}`;
      case 'not_an_episode':
        return parsed.pack || parsed.multiSeason ? 'the release is a season pack' : 'the release has no season and episode';
      case 'not_a_pack':
        return 'the release is a single episode';
      case 'not_a_movie':
        return 'the release is for a series';
      case 'multi_season_pack':
        return 'the release holds more than one season';
      case 'quality_not_in_profile':
        return `the release is ${quality}; the profiles take ${profileQualities}`;
      case 'quality_rejected':
        return `the release source is ${parsed.source}, which is never taken automatically`;
      case 'size_below_min':
        return decision.mibPerMinute === null || !decision.limits ? undefined : `${decision.mibPerMinute.toFixed(1)} MiB/min is below ${decision.limits.min}`;
      case 'size_above_max':
        return decision.mibPerMinute === null || !decision.limits ? undefined : `${decision.mibPerMinute.toFixed(1)} MiB/min is above ${decision.limits.max}`;
      case 'audio_unverified':
        return 'the release name has no audio language';
      case 'audio_language_missing':
        return `the release audio is ${parsed.audioLanguages?.join(', ') || 'unknown'}; the setting is ${options.audioLanguage}`;
      case 'not_an_upgrade':
        return `the release is ${quality}, which is not better than the current file`;
      case 'upgrade_needs_single':
        return 'the release is for several episodes, and the target has one file';
      default:
        return undefined;
    }
  };
  return {
    release: release.title,
    indexer: options.indexer,
    quality,
    sizeBytes: release.sizeBytes,
    sizePerMinute: decision.mibPerMinute === null ? null : Number(decision.mibPerMinute.toFixed(1)),
    seeders: release.seeders,
    accepted: decision.accepted,
    reasons: decision.rejections.map((code) => {
      const value = detail(code);
      return { code, text: REJECTION_TEXT[code] ?? code, ...(value ? { detail: value } : {}) };
    }),
  };
}
