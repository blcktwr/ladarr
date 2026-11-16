import { profilesFor } from '../../core/db.ts';
import { evaluateChain, explainProfile, qualityLabel, qualityOf, RANK_STRIDE } from './quality.ts';
import { normalizeTitle, parseRelease } from './release.ts';
import { magnetHash } from './torrent.ts';
import type { Covered, DecideContext, Decision, Episode, ExplainedDecision, Profile, RawRelease, Title, Want } from '../../types.ts';

// The text for each code. It is the key of the web i18n, and it names the affected title in the user interface, so it has no title in it.
export const REJECTION_TEXT: Record<string, string> = {
  wrong_title: 'The title of the release is not this title.',
  year_missing: 'The release has no year, so the movie cannot be identified.',
  year_mismatch: 'The year of the release is not the year of the title.',
  not_a_movie: 'The release is for a series.',
  not_an_episode: 'The release has no season and episode.',
  not_a_pack: 'The release is not a full season.',
  wrong_season: 'The release is for another season.',
  wrong_episode: 'The release is for other episodes.',
  daily_ambiguous: 'The air date matches more than one episode, or none.',
  multi_season_pack: 'The release holds more than one season.',
  pack_covers_others: 'An earlier download of this pack held other episodes.',
  covers_available_episode: 'The release covers an episode that is available already.',
  already_available: 'A file is available for this target.',
  not_an_upgrade: 'The quality of the release is not better than the quality of the current file.',
  upgrade_needs_single: 'The release is for several episodes. It cannot replace the file of one episode.',
  already_downloading: 'This release is in the queue.',
  no_download_link: 'The release has no download link.',
  indexer_removed: 'The indexer of the release was removed.',
  quality_rejected: 'The quality is not good enough (for example a camera copy).',
  no_seeders: 'The release has no seeders.',
  quality_not_in_profile: 'The quality of the release is not in the allowed qualities.',
  size_below_min: 'The file is smaller than the quality allows for this runtime.',
  size_above_max: 'The file is larger than the quality allows for this runtime.',
  audio_unverified: 'The name of the release does not say which audio it has.',
  audio_language_missing: 'The release does not have the audio language that you selected.',
};

const alias = (title: Title) => [title.meta.title, title.meta.originalTitle, ...title.meta.aliases].filter(Boolean).map(normalizeTitle);

// The year when the title started. A release cannot be older than the title that it names, and a later year can be the
// year of a season.
const firstYear = (title: Title) => title.meta.year ?? title.episodes.reduce<number | null>((first, episode) => {
  const year = episode.airDate ? Number(episode.airDate.slice(0, 4)) : null;
  return year === null ? first : first === null ? year : Math.min(first, year);
}, null);

// The absolute number of an episode: its place in the whole series, across the seasons.
export const absoluteNumber = (title: Title, season: number, number: number) =>
  title.episodes.filter((episode) => episode.season > 0 && (episode.season < season || (episode.season === season && episode.number < number))).length + 1;

export function titleMatches(parsedTitle: string, title: Title) {
  const wanted = normalizeTitle(parsedTitle);
  return wanted !== '' && alias(title).includes(wanted);
}

