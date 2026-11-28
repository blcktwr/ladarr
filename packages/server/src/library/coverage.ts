import type { EpisodeRef, Numbering, Title } from '../types.ts';
import { parseRelease } from './grab/release.ts';
import { catalogPoint, normalizeNumbering, releasePoint } from '@ladarr/shared/numbering';
import { isSample, isVideoFile, parseEpisodes, releaseEpisodes } from './parse.ts';

// Original source names establish coverage. A pack name supplies a season, not its episodes.
export function inspectCoverage(files: string[], title: Title, numbering?: Numbering | null, seasonHint?: number | null) {
  const map = normalizeNumbering(numbering === undefined ? title.numbering : numbering);
  const episodes: EpisodeRef[] = [];
  const byFile = new Map<string, EpisodeRef[]>();
  const unknown: string[] = [];
  const pending: { season: number | null; numbers: number[] | null }[] = [];
  const key = (episode: EpisodeRef) => `${episode.season}:${episode.number}`;
  const identified = new Set<string>();
  const videos = files.filter((name) => isVideoFile(name) && !isSample(name));
  const readings = videos.map((file) => parseEpisodes(file, seasonHint));
  const numberingConflicts = new Set<number>();
  for (const season of new Set(readings.flatMap((reading) => reading ? [reading.season] : []))) {
    if (map.ranges.some((range) => range.releaseSeason === season)) continue;
    const catalog = title.episodes.filter((episode) => episode.season === season).map((episode) => episode.number);
    const first = Math.min(...catalog);
    if (first <= 1 || !catalog.length) continue;
    const numbers = readings.filter((reading) => reading?.season === season).flatMap((reading) => reading!.numbers);
    if (numbers.some((number) => number < first) && numbers.some((number) => catalog.includes(number))) numberingConflicts.add(season);
  }
  const ambiguous: string[] = [];
  for (const file of videos) {
    const scopes = file.split('/').reverse().map((part) => parseRelease(part));
    const raw = parseEpisodes(file, seasonHint);
    const ambiguousSeason = raw && seasonHint == null && scopes.some((part) => part.multiSeason) && !scopes.some((part) => part.season !== null);
    const conflict = raw && numberingConflicts.has(raw.season);
    if (conflict) ambiguous.push(file);
    const found = ambiguousSeason || conflict ? undefined : releaseEpisodes(file, title.episodes, map, seasonHint, title.meta.title);
    const parsed = ambiguousSeason ? undefined : raw;
    // One file can cross catalog seasons. Each source coordinate still passes through the same map exactly once.
    const points = !conflict && !found && parsed && map.ranges.length
      ? parsed.numbers.map((number) => catalogPoint(map, { season: parsed.season, number }))
      : [];
    const crossSeason = points.length && points.every((point): point is EpisodeRef => point !== null) ? points : [];
    const refs = found ? found.numbers.map((number) => ({ season: found.season, number })) : crossSeason;
    const listed = refs.filter((ref) => title.episodes.some((episode) => episode.season === ref.season && episode.number === ref.number));
    if (listed.length) {
      byFile.set(file, listed);
      for (const episode of listed) {
        if (identified.has(key(episode))) continue;
        identified.add(key(episode));
        episodes.push(episode);
      }
      continue;
    }
    unknown.push(file);
    const season = parsed?.season ?? scopes.map((part) => part.season).find((value) => value !== null) ?? seasonHint ?? null;
    pending.push({ season, numbers: conflict ? null : parsed?.numbers ?? null });
  }
  return {
    episodes,
    byFile,
    unknown,
    ambiguous,
    status(target: EpisodeRef): 'identified' | 'absent' | 'unknown' {
      if (identified.has(key(target))) return 'identified';
      const point = releasePoint(map, target);
      if (pending.some((file) => file.season === null || (point && file.season === point.season && (file.numbers === null || file.numbers.includes(point.number))))) return 'unknown';
      // No manifest is not an empty manifest with evidence of absence.
      return videos.length ? 'absent' : 'unknown';
    },
  };
}
