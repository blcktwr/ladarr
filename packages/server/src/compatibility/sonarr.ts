import { join } from 'node:path';
import { Router } from 'express';
import type { Db } from '../core/db.ts';
import { candidate, clock, firstProfileId, hasFiles, isObject, noTmdb, notFound, notSupported, parseId, presentFile, profileId, readOptions, readPlacement, refuse, tmdbProblem, type CompatDeps } from './common.ts';
import { AddError, addTitle } from '../library/tools/add.ts';
import { isMonitored, seriesCounts, type Episode, type Title } from '../library/library.ts';
import { folderName } from '../library/naming.ts';
import { TmdbError, type TitleMeta, type Tmdb } from '../metadata/tmdb.ts';

// A series needs a TVDB ID in the Sonarr shape. A title that TMDB does not link to TVDB has none, and ladarr does not invent one.
const visible = (title: Title) => title.mediaType === 'tv' && title.meta.tvdbId !== null;

// A season is monitored when the user chose it, or when its episodes are. Before the episodes load, the policy decides.
function seasonMonitored(db: Db, title: Title, season: number) {
  const chosen = title.seasonOverrides[season];
  if (chosen) return chosen === 'monitored';
  const episodes = title.episodes.filter((episode) => episode.season === season);
  if (episodes.length) return episodes.some((episode) => isMonitored(title, episode, db.data.settings));
  return season !== 0 && title.policy === 'all';
}

function seasonStatistics(db: Db, title: Title, season: number) {
  const episodes = title.episodes.filter((episode) => episode.season === season);
  const files = new Map<string, number>();
  let withFile = 0;
  for (const episode of episodes) {
    const file = presentFile(db, episode.fileId);
    if (!file) continue;
    withFile++;
    files.set(file.id, file.sizeBytes);
  }
  const total = title.episodesLoadedAt ? episodes.length : (title.meta.seasons.find((item) => item.seasonNumber === season)?.episodeCount ?? 0);
  const { eligible, available } = seriesCounts(title, clock(db), (episode) => episode.season === season);
  // Like Sonarr: the monitored episodes that have aired, and the episodes that have a file.
  const counted = eligible + (withFile - available);
  return {
    episodeFileCount: withFile,
    episodeCount: counted,
    totalEpisodeCount: total,
    sizeOnDisk: [...files.values()].reduce((sum, size) => sum + size, 0),
    percentOfEpisodes: counted ? Math.round((100 * withFile) / counted) : 0,
  };
}

// A series in the shape of Sonarr. The ID is the TMDB ID, and a series that is not in the library has ID 0.
export function seriesResource(db: Db, title: Title, inLibrary: boolean) {
  const { meta } = title;
  const root = db.data.roots[title.rootId];
  const seasons = meta.seasons.map((season) => ({
    seasonNumber: season.seasonNumber,
    monitored: inLibrary && seasonMonitored(db, title, season.seasonNumber),
    ...(inLibrary ? { statistics: seasonStatistics(db, title, season.seasonNumber) } : {}),
  }));
  const totals = seasons.reduce(
    (sum, season) => ({
      episodeFileCount: sum.episodeFileCount + (season.statistics?.episodeFileCount ?? 0),
      episodeCount: sum.episodeCount + (season.statistics?.episodeCount ?? 0),
      totalEpisodeCount: sum.totalEpisodeCount + (season.statistics?.totalEpisodeCount ?? 0),
      sizeOnDisk: sum.sizeOnDisk + (season.statistics?.sizeOnDisk ?? 0),
    }),
    { episodeFileCount: 0, episodeCount: 0, totalEpisodeCount: 0, sizeOnDisk: 0 },
  );
  return {
    id: inLibrary ? title.tmdbId : 0,
    title: meta.title,
    originalTitle: meta.originalTitle,
    overview: meta.overview,
    year: meta.year ?? 0,
    status: ['Ended', 'Canceled'].includes(meta.status) ? 'ended' : 'continuing',
    ended: ['Ended', 'Canceled'].includes(meta.status),
    firstAired: meta.date ?? undefined,
    runtime: meta.runtime ?? 0,
    tvdbId: meta.tvdbId,
    tmdbId: title.tmdbId,
    imdbId: meta.imdbId ?? undefined,
    // ladarr has no title pages with a slug. The slug is the TMDB ID.
    titleSlug: String(title.tmdbId),
    seriesType: title.seriesType,
    seasonFolder: true,
    monitorNewItems: 'all',
    monitored: inLibrary && !title.paused,
    seasons,
    tags: [],
    ...(inLibrary && root
      ? {
          rootFolderPath: root.path,
          path: join(root.path, title.folder ?? folderName(title)),
          qualityProfileId: profileId(title.preset ?? firstProfileId(db)),
          added: new Date(title.addedAt).toISOString(),
          statistics: {
            seasonCount: meta.seasons.filter((season) => season.seasonNumber > 0).length,
            ...totals,
            percentOfEpisodes: totals.episodeCount ? Math.min(100, Math.round((100 * totals.episodeFileCount) / totals.episodeCount)) : 0,
          },
        }
      : {}),
  };
}