export function decide(release: RawRelease, want: Want, ctx: DecideContext): Decision {
  const { title } = want;
  const parsed = parseRelease(release.title);
  const rejections: string[] = [];
  let covers: Covered[] = [];
  let kind: Decision['kind'] = 'single';
  const reject = (code: string) => void rejections.push(code);

  // Identity: is this release the target?
  if (!titleMatches(parsed.title, title)) reject('wrong_title');
  if (want.kind === 'movie') {
    if (parsed.season !== null || parsed.pack || parsed.multiSeason || parsed.airDate || parsed.absolute !== null) reject('not_a_movie');
    // A year that the catalog does not know is not a year that the release contradicts.
    else if (title.meta.year !== null) {
      if (parsed.year === null) reject('year_missing');
      else if (parsed.year !== title.meta.year) reject('year_mismatch');
    }
  } else if (want.kind === 'episode') {
    let numbers = parsed.episodes;
    let season = parsed.season;
    // A release of the rest of a season numbers its own season from 1, so its numbers give the places in that rest.
    const continuation = want.continuation;
    if (continuation && season === continuation.releaseSeason) {
      numbers = numbers.map((number) => continuation.from + number - 1);
      season = continuation.season;
    }
    // A pack is not an episode, also when its name carries the air date of one.
    if (parsed.pack || parsed.multiSeason) reject(parsed.multiSeason ? 'multi_season_pack' : 'not_an_episode');
    else if (parsed.absolute !== null && !continuation) {
      // An anime release names the absolute number of the episode. It matches the episode with that number.
      if (want.season === 0 || absoluteNumber(title, want.season, want.number) !== parsed.absolute) reject('wrong_episode');
      else {
        season = want.season;
        numbers = [want.number];
      }
    } else if (parsed.airDate) {
      // A daily release names a date. It matches only when one episode aired that day.
      const same = title.episodes.filter((episode) => episode.airDate === parsed.airDate);
      if (same.length === 1) {
        season = same[0]!.season;
        numbers = [same[0]!.number];
      } else reject('daily_ambiguous');
    } else if (season === null || !numbers.length) reject('not_an_episode');
    if (!rejections.includes('daily_ambiguous') && season !== null && numbers.length) {
      if (season !== want.season) reject('wrong_season');
      else if (!numbers.includes(want.number)) reject('wrong_episode');
      else {
        covers = numbers.map((number) => ({ season: season!, number }));
        if (numbers.length > 1) kind = 'multi';
        // The other episodes of a multi-episode file must not have a file now. An episode that the catalog does not
        // have is not an episode that a file covers.
        const others = numbers.filter((number) => number !== want.number).map((number) => title.episodes.find((e) => e.season === season && e.number === number));
        if (others.some((episode) => episode !== undefined && ctx.hasFile(episode)) && !ctx.manual) reject('covers_available_episode');
      }
    }
  } else {
    kind = 'pack';
    // A release of the rest of a season names the next season, and holds the episodes of the season from `from` up.
    const continuation = want.continuation;
    const releaseSeason = continuation?.releaseSeason ?? want.season;
    if (parsed.multiSeason) reject('multi_season_pack');
    else if (!parsed.pack) reject('not_a_pack');
    else if (parsed.season !== releaseSeason) reject('wrong_season');
    else {
      const from = continuation?.from ?? 0;
      const inSeason = title.episodes.filter((episode) => episode.season === want.season && episode.number >= from);
      // The files of an earlier download of this pack say which episodes it holds. A pack can hold fewer episodes than
      // TMDB gives the season, so the record decides instead of the count of the season.
      const held = ctx.coverage(release);
      const known = held && held.titleKey === title.key && held.season === want.season ? new Set(held.numbers) : null;
      covers = inSeason.filter((episode) => !known || known.has(episode.number)).map((episode) => ({ season: episode.season, number: episode.number }));
      if (!inSeason.length) reject('wrong_season');
      // The pack held other episodes of the season, so it gives none of this target.
      else if (known && !covers.length) reject('pack_covers_others');
    }
  }

  // A series shares its name with other titles too. A release older than the title is another title.
  if (want.kind !== 'movie' && parsed.year !== null && parsed.year < (firstYear(title) ?? parsed.year)) reject('year_mismatch');

  // Quality and size.
  const profiles = profilesFor(ctx.quality, title);
  const runtimeOf = (episode: Episode | undefined) => episode?.runtime ?? title.meta.runtime;
  const runtimes =
    want.kind === 'movie'
      ? [title.meta.runtime]
      : covers.map((c) => runtimeOf(title.episodes.find((e) => e.season === c.season && e.number === c.number)));
  const runtimeMinutes = runtimes.length && runtimes.every((value): value is number => typeof value === 'number' && value > 0) ? runtimes.reduce((sum, value) => sum + value, 0) : null;
  const audio = parsed.audioLanguages?.filter((language) => language !== 'multi') ?? null;
  // A movie and an episode check their size against different tables.
  const sizes = want.kind === 'movie' ? ctx.quality.qualitySizes.movie : ctx.quality.qualitySizes.tv;
  const quality = evaluateChain(profiles, sizes, { source: parsed.source, resolution: parsed.resolution, sizeBytes: release.sizeBytes, audioLanguages: audio?.length ? audio : null }, { runtimeMinutes, audio: ctx.settings.audio });
  // A pack can hold fewer episodes than TMDB gives the season, so its total needs only the size of one episode of the
  // quality. The files of the download say how many episodes it really holds.
  const oneEpisode = want.kind === 'season' && runtimeMinutes !== null ? Math.min(...(runtimes as number[])) : null;
  const packFloor = oneEpisode ? release.sizeBytes / (1024 * 1024) / oneEpisode : null;
  const qualityRejections = quality.rejections.filter((code) => !(code === 'size_below_min' && packFloor !== null && quality.limits?.min != null && packFloor >= quality.limits.min));
  if (!ctx.manual) rejections.push(...qualityRejections);

  // Policy of the library and of the indexer.
  const indexer = ctx.indexers[release.indexerId];
  const app = want.title.mediaType === 'movie' ? 'radarr' : 'sonarr';
  const push = indexer?.push[app];
  if (!indexer || !push) reject('indexer_removed');
  // A release that the indexer reports with no seeders may never download. It stays a preference of the indexer, so a
  // person can take it by hand.
  if (!ctx.manual && indexer?.rejectZeroSeeders && release.seeders === 0) reject('no_seeders');
  if (!release.link && !release.magnet) reject('no_download_link');
  // An answer can carry the magnet only, and the hash of that magnet is the hash of the torrent.
  const hash = release.infoHash ?? (release.magnet ? (magnetHash(release.magnet) ?? null) : null);
  if (hash && ctx.downloading(hash)) reject('already_downloading');
  // A want with `upgradeQuality` is for a target that has a file. The release must have exactly the chosen quality.
  if (want.kind !== 'season' && want.upgradeQuality !== undefined) {
    if (qualityOf(parsed.source, parsed.resolution) !== want.upgradeQuality) reject('not_an_upgrade');
    // The file of the target holds one episode. A file for several episodes would leave the other episodes without a file.
    if (kind === 'multi') reject('upgrade_needs_single');
  } else if (want.kind === 'movie' && ctx.hasMovieFile(title) && !ctx.manual) reject('already_available');
  else if (want.kind === 'episode') {
    const episode = title.episodes.find((e) => e.season === want.season && e.number === want.number);
    if (episode && ctx.hasFile(episode) && !ctx.manual) reject('already_available');
  }

  // A person can take any release by hand, so a manual choice has no rejection.
  const finalRejections = ctx.manual ? [] : [...new Set(rejections)];

  return {
    release,
    parsed,
    rejections: finalRejections,
    accepted: finalRejections.length === 0,
    kind,
    covers,
    mibPerMinute: quality.mibPerMinute,
    rank: quality.rank ?? profiles.length * RANK_STRIDE,
    indexerPriority: push?.priority ?? 50,
    // A quality with no preferred size has no distance, so it does not win that step of the order.
    distance: quality.limits?.preferred != null && quality.mibPerMinute !== null ? Math.abs(quality.mibPerMinute - quality.limits.preferred) : null,
    hash,
    upgradeQuality: want.kind !== 'season' ? (want.upgradeQuality ?? null) : null,
    quality: qualityOf(parsed.source, parsed.resolution),
    limits: quality.limits,
  };
}

