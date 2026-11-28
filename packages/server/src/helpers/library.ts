import type { DownloadedQuality, SeasonRow, TitleDetail } from '@ladarr/shared/types';
import type { RequestHandler } from 'express';
import { db, profilesInOrder } from '../core/db.ts';
import { clock, summarize } from '../library/tools/api.ts';
import { seriesCounts } from '../library/library.ts';
import { downloadedQuality } from '../library/grab/upgrades.ts';
import type { Db, Episode, Events, Title } from '../types.ts';
import { normalizeNumbering, releasePoint, seasonRevision } from '@ladarr/shared/numbering';
import type { Override } from '@ladarr/shared/enums';

const KEY = /^(movie|tv):[1-9]\d*$/;
const SEASON = /^(0|[1-9]\d*)$/;

export const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

// The choices of the user for the seasons of a series that the add form sends. Undefined when the body has none.
export const seasonOverridesOf = (value: unknown): Record<string, Override> | null | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const overrides: Record<string, Override> = {};
  for (const [season, override] of Object.entries(value)) {
    if (!SEASON.test(season) || (override !== 'monitored' && override !== 'unmonitored')) return null;
    overrides[season] = override;
  }
  return overrides;
};

// The facts that the page has already, for the row that the queue shows before the refresh job runs.
export const summaryOf = (value: unknown): { title: string; year: number | null; posterPath: string | null } | null | undefined => {
  if (value === undefined) return undefined;
  if (!isObject(value)) return null;
  const { title, year, posterPath } = value;
  if (typeof title !== 'string' || !title.trim() || title.length > 300) return null;
  if (year !== null && !(typeof year === 'number' && Number.isInteger(year))) return null;
  if (posterPath !== null && !(typeof posterPath === 'string' && posterPath.length <= 300)) return null;
  return { title: title.trim(), year, posterPath };
};

export const changed = async (events: Events, key: string) => {
  await db.write();
  events.publish('library.changed', { key });
};

// A request for a key outside the library, or with a bad key, gets 404.
export function titleParam(): RequestHandler<{ key: string }> {
  return (req, res, next) => {
    const title = KEY.test(req.params.key) ? db.data.titles[req.params.key] : undefined;
    if (!title) return void res.status(404).json({ error: 'not_found' });
    res.locals.title = title;
    next();
  };
}

function downloadedQualitiesOf(title: Title): DownloadedQuality[] {
  const qualities = new Map<string, DownloadedQuality>();
  for (const file of Object.values(db.data.files)) {
    if (file.titleKey !== title.key || file.missing) continue;
    const quality = downloadedQuality(file);
    if (quality) qualities.set(quality.label, quality);
  }
  return [...qualities.values()].sort((a, b) => b.resolution - a.resolution);
}

export function seasonGroups(title: Title) {
  const numbering = normalizeNumbering(title.numbering);
  const groups = new Map<number, { episode: Episode; number: number }[]>();
  for (const episode of title.episodes) {
    const { season, number } = releasePoint(numbering, episode) ?? episode;
    const rows = groups.get(season) ?? [];
    rows.push({ episode, number });
    groups.set(season, rows);
  }
  return groups;
}

export function detail(title: Title): TitleDetail {
  const at = clock();
  const { meta } = title;
  const groups = seasonGroups(title);
  const catalog = new Map(meta.seasons.map((season) => [season.seasonNumber, season]));
  const seasons: SeasonRow[] = [...new Set([...catalog.keys(), ...groups.keys()])].sort((a, b) => a - b).map((seasonNumber) => {
    const episodes = (groups.get(seasonNumber) ?? []).map((row) => row.episode);
    const numberingRevision = seasonRevision(title.numbering, seasonNumber);
    const origin = episodes[0]?.season ?? seasonNumber;
    const season = episodes.every((episode) => episode.season === origin) ? catalog.get(origin) : undefined;
    return {
      ...season,
      seasonNumber, numberingRevision,
      airDate: season?.airDate ?? null,
      episodeCount: numberingRevision === undefined ? season?.episodeCount ?? episodes.length : episodes.length,
      counts: seriesCounts({ ...title, episodes }, at),
      override: numberingRevision === undefined ? title.seasonOverrides[seasonNumber] ?? null : null,
    };
  });
  return {
    ...summarize(title),
    overview: meta.overview,
    aliases: meta.aliases,
    date: meta.date,
    rating: meta.rating,
    runtime: meta.runtime,
    genres: meta.genres ?? [],
    certification: meta.certification ?? null,
    imdbId: meta.imdbId,
    tvdbId: meta.tvdbId,
    backdropPath: meta.backdropPath,
    policy: title.policy,
    preset: title.preset ?? profilesInOrder(db.data)[0]?.id ?? '',
    presetOverride: title.preset,
    rootId: title.rootId,
    folder: title.folder,
    manualRelease: title.manualRelease,
    metaLoadedAt: title.metaLoadedAt === null ? null : (title.metaLoadedAt ?? title.refreshedAt),
    episodesLoadedAt: title.episodesLoadedAt,
    seasons,
    downloadedQualities: downloadedQualitiesOf(title),
    numbering: title.numbering ?? { revision: 0, ranges: [] },
  };
}

export const overrideOf = (value: unknown): Override | null | undefined =>
  value === null || value === 'monitored' || value === 'unmonitored' ? value : undefined;
