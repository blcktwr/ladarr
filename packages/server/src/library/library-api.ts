import type { AddMode } from '@ladarr/shared/enums';
import type { EpisodeRow, SeasonRow, TitleDetail, TitleSummary } from '@ladarr/shared/types';
import { Router } from 'express';
import { libraryFilter, libraryType, matchesType } from './library-filters.ts';
import { episodeEligibleAt } from '../core/dates.ts';
import { profilesFor, profilesInOrder, type Db } from '../core/db.ts';
import type { Events } from '../core/events.ts';
import type { EnqueueInput, Job } from '../core/jobs.ts';
import { AddError, addTitle } from './library-add.ts';
import { catalog, titleFields } from '../core/log.ts';
import { explainProfile } from '../acquisition/quality.ts';
import { dropTitle } from './library-remove.ts';
import { refreshJob } from './metadata.ts';
import { entryId, loadingTitleKeys, queueKey, type Queue, type QueueEntry } from '../downloads/queue.ts';
import { availability, isMonitored, movieEligibleAt, seriesCounts, type Override, type Title } from './library.ts';
import { scanJob } from './scan.ts';
import { requestVerification } from './verification.ts';
import { upgradeResolutions } from '../acquisition/upgrades.ts';
import type { Tmdb } from '../metadata/tmdb.ts';

type Deps = { tmdb?: Tmdb; events: Events; enqueue: (input: EnqueueInput) => Job; queue?: Queue; cancelJob?: (id: string) => void };

const MAX_PAGE = 100;
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const KEY = /^(movie|tv):[1-9]\d*$/;
const SEASON = /^(0|[1-9]\d*)$/;