// The order of the spec: quality rank, indexer priority, distance from the preferred size, seeders, then a stable key.
// A larger file does not win by size alone.
export function compareDecisions(a: Decision, b: Decision) {
  // The distance compares only two releases that both have one.
  const distance = a.distance !== null && b.distance !== null ? a.distance - b.distance : 0;
  return (
    a.rank - b.rank ||
    a.indexerPriority - b.indexerPriority ||
    distance ||
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
      case 'wrong_episode':
        // A daily release names a date, and its own fields say no season or episode.
        if (parsed.airDate) return `the release is the air date ${parsed.airDate}; the target is S${pad(options.season)}E${pad(options.number)}`;
        return code === 'wrong_season'
          ? `the release is S${pad(parsed.season)}; the target is S${pad(options.season)}`
          : `the release is E${parsed.episodes.map((number) => pad(number)).join(', ')}; the target is E${pad(options.number)}`;
      case 'not_an_episode':
        return parsed.pack || parsed.multiSeason ? 'the release is a season pack' : 'the release has no season and episode';
      case 'not_a_pack':
        return parsed.episodes.length ? 'the release is a single episode' : 'the release has no season and episode';
      case 'not_a_movie':
        return 'the release is for a series';
      case 'multi_season_pack':
        return 'the release holds more than one season';
      case 'pack_covers_others':
        return 'the files of this pack held other episodes';
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
        return decision.upgradeQuality
          ? `the release is ${quality}; the upgrade asks for ${decision.upgradeQuality}`
          : `the release is ${quality}, which is not better than the current file`;
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