// The Sonarr ID of an episode is its TMDB episode ID. It is not a TVDB ID, and the resource has no tvdbId field.
function episodeResource(db: Db, title: Title, episode: Episode) {
  return {
    id: episode.tmdbId,
    seriesId: title.tmdbId,
    seasonNumber: episode.season,
    episodeNumber: episode.number,
    title: episode.name,
    airDate: episode.airDate ?? undefined,
    hasFile: Boolean(presentFile(db, episode.fileId)),
    monitored: isMonitored(title, episode, db.data.settings),
  };
}

type SeasonChoice = { seasonNumber: number; monitored: boolean };

function readSeasons(value: unknown, known: TitleMeta['seasons']): SeasonChoice[] | string {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 200) return 'The seasons must be a list.';
  for (const item of value) {
    if (!isObject(item) || !Number.isInteger(item.seasonNumber) || typeof item.monitored !== 'boolean') return 'Each season needs a seasonNumber and a monitored value.';
    if (!known.some((season) => season.seasonNumber === item.seasonNumber)) return `The series has no season ${item.seasonNumber}.`;
  }
  return value as SeasonChoice[];
}

// A choice is saved only when it differs from what the policy gives now. A season that follows the policy keeps following it.
function applySeasons(db: Db, title: Title, seasons: SeasonChoice[]) {
  for (const { seasonNumber, monitored } of seasons) {
    if (seasonMonitored(db, title, seasonNumber) !== monitored) title.seasonOverrides[seasonNumber] = monitored ? 'monitored' : 'unmonitored';
  }
}

type Found = { title: Title } | { meta: TitleMeta } | { count: number };

// The series of a TVDB ID: the library first, then TMDB. More than one TMDB series with the ID is not a match.
async function findSeries(db: Db, tmdb: Tmdb, tvdbId: number): Promise<Found> {
  const known = Object.values(db.data.titles).find((title) => title.mediaType === 'tv' && title.meta.tvdbId === tvdbId);
  if (known) return { title: known };
  const found = await tmdb.findSeriesByTvdb(tvdbId).catch((error: unknown) => {
    if (error instanceof TmdbError && error.code === 'not_found') return [];
    throw error;
  });
  if (found.length !== 1) return { count: found.length };
  const meta = await tmdb.details('tv', found[0]!.tmdbId);
  return meta.tvdbId === tvdbId ? { meta } : { count: 0 };
}

