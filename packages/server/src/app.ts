import type { LogsResponse, SystemStatus, VersionInfo } from '@ladarr/shared/types';
import { readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import express, { type ErrorRequestHandler } from 'express';
import { authRouter, requireAuth } from './core/auth.ts';
import type { Db } from './core/db.ts';
import { backupRouter } from './system/backup.ts';
import { blocklistRouter } from './acquisition/blocklist.ts';
import { calendarRouter } from './calendar/calendar.ts';
import { feedTokenRouter, icalHandler } from './calendar/calendar-feed.ts';
import { bulkSearchRouter } from './calendar/calendar-search.ts';
import { restoreGate, restoreRouter, setupRestoreRouter, type Restorer } from './system/restore.ts';
import { adapterAuth, compatRouter, unsupported, wrongPath } from './integrations/compat.ts';
import { createEvents, type Events } from './core/events.ts';
import { indexersRouter, indexerManagerRouter } from './acquisition/indexers.ts';
import type { IndexerService } from './acquisition/torznab.ts';
import { clientsRouter, createClientCheck, type Clients } from './downloads/client-api.ts';
import { createImportStatus, type ImportStatus } from './library/import-status.ts';
import { importSourceRouter } from './library/import-source.ts';
import { manualImportRouter } from './library/manual-import.ts';
import { renameRouter } from './library/rename.ts';
import { collectProblems } from './system/health.ts';
import { collectAlerts } from './system/alerts.ts';
import { ffprobeAvailable } from './library/probe.ts';
import type { Finder } from './acquisition/finder.ts';
import type { Poller } from './downloads/poller.ts';
import { createRetry, queueRouter } from './downloads/queue-api.ts';
import type { Queue } from './downloads/queue.ts';
import { enqueue as enqueueJob, type EnqueueInput } from './core/jobs.ts';
import { libraryRouter } from './library/library-api.ts';
import { libraryToolsRouter } from './library/library-tools.ts';
import { setupChecks } from './system/setup-checks.ts';
import { APP_VERSION, checkForUpdate } from './system/version.ts';
import { migrationRouter } from './migration/migration.ts';
import { SourceError } from './migration/migration-source.ts';
import { log, recentLogs, traffic } from './core/log.ts';
import { withOutboundRequests } from './core/outbound.ts';
import { rootsRouter } from './library/roots.ts';
import { searchRouter } from './metadata/search.ts';
import { qualityRouter } from './acquisition/quality-api.ts';
import { settingsRouter } from './system/settings.ts';
import { TmdbError, type Tmdb } from './metadata/tmdb.ts';
import { webhookRouter } from './integrations/webhook.ts';

export type Services = { queue: Queue; finder: Finder; poller: Poller; clients: Clients; importStatus?: ImportStatus };

type Options = { services?: Services; urlBase?: string; events?: Events; webDir?: string; heartbeat?: () => number; tmdb?: Tmdb; configDir?: string; backupDir?: string; enqueue?: (input: EnqueueInput) => ReturnType<typeof enqueueJob>; cancelJob?: (id: string) => void; persist?: () => void; restorer?: Restorer; indexers?: IndexerService };

const HEARTBEAT_MAX_AGE_MS = 30_000;

const SOURCE_STATUS = {
  source_url_invalid: 400,
  source_unreachable: 502,
  source_key_rejected: 502,
  source_wrong_app: 400,
  source_version_unsupported: 400,
  source_invalid_response: 502,
  backup_invalid: 400,
  backup_unsupported: 400,
  backup_unsafe: 400,
  backup_too_large: 413,
  backup_no_database: 400,
  backup_database_invalid: 400,
} as const;

const PROVIDER_ERRORS = {
  not_found: { status: 404, error: 'not_found' },
  invalid_key: { status: 502, error: 'metadata_key_rejected' },
  rate_limited: { status: 503, error: 'metadata_unavailable' },
  unavailable: { status: 503, error: 'metadata_unavailable' },
} as const;

export function createApp(db: Db, { services, urlBase = '', events = createEvents(), webDir, heartbeat, tmdb, configDir, backupDir, enqueue = (input) => enqueueJob(db, input), cancelJob, persist, restorer, indexers }: Options = {}) {
  const api = express.Router();
  // A change of the indexers or of the clients can lift the block of a target. The target goes on, and the pages read the new state.
  const retries = services ? createRetry({ db, queue: services.queue, finder: services.finder, enqueue }) : undefined;
  const setupChanged = (kind: 'indexers' | 'clients') => {
    retries?.retryBlocked(kind === 'indexers' ? 'no_indexers' : 'client_missing');
    events.publish(`${kind}.changed`);
  };
  api.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  api.use(express.json({ limit: '100kb' }));
  if (restorer) api.use(restoreGate(restorer));
  api.get('/health', (_req, res) => {
    const workerOk = !heartbeat || Date.now() - heartbeat() < HEARTBEAT_MAX_AGE_MS;
    res.status(workerOk ? 200 : 503).json({ status: workerOk ? 'ok' : 'worker_stalled' });
  });
  api.use('/auth', authRouter(db));
  // The setup screen has no session, and a backup can take the place of the setup.
  if (backupDir && restorer) api.use('/setup', setupRestoreRouter({ restorer, db }));
  // The iCal feed has no session. Its token is the credential.
  api.get('/calendar/feed.ics', icalHandler(db));
  api.use(requireAuth(db));
  api.get('/events', events.handler);
  api.use('/search', searchRouter(tmdb, db));
  api.use('/calendar/feed', feedTokenRouter(db));
  api.use('/calendar', calendarRouter(db));
  if (services) api.use('/library/search', bulkSearchRouter({ db, finder: services.finder, enqueue }));
  api.use('/library', libraryToolsRouter(db, { tmdb, events, enqueue, queue: services?.queue, cancelJob }));
  api.use('/library', libraryRouter(db, { tmdb, events, enqueue, queue: services?.queue, cancelJob }));
  api.use('/settings', settingsRouter(db));
  api.use('/quality', qualityRouter(db));
  const importStatus = services?.importStatus ?? createImportStatus(events);
  api.use('/import/source', importSourceRouter({ db, tmdb, events, enqueue, status: importStatus, configDir }));
  api.use('/import', manualImportRouter({ db, enqueue, status: importStatus, configDir }));
  api.use('/rename', renameRouter({ db, enqueue, status: importStatus }));
  api.use('/webhook', webhookRouter(db));
  api.use('/indexers', indexersRouter(db, indexers, { onChange: () => setupChanged('indexers') }));
  api.use('/blocklist', blocklistRouter(db));
  api.use('/roots', rootsRouter(db, { configDir }));
  api.use('/migration', migrationRouter(db, { tmdb, events, enqueue }));
  if (backupDir && restorer) api.use('/backups', restoreRouter(restorer));
  if (backupDir) api.use('/backups', backupRouter(db, backupDir));
  const clientCheck = services ? createClientCheck(services.clients) : undefined;
  if (services) {
    api.use('/queue', queueRouter({ db, queue: services.queue, finder: services.finder, poller: services.poller, clients: services.clients, enqueue, persist, importStatus }));
    api.use('/clients', clientsRouter(db, { onChange: () => setupChanged('clients') }));
  }
  api.get('/system/status', async (_req, res) => {
    res.json({ problems: await collectProblems({ db, tmdb, heartbeat, backupDir, clientCheck, ffprobe: services ? ffprobeAvailable : undefined }) } satisfies SystemStatus);
  });
  api.get('/system/version', (_req, res) => {
    res.json({ version: APP_VERSION } satisfies VersionInfo);
  });
  api.get('/system/update', async (_req, res) => {
    try {
      res.json(await checkForUpdate());
    } catch (error) {
      log.warn('update check failed', { error });
      res.status(502).json({ error: 'update_unavailable' });
    }
  });
  api.get('/alerts', async (_req, res) => {
    res.json({ alerts: await collectAlerts({ db, tmdb, heartbeat, backupDir, clientCheck, ffprobe: services ? ffprobeAvailable : undefined }) });
  });
  api.get('/system/setup-checks', async (_req, res) => {
    res.json(await setupChecks(db, clientCheck));
  });
  api.get('/system/logs', async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
    const itemId = typeof req.query.itemId === 'string' ? req.query.itemId : undefined;
    const itemType = typeof req.query.itemType === 'string' ? req.query.itemType : undefined;
    const kind = req.query.kind === 'requests' ? 'requests' : 'logs';
    const type = req.query.type === 'catalog' ? 'catalog' : req.query.type === 'system' ? 'system' : undefined;
    const requestId = typeof req.query.requestId === 'string' ? req.query.requestId : undefined;
    res.json({ entries: await recentLogs(limit, { itemId, itemType, kind, type, requestId }) } satisfies LogsResponse);
  });
  api.use((_req, res) => void res.status(404).json({ error: 'not_found' }));

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err instanceof SourceError) return void res.status(SOURCE_STATUS[err.code]).json({ error: err.code, detail: err.detail });
    if (err instanceof TmdbError) return void res.status(PROVIDER_ERRORS[err.code].status).json({ error: PROVIDER_ERRORS[err.code].error });
    const status = typeof err.status === 'number' && err.status < 500 ? err.status : 500;
    if (status === 500) log.error('unhandled error', { error: err });
    res.status(status).json({ error: status === 500 ? 'internal_error' : 'bad_request' });
  };

  const app = express();
  app.disable('x-powered-by');
  // The requests that one call of the API sends belong to it, so its lines of the log link to them.
  app.use((_req, _res, next) => withOutboundRequests(next));
  app.use((req, res, next) => {
    // The path has no query string, so a key sent in the query never reaches the log of this middleware, or the quiet list.
    const path = req.originalUrl.split('?')[0];
    // A read of the log would log itself, and the tail of the log page would fill the file.
    const quiet = [`${urlBase}/api/health`, `${urlBase}/api/system/logs`];
    if (!quiet.includes(path)) {
      // The address goes in the log as it came, and redact() hides a key, a token, or a password in the query.
      const url = new URL(req.originalUrl, `${req.protocol}://${req.get('host') ?? 'localhost'}`).toString();
      res.on('finish', () => traffic.info('request', { direction: 'inbound', request: { method: req.method, url }, response: { status: res.statusCode } }));
    }
    next();
  });
  // Seerr and other callers use /api/v3 on their own. The answer names the right paths, because the native API would answer 401.
  app.use(`${urlBase}/api/v3`, wrongPath(urlBase));
  app.use(`${urlBase}/api`, api, onError);

  // The adapters for the indexer manager and Seerr. They use the API key and the shapes of Sonarr and Radarr.
  for (const name of ['sonarr', 'radarr'] as const) {
    const adapter = express.Router();
    adapter.use(adapterAuth(db), express.json({ limit: '100kb' }));
    if (restorer) adapter.use(restoreGate(restorer));
    adapter.use(indexerManagerRouter(db, name, { onChange: () => setupChanged('indexers'), urlBase }));
    adapter.use(compatRouter(db, name, { urlBase, tmdb, events, enqueue, services }));
    adapter.use(unsupported);
    app.use(`${urlBase}/${name}/api/v3`, adapter, onError);
    // Any other path under the adapter name gets a JSON answer. The page fallback below would answer with HTML.
    app.use(`${urlBase}/${name}`, wrongPath(urlBase));
  }
  // The same answers for the paths without the URL base. A path that the URL base itself starts with is not one of them.
  const clashes = (path: string) => urlBase === path || urlBase.startsWith(`${path}/`);
  if (urlBase) {
    for (const path of ['/sonarr', '/radarr', '/api/v3']) if (!clashes(path)) app.use(path, wrongPath(urlBase));
  }

  if (webDir) {
    // The page finds the API and its assets through this <base> tag, so one build serves any URL base.
    const indexHtml = readFileSync(join(webDir, 'index.html'), 'utf8').replace('<base href="/" />', `<base href="${urlBase}/" />`);
    app.use(urlBase || '/', express.static(webDir, { index: false }));
    app.use(urlBase || '/', (req, res, next) => {
      if (req.method !== 'GET' || extname(req.path)) return next();
      res.set('Cache-Control', 'no-cache').type('html').send(indexHtml);
    });
  }
  return app;
}
