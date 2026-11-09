import type { SeasonRow, TitleDetail } from '@ladarr/shared/types';
import type { RequestHandler } from 'express';
import { profilesInOrder, type Db } from '../core/db.ts';
import type { Events } from '../core/events.ts';
import { loadingTitleKeys, queueKey, type QueueEntry } from '../library/downloads/queue.ts';
import { clock, summarize } from '../library/tools/api.ts';
import { seriesCounts, type Override, type Title } from '../library/library.ts';

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

export const changed = async (db: Db, events: Events, key: string) => {
  await db.write();
  events.publish('library.changed', { key });
};

// A request for a key outside the library, or with a bad key, gets 404.
export function titleParam(db: Db): RequestHandler<{ key: string }> {
  return (req, res, next) => {
    const title = KEY.test(req.params.key) ? db.data.titles[req.params.key] : undefined;
    if (!title) return void res.status(404).json({ error: 'not_found' });
    res.locals.title = title;
    next();
  };
}

// The stages in the order that the page shows them, with the work first. A target that waits for its next
// search without a result counts as searching, like the Activity page shows it.
const queueOrder = ['searching', 'fetching', 'sending', 'downloading', 'validating', 'importing', 'stuck', 'not_found', 'no_match', 'queued', 'paused', 'cancelled'];
const statusKey = (entry: QueueEntry) => {
  const key = queueKey(entry);
  return key === 'waiting' ? 'searching' : key;
};

function queueStatusOf(db: Db, titleKey: string) {
  // A series is in the queue while its episodes load, before it has a target.
  if (loadingTitleKeys(db).has(titleKey)) return 'searching';
  const counts: Record<string, number> = {};
  for (const entry of Object.values(db.data.queue)) {
    if (entry.titleKey !== titleKey || entry.attempt === 0 || entry.clearedAt) continue;
    const key = statusKey(entry);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return queueOrder.find((key) => counts[key]) ?? (counts.available ? 'available' : null);
}

export function detail(db: Db, title: Title): TitleDetail {
  const at = clock(db);
  const { meta } = title;
  const seasons: SeasonRow[] = meta.seasons.map((season) => ({
    seasonNumber: season.seasonNumber,
    episodeCount: season.episodeCount,
    counts: seriesCounts(title, at, (episode) => episode.season === season.seasonNumber),
    override: title.seasonOverrides[season.seasonNumber] ?? null,
  }));
  return {
    ...summarize(db, title),
    queueStatus: queueStatusOf(db, title.key),
    overview: meta.overview,
    aliases: meta.aliases,
    rating: meta.rating,
    runtime: meta.runtime,
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
  };
}

export const overrideOf = (value: unknown): Override | null | undefined =>
  value === null || value === 'monitored' || value === 'unmonitored' ? value : undefined;