// The choices of the user for the seasons of a series that the add form sends. Undefined when the body has none.
const seasonOverridesOf = (value: unknown): Record<string, Override> | null | undefined => {
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
const summaryOf = (value: unknown): { title: string; year: number | null; posterPath: string | null } | null | undefined => {
  if (value === undefined) return undefined;
  if (!isObject(value)) return null;
  const { title, year, posterPath } = value;
  if (typeof title !== 'string' || !title.trim() || title.length > 300) return null;
  if (year !== null && !(typeof year === 'number' && Number.isInteger(year))) return null;
  if (posterPath !== null && !(typeof posterPath === 'string' && posterPath.length <= 300)) return null;
  return { title: title.trim(), year, posterPath };
};

const clock = (db: Db) => ({ now: Date.now(), timeZone: db.data.settings.timeZone, region: db.data.settings.region, files: db.data.files });

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

export function summarize(db: Db, title: Title): TitleSummary {
  const at = clock(db);
  const series = title.mediaType === 'tv';
  return {
    key: title.key,
    mediaType: title.mediaType,
    tmdbId: title.tmdbId,
    title: title.meta.title,
    year: title.meta.year,
    posterPath: title.meta.posterPath,
    providerStatus: title.meta.status,
    paused: title.paused,
    seriesType: series ? title.seriesType : null,
    availability: availability(title, at),
    counts: series ? seriesCounts(title, at) : null,
    eligibleAt: series ? null : movieEligibleAt(title, at),
  };
}

function detail(db: Db, title: Title): TitleDetail {
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

const hasFiles = (title: Title) => Boolean(title.fileId) || title.episodes.some((episode) => episode.fileId);

export function libraryRouter(db: Db, { tmdb, events, enqueue, queue, cancelJob }: Deps) {
  const router = Router();
  const changed = async (key: string) => {
    await db.write();
    events.publish('library.changed', { key });
  };

  router.get('/', (req, res) => {
    const type = libraryType(req.query.type);
    const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
    const filter = libraryFilter(db, req.query.filter);
    if ('error' in filter) return void res.status(400).json({ error: filter.error });
    const limit = Math.min(Math.max(Math.trunc(Number(req.query.limit)) || 50, 1), MAX_PAGE);
    const offset = Math.max(Math.trunc(Number(req.query.offset)) || 0, 0);

    const matches = Object.values(db.data.titles)
      .filter((title) => matchesType(title, type))
      .filter((title) => !q || title.meta.title.toLowerCase().includes(q) || title.meta.aliases.some((alias) => alias.toLowerCase().includes(q)))
      .filter(filter.test)
      .reverse()
      .sort((a, b) => b.addedAt - a.addedAt);
    // The summary needs the episodes of each series, so it is only worked out for the page.
    res.json({ items: matches.slice(offset, offset + limit).map((title) => summarize(db, title)), total: matches.length });
  });

  router.post('/', async (req, res) => {
    if (!tmdb) return void res.status(503).json({ error: 'metadata_unavailable' });
    const body = isObject(req.body) ? req.body : {};
    const { mediaType, tmdbId } = body;
    if ((mediaType !== 'movie' && mediaType !== 'tv') || typeof tmdbId !== 'number' || !Number.isInteger(tmdbId) || tmdbId < 1) {
      return void res.status(400).json({ error: 'invalid_title' });
    }
    const mode = (body.add ?? 'all') as AddMode;
    if (!['all', 'future', 'paused'].includes(mode) || (mediaType === 'movie' && mode === 'future')) {
      return void res.status(400).json({ error: 'invalid_add_mode' });
    }
    const seriesType = body.seriesType ?? 'standard';
    if ((seriesType !== 'standard' && seriesType !== 'anime') || (mediaType === 'movie' && seriesType !== 'standard')) {
      return void res.status(400).json({ error: 'invalid_series_type' });
    }
    const preset = body.preset ?? null;
    if (preset !== null && !(typeof preset === 'string' && Object.hasOwn(db.data.profiles, preset))) return void res.status(400).json({ error: 'invalid_preset' });
    const rootId = body.rootId ?? db.data.settings.defaultRoots[mediaType];
    if (typeof rootId !== 'string' || db.data.roots[rootId]?.mediaType !== mediaType) return void res.status(400).json({ error: 'root_required' });
    const seasonOverrides = seasonOverridesOf(body.seasonOverrides);
    if (seasonOverrides === null || (mediaType === 'movie' && Object.keys(seasonOverrides ?? {}).length > 0)) return void res.status(400).json({ error: 'invalid_season_overrides' });
    const summary = summaryOf(body.summary);
    if (summary === null) return void res.status(400).json({ error: 'invalid_summary' });

    let added;
    try {
      // The add returns before the TMDB facts arrive. The refresh job fetches them, and the queue shows the title meanwhile.
      added = await addTitle({ db, tmdb, enqueue }, { mediaType, tmdbId, mode, seriesType, preset, rootId, seasonOverrides, summary, deferMetadata: true });
    } catch (err) {
      if (err instanceof AddError) return void res.status(409).json({ error: err.code, key: err.key });
      throw err;
    }
    const profile = profilesFor(db.data, added.title)[0]!;
    const shown = explainProfile(profile);
    catalog.info('added', `Added to the library with profile ${shown.name} (${shown.qualities.join(', ')})`, titleFields(added.title), {
      year: added.title.meta.year,
      mode,
      seriesType,
      rootId,
      profile: shown,
    });
    // The first search runs when the episodes are known. A paused title is not searched, and neither is a series
    // with no monitored season yet: its episodes start the search when they air.
    const searchNow = mode !== 'future' || Object.keys(seasonOverrides ?? {}).length > 0;
    if (!added.title.paused && searchNow) enqueue({ type: 'queue.initial', payload: { key: added.title.key }, dedupeKey: `initial:${added.title.key}` });
    await changed(added.title.key);
    res.status(201).json({ title: detail(db, added.title), jobId: added.jobId });
  });

  // A request for a key outside the library, or with a bad key, gets 404.
  router.param('key', (req, res, next, key) => {
    const title = KEY.test(key) ? db.data.titles[key] : undefined;
    if (!title) return void res.status(404).json({ error: 'not_found' });
    res.locals.title = title;
    next();
  });

  router.get('/:key', (_req, res) => {
    res.json({ title: detail(db, res.locals.title) });
  });

  // The resolutions that the Upgrade button of the page offers: the ones that the profile chain defines above a file.
  router.get('/:key/upgrades', (_req, res) => {
    res.json({ resolutions: upgradeResolutions(db, res.locals.title) });
  });

  router.patch('/:key', async (req, res) => {
    const title: Title = res.locals.title;
    const body = req.body;
    if (!isObject(body)) return void res.status(400).json({ error: 'invalid_title_change' });
    const series = title.mediaType === 'tv';
    const next: Partial<Title> = {};
    for (const [field, value] of Object.entries(body)) {
      if (field === 'paused' && typeof value === 'boolean') next.paused = value;
      else if (field === 'policy' && series && (value === 'all' || value === 'future')) {
        next.policy = value;
        // Future episodes counts from the moment the user chooses it.
        if (value === 'future' && title.policy !== 'future') next.futureFrom = Date.now();
      } else if (field === 'seriesType' && series && (value === 'standard' || value === 'anime')) next.seriesType = value;
      else if (field === 'preset' && (value === null || (typeof value === 'string' && Object.hasOwn(db.data.profiles, value)))) next.preset = value;
      else if (field === 'manualRelease' && !series && typeof value === 'boolean') next.manualRelease = value;
      else if (field === 'rootId' && typeof value === 'string' && db.data.roots[value]?.mediaType === title.mediaType) {
        // Moving files between roots is a different action with a preview.
        if (value !== title.rootId && hasFiles(title)) return void res.status(409).json({ error: 'files_exist' });
        next.rootId = value;
      } else return void res.status(400).json({ error: 'invalid_title_change', field });
    }
    const wasPaused = title.paused;
    Object.assign(title, next);
    // A resume checks the folder, the client, and the queue, and starts the search for the old missing targets. The
    // search of a title that the user paused has never run for them.
    if (wasPaused && !title.paused) requestVerification(db, enqueue, title.key, {});
    await changed(title.key);
    res.json({ title: detail(db, title) });
  });

  // The record goes away. The files stay where they are.
  router.delete('/:key', async (_req, res) => {
    const title: Title = res.locals.title;
    // An unfinished import needs its title to end.
    if (Object.values(db.data.imports).some((journal) => journal.titleKey === title.key)) return void res.status(409).json({ error: 'import_running' });
    dropTitle(db, title.key, queue, cancelJob);
    await changed(title.key);
    res.json({ ok: true });
  });

  router.post('/:key/refresh', (_req, res) => {
    if (!tmdb) return void res.status(503).json({ error: 'metadata_unavailable' });
    const title: Title = res.locals.title;
    const job = enqueue(refreshJob(title.key));
    res.status(202).json({ jobId: job.id });
  });

  // Reads the folder of the title again and updates its files. The job runs in the background.
  router.post('/:key/rescan', (_req, res) => {
    const title: Title = res.locals.title;
    if (!title.folder) return void res.status(409).json({ error: 'no_folder' });
    res.status(202).json({ jobId: enqueue(scanJob(title.key)).id });
  });

  router.get('/:key/episodes', (req, res) => {
    const title: Title = res.locals.title;
    const season = Number(req.query.season);
    if (title.mediaType !== 'tv' || !Number.isInteger(season) || season < 0) return void res.status(400).json({ error: 'invalid_season' });
    const at = clock(db);
    const episodes: EpisodeRow[] = title.episodes
      .filter((episode) => episode.season === season)
      .map((episode) => {
        const airs = episodeEligibleAt(episode.airDate, at.timeZone);
        const entry = db.data.queue[entryId(title.key, episode.season, episode.number)];
        return {
          season: episode.season,
          number: episode.number,
          name: episode.name,
          airDate: episode.airDate,
          runtime: episode.runtime,
          monitored: isMonitored(title, episode, at),
          override: episode.override,
          aired: airs !== null && airs <= at.now,
          hasFile: Boolean(episode.fileId && !at.files[episode.fileId]?.missing),
          queue: entry && entry.attempt > 0 && !entry.clearedAt ? queueKey(entry) : null,
        };
      });
    res.json({ season, episodes });
  });

  const overrideOf = (value: unknown): Override | null | undefined =>
    value === null || value === 'monitored' || value === 'unmonitored' ? value : undefined;

  router.patch('/:key/seasons/:season', async (req, res) => {
    const title: Title = res.locals.title;
    const override = overrideOf(req.body?.override);
    if (title.mediaType !== 'tv' || override === undefined || !/^\d+$/.test(req.params.season)) return void res.status(400).json({ error: 'invalid_override' });
    if (override) title.seasonOverrides[req.params.season] = override;
    else delete title.seasonOverrides[req.params.season];
    await changed(title.key);
    res.json({ title: detail(db, title) });
  });

  router.patch('/:key/episodes/:season/:number', async (req, res) => {
    const title: Title = res.locals.title;
    const override = overrideOf(req.body?.override);
    const episode = title.episodes.find((e) => e.season === Number(req.params.season) && e.number === Number(req.params.number));
    if (!episode) return void res.status(404).json({ error: 'not_found' });
    if (override === undefined) return void res.status(400).json({ error: 'invalid_override' });
    episode.override = override;
    await changed(title.key);
    res.json({ title: detail(db, title) });
  });

  return router;
}
