import { statfs } from 'node:fs/promises';
import { Router, type RequestHandler } from 'express';
import { safeEqual } from '../core/auth.ts';
import { isObject, notFound, notSupported, parseId, profiles, refuse, rootNumber, rootsOf, timespan, type CompatCommand, type CompatDeps } from './common.ts';
import { radarrRoutes } from './radarr.ts';
import { sonarrRoutes } from './sonarr.ts';
import { type Db, db } from '../core/db.ts';
import { APP_MEDIA, type IndexerApp } from '../library/grab/indexers.ts';
import type { SearchPayload } from '../library/grab/finder.ts';
import type { QueueEntry } from '../library/downloads/queue.ts';

const KEPT_COMMANDS = 100;
const REFRESH = 'RefreshMonitoredDownloads';
const SEARCH: Record<IndexerApp, string> = { radarr: 'MoviesSearch', sonarr: 'MissingEpisodeSearch' };

// The adapters take the API key in the header X-Api-Key or in the query parameter apikey. Seerr uses the query parameter.
export const adapterAuth = (): RequestHandler => {
  return (req, res, next) => {
    const sent = req.get('x-api-key') ?? (typeof req.query.apikey === 'string' ? req.query.apikey : undefined);
    if (sent && db.data.apiKey && safeEqual(sent, db.data.apiKey)) return next();
    res.status(401).json({ message: 'Unauthorized', detail: 'The API key is missing or wrong. Send it in the X-Api-Key header or in the apikey query parameter.' });
  };
};

// The last handler of an adapter: any call that ladarr does not cover.
export const unsupported: RequestHandler = (req, res) => notSupported(res, `${req.method} ${req.path} is not supported.`);

// A path outside /sonarr/api/v3 and /radarr/api/v3. The answer names the paths, so a wrong URL base is easy to find.
export const wrongPath = (urlBase: string): RequestHandler => (_req, res) =>
  void res.status(404).json({ message: 'NotFound', detail: `Use ${urlBase}/sonarr/api/v3 for a Sonarr caller and ${urlBase}/radarr/api/v3 for a Radarr caller.` });

// Moves the command to its end when every search job that it started has ended. A job that completed is gone from the job queue.
function settle(command: CompatCommand) {
  if (command.status === 'completed' || command.status === 'failed') return;
  const jobs = command.jobs.flatMap((id) => db.data.jobs[id] ?? []);
  const live = jobs.filter((job) => job.state !== 'failed');
  if (live.length) {
    command.status = live.some((job) => job.state === 'running') ? 'started' : 'queued';
    return;
  }
  // A job that failed makes the command fail. A search with no answer from the indexers ends without an error, and the queue entry shows the cause.
  const failed = jobs.some((job) => job.state === 'failed');
  command.status = failed ? 'failed' : 'completed';
  command.endedAt = Date.now();
  if (failed) command.message = 'The search failed.';
}

function commandResource(command: CompatCommand) {
  settle(command);
  return {
    id: command.id,
    name: command.name,
    body: command.body,
    status: command.status,
    result: command.status === 'completed' ? 'successful' : command.status === 'failed' ? 'unsuccessful' : 'unknown',
    message: command.message ?? undefined,
    queued: new Date(command.queuedAt).toISOString(),
    ended: command.endedAt ? new Date(command.endedAt).toISOString() : undefined,
    trigger: 'manual',
  };
}

const QUEUE_STAGES: QueueEntry['stage'][] = ['fetching', 'sending', 'downloading', 'validating', 'importing'];