export function sonarrRoutes(db: Db, deps: CompatDeps) {
  const router = Router();
  const own = (id: number | undefined) => {
    const title = id === undefined ? undefined : db.data.titles[`tv:${id}`];
    return title && visible(title) ? title : undefined;
  };

  router.get('/series', (req, res) => {
    const wanted = req.query.tvdbId === undefined ? undefined : parseId(req.query.tvdbId);
    if (req.query.tvdbId !== undefined && wanted === undefined) return void res.json([]);
    const titles = Object.values(db.data.titles).filter((title) => visible(title) && (wanted === undefined || title.meta.tvdbId === wanted));
    res.json(titles.map((title) => seriesResource(db, title, true)));
  });

  router.get('/series/lookup', async (req, res) => {
    const match = /^tvdb:([1-9]\d{0,9})$/.exec(typeof req.query.term === 'string' ? req.query.term : '');
    if (!match) return notSupported(res, 'Use the term tvdb:<ID> to look up a series.');
    if (!deps.tmdb) return noTmdb(res);
    try {
      const found = await findSeries(db, deps.tmdb, Number(match[1]));
      if ('title' in found) return void res.json([seriesResource(db, found.title, true)]);
      if ('meta' in found) return void res.json([seriesResource(db, candidate(found.meta), false)]);
      if (found.count > 1) return void res.status(409).json({ message: 'Conflict', detail: 'More than one TMDB series has this TVDB ID.' });
      res.json([]);
    } catch (error) {
      tmdbProblem(res, error);
    }
  });

  router.get('/series/:id', (req, res) => {
    const title = own(parseId(req.params.id));
    if (!title) return notFound(res, 'No series has this ID.');
    res.json(seriesResource(db, title, true));
  });

  router.post('/series', async (req, res) => {
    const body = isObject(req.body) ? req.body : {};
    if (!deps.tmdb) return noTmdb(res);
    const errors: [string, string][] = [];
    const tvdbId = body.tvdbId;
    if (typeof tvdbId !== 'number' || !Number.isInteger(tvdbId) || tvdbId < 1) errors.push(['tvdbId', 'The TVDB ID must be a whole number from 1.']);
    const placement = readPlacement(db, 'tv', body);
    if ('errors' in placement) errors.push(...placement.errors);
    const options = readOptions(body, ['searchForMissingEpisodes', 'ignoreEpisodesWithFiles']);
    if ('errors' in options) errors.push(...options.errors);
    const seriesType = body.seriesType ?? 'standard';
    if (seriesType !== 'standard' && seriesType !== 'anime') errors.push(['seriesType', 'Only standard and anime are supported.']);
    if ((body.monitorNewItems ?? 'all') !== 'all') errors.push(['monitorNewItems', 'New seasons and episodes are monitored. The value none is not supported.']);
    if (errors.length) return refuse(res, errors);

    let title: Title;
    try {
      const found = await findSeries(db, deps.tmdb, tvdbId as number);
      if ('title' in found) return refuse(res, [['tvdbId', 'This series has already been added.']]);
      if (!('meta' in found)) return refuse(res, [['tvdbId', found.count ? 'More than one TMDB series has this TVDB ID.' : 'TMDB has no series with this TVDB ID.']]);
      const seasons = readSeasons(body.seasons, found.meta.seasons);
      if (typeof seasons === 'string') return refuse(res, [['seasons', seasons]]);
      const { preset, root, monitored } = placement as Exclude<typeof placement, { errors: unknown }>;
      ({ title } = await addTitle({ db, tmdb: deps.tmdb, enqueue: deps.enqueue }, { mediaType: 'tv', tmdbId: found.meta.tmdbId, mode: monitored ? 'all' : 'paused', seriesType: seriesType as 'standard' | 'anime', preset, rootId: root.id }));
      applySeasons(db, title, seasons);
      if ((options as { search: boolean }).search && monitored) deps.enqueue({ type: 'queue.initial', payload: { key: title.key }, dedupeKey: `initial:${title.key}` });
    } catch (error) {
      if (error instanceof AddError) return refuse(res, [['tvdbId', 'This series has already been added.']]);
      return tmdbProblem(res, error);
    }
    await db.write();
    deps.events.publish('library.changed', { key: title.key });
    res.status(201).json(seriesResource(db, title, true));
  });

  // Seerr sends the whole series that the lookup gave, with its changes. ladarr reads the fields that it can change.
  // The addOptions of this call are ignored. A caller that wants a search sends the command MissingEpisodeSearch.
  router.put('/series', async (req, res) => {
    const body = isObject(req.body) ? req.body : {};
    const title = own(typeof body.id === 'number' ? body.id : undefined);
    if (!title) return notFound(res, 'No series has this ID.');
    const placement = readPlacement(db, 'tv', body);
    if ('errors' in placement) return refuse(res, placement.errors);
    const seasons = readSeasons(body.seasons, title.meta.seasons);
    if (typeof seasons === 'string') return refuse(res, [['seasons', seasons]]);
    const seriesType = body.seriesType ?? title.seriesType;
    if (seriesType !== 'standard' && seriesType !== 'anime') return refuse(res, [['seriesType', 'Only standard and anime are supported.']]);
    if (placement.root.id !== title.rootId && hasFiles(title)) return refuse(res, [['rootFolderPath', 'The files of a series do not move to another root folder.']]);
    title.rootId = placement.root.id;
    title.preset = placement.preset;
    title.paused = !placement.monitored;
    title.seriesType = seriesType;
    applySeasons(db, title, seasons);
    await db.write();
    deps.events.publish('library.changed', { key: title.key });
    res.status(202).json(seriesResource(db, title, true));
  });

  // ladarr removes the record only. Sonarr callers ask to delete the files too, so ladarr refuses the call.
  router.delete('/series/:id', (_req, res) => notSupported(res, 'A series cannot be removed through this API. Remove it in the app.'));

  router.get('/episode', (req, res) => {
    const title = own(parseId(req.query.seriesId));
    if (!title) return notFound(res, 'No series has this ID.');
    res.json(title.episodes.map((episode) => episodeResource(db, title, episode)));
  });

  router.put('/episode/monitor', async (req, res) => {
    const { episodeIds, monitored } = isObject(req.body) ? req.body : ({} as Record<string, unknown>);
    if (!Array.isArray(episodeIds) || episodeIds.length > 1000 || !episodeIds.every((id) => Number.isInteger(id)) || typeof monitored !== 'boolean') {
      return refuse(res, [['episodeIds', 'Send a list of episode IDs and a monitored value.']]);
    }
    const byId = new Map<number, { title: Title; episode: Episode }>();
    for (const title of Object.values(db.data.titles)) if (visible(title)) for (const episode of title.episodes) byId.set(episode.tmdbId, { title, episode });
    const missing = episodeIds.find((id) => !byId.has(id));
    if (missing !== undefined) return notFound(res, `No episode has the ID ${missing}.`);
    const changed = new Set<Title>();
    for (const id of episodeIds) {
      const { title, episode } = byId.get(id)!;
      episode.override = monitored ? 'monitored' : 'unmonitored';
      changed.add(title);
    }
    await db.write();
    for (const title of changed) deps.events.publish('library.changed', { key: title.key });
    res.status(202).json(episodeIds.map((id) => episodeResource(db, byId.get(id)!.title, byId.get(id)!.episode)));
  });

  return router;
}
