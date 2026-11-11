import { join, posix } from 'node:path';
import express, { Router } from 'express';
import { type Db, db } from '../core/db.ts';
import { onError } from '../core/errors.ts';
import { candidate, clock, firstProfileId, hasFiles, isObject, noTmdb, notFound, notFoundPath, notSupported, parseId, presentFile, profileId, readOptions, readPlacement, refuse, tmdbProblem, type CompatDeps } from './common.ts';
import { adapter, type AdapterOptions } from './indexer.ts';
import { AddError, addTitle } from '../library/tools/add.ts';
import { availability, type Title } from '../library/library.ts';
import { folderName } from '../library/naming.ts';
import { TmdbError } from '../metadata/tmdb.ts';

// A movie in the shape of Radarr. The ID is the TMDB ID, and a movie that is not in the library has ID 0.
// Radarr and Sonarr have separate paths, so the two ID sets do not meet.
export function movieResource(title: Title, inLibrary: boolean) {
  const { meta } = title;
  const file = presentFile(title.fileId);
  const root = db.data.roots[title.rootId];
  const folder = title.folder ?? folderName(title);
  return {
    id: inLibrary ? title.tmdbId : 0,
    title: meta.title,
    originalTitle: meta.originalTitle,
    overview: meta.overview,
    year: meta.year ?? 0,
    tmdbId: title.tmdbId,
    imdbId: meta.imdbId ?? undefined,
    // ladarr has no title pages with a slug. The slug is the TMDB ID, like the slug of Radarr 4 and later.
    titleSlug: String(title.tmdbId),
    runtime: meta.runtime ?? 0,
    monitored: !title.paused,
    minimumAvailability: title.manualRelease ? 'announced' : 'released',
    isAvailable: availability(title, clock()) !== 'waiting',
    hasFile: Boolean(file),
    tags: [],
    ...(inLibrary && root ? { rootFolderPath: root.path, path: join(root.path, folder), qualityProfileId: profileId(title.preset ?? firstProfileId()), added: new Date(title.addedAt).toISOString() } : {}),
    ...(file && root ? { sizeOnDisk: file.sizeBytes, movieFile: { movieId: title.tmdbId, relativePath: posix.relative(folder, file.path), path: join(root.path, file.path), size: file.sizeBytes, dateAdded: new Date(file.addedAt).toISOString() } } : {}),
  };
}

const MINIMUM = ['released', 'announced'];

export function radarrRoutes(deps: CompatDeps) {
  const router = Router();
  const own = (id: number | undefined) => (id === undefined ? undefined : db.data.titles[`movie:${id}`]);

  router.get('/movie', (req, res) => {
    const wanted = req.query.tmdbId === undefined ? undefined : parseId(req.query.tmdbId);
    if (req.query.tmdbId !== undefined && wanted === undefined) return void res.json([]);
    const titles = Object.values(db.data.titles).filter((title) => title.mediaType === 'movie' && (wanted === undefined || title.tmdbId === wanted));
    res.json(titles.map((title) => movieResource(title, true)));
  });

  router.get('/movie/lookup', async (req, res) => {
    const match = /^tmdb:([1-9]\d{0,9})$/.exec(typeof req.query.term === 'string' ? req.query.term : '');
    if (!match) return notSupported(res, 'Use the term tmdb:<ID> to look up a movie.');
    const id = Number(match[1]);
    const known = own(id);
    if (known) return void res.json([movieResource(known, true)]);
    if (!deps.tmdb) return noTmdb(res);
    try {
      res.json([movieResource(candidate(await deps.tmdb.details('movie', id)), false)]);
    } catch (error) {
      if (error instanceof TmdbError && error.code === 'not_found') return void res.json([]);
      tmdbProblem(res, error);
    }
  });

  router.get('/movie/:id', (req, res) => {
    const title = own(parseId(req.params.id));
    if (!title) return notFound(res, 'No movie has this ID.');
    res.json(movieResource(title, true));
  });

  router.post('/movie', async (req, res) => {
    const body = isObject(req.body) ? req.body : {};
    if (!deps.tmdb) return noTmdb(res);
    const errors: [string, string][] = [];
    const tmdbId = body.tmdbId;
    if (typeof tmdbId !== 'number' || !Number.isInteger(tmdbId) || tmdbId < 1) errors.push(['tmdbId', 'The TMDB ID must be a whole number from 1.']);
    const placement = readPlacement('movie', body);
    if ('errors' in placement) errors.push(...placement.errors);
    const options = readOptions(body, ['searchForMovie']);
    if ('errors' in options) errors.push(...options.errors);
    const availabilityNeed = body.minimumAvailability ?? 'released';
    if (!MINIMUM.includes(availabilityNeed as string)) errors.push(['minimumAvailability', 'Only released and announced are supported.']);
    if (errors.length) return refuse(res, errors);
    const { preset, root, monitored } = placement as Exclude<typeof placement, { errors: unknown }>;

    let title: Title;
    try {
      ({ title } = await addTitle({ tmdb: deps.tmdb, enqueue: deps.enqueue }, { mediaType: 'movie', tmdbId: tmdbId as number, mode: monitored ? 'all' : 'paused', seriesType: 'standard', preset, rootId: root.id }));
    } catch (error) {
      if (error instanceof AddError) return refuse(res, [['tmdbId', 'This movie has already been added.']]);
      if (error instanceof TmdbError && error.code === 'not_found') return refuse(res, [['tmdbId', 'TMDB has no movie with this ID.']]);
      return tmdbProblem(res, error);
    }
    title.manualRelease = availabilityNeed === 'announced';
    if ((options as { search: boolean }).search && monitored) deps.enqueue({ type: 'queue.initial', payload: { key: title.key }, dedupeKey: `initial:${title.key}` });
    await db.write();
    deps.events.publish('library.changed', { key: title.key });
    res.status(201).json(movieResource(title, true));
  });

  // Seerr sends the whole movie that the lookup gave, with its changes. ladarr reads the fields that it can change.
  // The addOptions of this call are ignored. A caller that wants a search sends the command MoviesSearch.
  router.put('/movie', async (req, res) => {
    const body = isObject(req.body) ? req.body : {};
    const title = own(typeof body.id === 'number' ? body.id : undefined);
    if (!title) return notFound(res, 'No movie has this ID.');
    const placement = readPlacement('movie', body);
    if ('errors' in placement) return refuse(res, placement.errors);
    const need = body.minimumAvailability ?? 'released';
    if (!MINIMUM.includes(need as string)) return refuse(res, [['minimumAvailability', 'Only released and announced are supported.']]);
    if (placement.root.id !== title.rootId && hasFiles(title)) return refuse(res, [['rootFolderPath', 'The files of a movie do not move to another root folder.']]);
    title.rootId = placement.root.id;
    title.preset = placement.preset;
    title.paused = !placement.monitored;
    title.manualRelease = need === 'announced';
    await db.write();
    deps.events.publish('library.changed', { key: title.key });
    res.status(202).json(movieResource(title, true));
  });

  // ladarr removes the record only. Radarr callers ask to delete the files too, so ladarr refuses the call.
  router.delete('/movie/:id', (_req, res) => notSupported(res, 'A movie cannot be removed through this API. Delete it in the app.'));

  return router;
}

// The Radarr API on port 7878. A caller adds /api/v3, as with Radarr.
export function radarr(options: AdapterOptions) {
  const app = express();
  app.disable('x-powered-by');
  app.use('/api/v3', adapter('radarr', { ...options, urlBase: '' }), onError);
  app.use(notFoundPath('/api/v3'));
  return app;
}