export function compatRouter(app: IndexerApp, deps: CompatDeps) {
  const router = Router();
  const mediaType = APP_MEDIA[app];

  router.get('/qualityProfile', (_req, res) => void res.json(profiles()));

  router.get('/rootfolder', async (_req, res) => {
    res.json(
      await Promise.all(
        rootsOf(mediaType).map(async (root) => {
          const space = await statfs(root.path).catch(() => undefined);
          return { id: rootNumber(root.id), path: root.path, accessible: Boolean(space), ...(space ? { freeSpace: Number(space.bavail) * Number(space.bsize), totalSpace: Number(space.blocks) * Number(space.bsize) } : {}) };
        }),
      ),
    );
  });

  // ladarr has no tags. The list is empty, and a call that makes or renames a tag gets the fallback answer.
  router.get('/tag', (_req, res) => void res.json([]));

  // The entries that are on their way to the library. A pack shows the size of the whole torrent on each entry, like Sonarr.
  router.get('/queue', (req, res) => {
    const { poller } = deps.services ?? {};
    const page = parseId(req.query.page) ?? 1;
    const pageSize = parseId(req.query.pageSize);
    const withEpisode = req.query.includeEpisode === 'true';
    const entries = Object.values(db.data.queue).filter((entry) => QUEUE_STAGES.includes(entry.stage) && entry.branch !== 'cancelled' && db.data.titles[entry.titleKey]?.mediaType === mediaType);
    const records = entries.map((entry) => {
      const title = db.data.titles[entry.titleKey]!;
      const transfer = entry.transferHash ? poller?.transfer(entry.transferHash) : undefined;
      const size = transfer?.sizeBytes ?? entry.release?.sizeBytes ?? 0;
      const done = entry.stage === 'validating' || entry.stage === 'importing';
      const left = done ? 0 : transfer ? Math.round(size * (1 - transfer.progress)) : size;
      const eta = !done && transfer?.etaSeconds != null ? transfer.etaSeconds : null;
      const episode = entry.season === null ? undefined : title.episodes.find((item) => item.season === entry.season && item.number === entry.number);
      return {
        title: entry.release?.title,
        size,
        sizeleft: left,
        status: entry.branch === 'paused' ? 'paused' : entry.stage === 'fetching' || entry.stage === 'sending' ? 'queued' : done ? 'completed' : 'downloading',
        trackedDownloadStatus: entry.branch === null && entry.reason ? 'warning' : 'ok',
        trackedDownloadState: entry.stage === 'importing' ? 'importing' : done ? 'importPending' : 'downloading',
        ...(eta === null ? {} : { timeleft: timespan(eta), estimatedCompletionTime: new Date(Date.now() + eta * 1000).toISOString() }),
        downloadId: entry.transferHash?.toUpperCase(),
        protocol: 'torrent',
        indexer: entry.release?.indexerName,
        ...(app === 'radarr' ? { movieId: title.tmdbId } : { seriesId: title.tmdbId, ...(episode ? { episodeId: episode.tmdbId } : {}), ...(withEpisode && episode ? { episode: { id: episode.tmdbId, seriesId: title.tmdbId, seasonNumber: episode.season, episodeNumber: episode.number } } : {}) }),
      };
    });
    const shown = pageSize ? records.slice((page - 1) * pageSize, page * pageSize) : records;
    res.json({ page, pageSize: pageSize ?? records.length, totalRecords: records.length, records: shown });
  });

  router.post('/command', async (req, res) => {
    const body = isObject(req.body) ? req.body : {};
    const name = body.name;
    if (typeof name !== 'string') return refuse(res, [['name', 'Send the name of a command.']]);
    if (name !== REFRESH && name !== SEARCH[app]) return notSupported(res, `This path supports the commands ${REFRESH} and ${SEARCH[app]}.`);
    const { services } = deps;
    if (!services) return void res.status(503).json({ message: 'ServiceUnavailable', detail: 'The search and the download client are not running.' });

    // The command gets its ID and its place in the database before any wait, so two commands at the same time never share an ID.
    // The database keeps only the checked fields of the body, so a large body cannot fill it.
    const register = (commandBody: Record<string, unknown>) => {
      const command: CompatCommand = { id: ++db.data.compat.commandSeq, name, body: commandBody, queuedAt: Date.now(), endedAt: null, status: 'queued', message: null, entries: [], jobs: [] };
      db.data.compat.commands[command.id] = command;
      for (const old of Object.keys(db.data.compat.commands).map(Number).sort((a, b) => a - b).slice(0, -KEPT_COMMANDS)) delete db.data.compat.commands[old];
      return command;
    };

    let command: CompatCommand;
    if (name === REFRESH) {
      command = register({ name });
      // The poll runs now, so the queue that the caller reads next is current.
      try {
        await services.poller.tick();
        const state = services.poller.status().state;
        command.status = state === 'rejected' || state === 'unreachable' ? 'failed' : 'completed';
        if (command.status === 'failed') command.message = 'The download client does not answer.';
      } catch {
        command.status = 'failed';
        command.message = 'The poll of the download client failed.';
      }
      command.endedAt = Date.now();
    } else {
      const ids = app === 'radarr' ? body.movieIds : [body.seriesId];
      if (!Array.isArray(ids) || !ids.length || ids.length > 50 || !ids.every((id) => Number.isInteger(id) && id > 0)) {
        return refuse(res, [[app === 'radarr' ? 'movieIds' : 'seriesId', app === 'radarr' ? 'Send a list of movie IDs.' : 'Send a series ID.']]);
      }
      const keys = ids.map((id) => `${mediaType}:${id}`);
      const missing = keys.findIndex((key) => !db.data.titles[key]);
      if (missing >= 0) return notFound(res, `No ${app === 'radarr' ? 'movie' : 'series'} has the ID ${ids[missing]}.`);
      // A series without episodes has nothing to search. The command would end without a search, so ladarr refuses it.
      if (keys.some((key) => mediaType === 'tv' && !db.data.titles[key]!.episodesLoadedAt)) {
        return void res.status(409).json({ message: 'Conflict', detail: 'The episodes of this series are not loaded yet. Send the command again later.' });
      }
      command = register(app === 'radarr' ? { name, movieIds: ids } : { name, seriesId: ids[0] });
      for (const key of keys) {
        for (const entry of services.finder.requestSearch(key, { reason: 'search requested by an API caller', fresh: true })) command.entries.push(entry.id);
      }
      for (const job of Object.values(db.data.jobs)) {
        if (job.type === 'queue.search' && job.state !== 'failed' && (job.payload as SearchPayload).entryIds.some((id) => command.entries.includes(id))) command.jobs.push(job.id);
      }
      if (!command.entries.length) command.message = 'Nothing to search. The title is paused, not released, complete, or already in the queue.';
    }
    settle(command);
    await db.write();
    res.status(201).json(commandResource(command));
  });

  router.get('/command', (_req, res) => void res.json(Object.values(db.data.compat.commands).map((command) => commandResource(command))));

  router.get('/command/:id', (req, res) => {
    const command = db.data.compat.commands[parseId(req.params.id) ?? 0];
    if (!command) return notFound(res, 'No command has this ID.');
    res.json(commandResource(command));
  });

  router.use(app === 'radarr' ? radarrRoutes(deps) : sonarrRoutes(deps));
  return router;
}
