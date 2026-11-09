import { readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import express, { type ErrorRequestHandler } from 'express';
import { requireAuth } from './core/auth.ts';
import { blocklistClear } from './routes/blocklist/delete.ts';
import { blocklistGet } from './routes/blocklist/get.ts';
import { blocklistRemove } from './routes/blocklist/[id]/delete.ts';
import { authApiKey } from './routes/auth/api-key/get.ts';
import { authRotateApiKey } from './routes/auth/api-key/rotate/post.ts';
import { authLogin } from './routes/auth/login/post.ts';
import { authLogout } from './routes/auth/logout/post.ts';
import { authSetup } from './routes/auth/setup/post.ts';
import { authStatus } from './routes/auth/status/get.ts';
import { jsonOnly } from './helpers/auth.ts';
import type { Db } from './core/db.ts';
import { alertsGet } from './routes/alerts/get.ts';
import { eventsGet } from './routes/events/get.ts';
import { healthGet } from './routes/health/get.ts';
import { systemLogs } from './routes/system/logs/get.ts';
import { systemSetupChecks } from './routes/system/setup-checks/get.ts';
import { systemStatus } from './routes/system/status/get.ts';
import { systemUpdateGet } from './routes/system/update/get.ts';
import { systemUpdatePost } from './routes/system/update/post.ts';
import { systemVersion } from './routes/system/version/get.ts';
import { backupsCreate } from './routes/backups/post.ts';
import { backupsGet } from './routes/backups/get.ts';
import { backupDelete } from './routes/backups/[name]/delete.ts';
import { backupDownload } from './routes/backups/[name]/download/get.ts';
import { backupRestoreSaved } from './routes/backups/[name]/restore/post.ts';
import { backupRestore } from './routes/backups/restore/post.ts';
import { backupName, sessionRequired } from './helpers/backups.ts';
import { migrationBackup } from './routes/migration/backup/post.ts';
import { migrationImport } from './routes/migration/import/post.ts';
import { migrationPreview } from './routes/migration/preview/post.ts';
import { migrationStatus } from './routes/migration/status/get.ts';
import { migrationTest } from './routes/migration/test/post.ts';
import { setupRestore } from './routes/setup/restore/post.ts';
import { calendarFeed } from './routes/calendar/feed.ics/get.ts';
import { calendarFeedTokenDelete } from './routes/calendar/feed/delete.ts';
import { calendarFeedTokenGet } from './routes/calendar/feed/get.ts';
import { calendarFeedTokenPost } from './routes/calendar/feed/post.ts';
import { calendarGet } from './routes/calendar/get.ts';
import { searchCast } from './routes/search/[mediaType]/[tmdbId]/cast/get.ts';
import { searchTitle } from './routes/search/[mediaType]/[tmdbId]/get.ts';
import { searchRecommendations } from './routes/search/[mediaType]/[tmdbId]/recommendations/get.ts';
import { searchSeasons } from './routes/search/[mediaType]/[tmdbId]/seasons/get.ts';
import { searchGet } from './routes/search/get.ts';
import { searchPerson } from './routes/search/person/[id]/get.ts';
import { searchTarget } from './helpers/search.ts';
import { settingsCompleteSetup } from './routes/settings/complete-setup/post.ts';
import { settingsGet } from './routes/settings/get.ts';
import { settingsPatch } from './routes/settings/patch.ts';
import { librarySearchStart } from './routes/library/search/post.ts';
import { librarySearchPreview } from './routes/library/search/preview/post.ts';
import { restoreGate, type Restorer } from './system/restore.ts';
import { adapterAuth, compatRouter, unsupported, wrongPath } from './compatibility/router.ts';
import { seerrRouter, seerrWrongPath } from './compatibility/seerr.ts';
import { createEvents, type Events } from './core/events.ts';
import { indexersGet } from './routes/indexers/get.ts';
import { indexersCreate } from './routes/indexers/post.ts';
import { indexersTest } from './routes/indexers/test/post.ts';
import { indexerKeyGet } from './routes/indexers/[id]/key/get.ts';
import { indexerTestSaved } from './routes/indexers/[id]/test/post.ts';
import { indexersUpdate } from './routes/indexers/[id]/put.ts';
import { indexersPatch } from './routes/indexers/[id]/patch.ts';
import { indexersDelete } from './routes/indexers/[id]/delete.ts';
import { indexerSystemStatus } from './routes/indexers/adapter/system/status/get.ts';
import { indexerSchemaGet } from './routes/indexers/adapter/indexer/schema/get.ts';
import { indexerListGet } from './routes/indexers/adapter/indexer/get.ts';
import { indexerGet } from './routes/indexers/adapter/indexer/[id]/get.ts';
import { indexerTest } from './routes/indexers/adapter/indexer/test/post.ts';
import { indexerCreate } from './routes/indexers/adapter/indexer/post.ts';
import { indexerUpdate } from './routes/indexers/adapter/indexer/[id]/put.ts';
import { indexerDelete } from './routes/indexers/adapter/indexer/[id]/delete.ts';
import { adapterHeaders } from './helpers/indexers-adapter.ts';
import type { IndexerService } from './library/grab/torznab.ts';
import { createClientCheck, type Clients } from './library/downloads/client-api.ts';
import { clientsGet } from './routes/clients/get.ts';
import { clientsCreate } from './routes/clients/post.ts';
import { clientsTest } from './routes/clients/test/post.ts';
import { clientsTestSaved } from './routes/clients/[id]/test/post.ts';
import { clientsUpdate } from './routes/clients/[id]/put.ts';
import { clientsDelete } from './routes/clients/[id]/delete.ts';
import { createImportStatus, type ImportStatus } from './library/imports/status.ts';
import { importFolderPreview } from './routes/import/folder/preview/post.ts';
import { importFolderStart } from './routes/import/folder/post.ts';
import { importRunGet } from './routes/import/runs/[id]/get.ts';
import { importSourceDetect } from './routes/import/source/detect/post.ts';
import { importSourceStart } from './routes/import/source/post.ts';
import { importSourcePreview } from './routes/import/source/preview/post.ts';
import { renameApply } from './routes/rename/apply/post.ts';
import { renameExamples } from './routes/rename/examples/post.ts';
import { renameOverview } from './routes/rename/overview/post.ts';
import { renamePreview } from './routes/rename/preview/post.ts';
import { ffprobeAvailable } from './library/probe.ts';
import type { Finder } from './library/grab/finder.ts';
import type { Poller } from './library/downloads/poller.ts';
import { createRetry } from './library/downloads/queue-api.ts';
import { createAttachCache } from './helpers/queue-attach.ts';
import { queueEntryAttachPost } from './routes/queue/entries/[id]/attach/post.ts';
import { queueEntryClientGet } from './routes/queue/entries/[id]/client/get.ts';
import { queueEntryExternalGet } from './routes/queue/entries/[id]/external/get.ts';
import { queueActionsPost } from './routes/queue/actions/post.ts';
import { queueEntryGet } from './routes/queue/entries/[id]/get.ts';
import { queueEntryFilesGet } from './routes/queue/entries/[id]/files/get.ts';
import { queueEntryMatchPost } from './routes/queue/entries/[id]/match/post.ts';
import { queueEntryReleaseGrabPost } from './routes/queue/entries/[id]/releases/grab/post.ts';
import { queueGet } from './routes/queue/get.ts';
import { queueGroupGet } from './routes/queue/groups/[titleKey]/get.ts';
import { queueJobDelete } from './routes/queue/jobs/[id]/delete.ts';
import { queueJobPriorityPost } from './routes/queue/jobs/[id]/priority/post.ts';
import { queueJobRunPost } from './routes/queue/jobs/[id]/run/post.ts';
import { queueJobsGet } from './routes/queue/jobs/get.ts';
import { queuePausePost } from './routes/queue/pause/post.ts';
import { queueRecentGet } from './routes/queue/recent/get.ts';
import { queueReleaseGrabPost } from './routes/queue/releases/grab/post.ts';
import { queueReleasesGet } from './routes/queue/releases/get.ts';
import { queueSearchPost } from './routes/queue/search/post.ts';
import { queueSummaryGet } from './routes/queue/summary/get.ts';
import type { Queue } from './library/downloads/queue.ts';
import { enqueue as enqueueJob, type EnqueueInput } from './core/jobs.ts';
import { titleParam } from './helpers/library.ts';
import { libraryGet } from './routes/library/get.ts';
import { libraryAdd } from './routes/library/post.ts';
import { libraryTitleGet } from './routes/library/[key]/get.ts';
import { libraryUpgrades } from './routes/library/[key]/upgrades/get.ts';
import { libraryTitleUpdate } from './routes/library/[key]/patch.ts';
import { libraryTitleDelete } from './routes/library/[key]/delete.ts';
import { libraryRefresh } from './routes/library/[key]/refresh/post.ts';
import { libraryRescan } from './routes/library/[key]/rescan/post.ts';
import { libraryEpisodes } from './routes/library/[key]/episodes/get.ts';
import { librarySeasonUpdate } from './routes/library/[key]/seasons/[season]/patch.ts';
import { libraryEpisodeUpdate } from './routes/library/[key]/episodes/[season]/[number]/patch.ts';
import { libraryToolsRouter } from './library/tools/tools.ts';
import { SourceError } from './migration/migration-source.ts';
import { log, traffic } from './core/log.ts';
import { withOutboundRequests } from './core/outbound.ts';
import { rootsAcceptMount } from './routes/roots/[id]/accept-mount/post.ts';
import { rootsDelete } from './routes/roots/[id]/delete.ts';
import { rootsUpdate } from './routes/roots/[id]/patch.ts';
import { rootsBrowse } from './routes/roots/browse/get.ts';
import { rootsCheck } from './routes/roots/check/post.ts';
import { rootsGet } from './routes/roots/get.ts';
import { rootsCreate } from './routes/roots/post.ts';
import { qualityGet } from './routes/quality/get.ts';
import { qualityOrderPut } from './routes/quality/order/put.ts';
import { qualityProfileDelete } from './routes/quality/profiles/[id]/delete.ts';
import { qualityProfileUpdate } from './routes/quality/profiles/[id]/put.ts';
import { qualityProfileCreate } from './routes/quality/profiles/post.ts';
import { qualitySizesPut } from './routes/quality/sizes/[quality]/put.ts';
import { TmdbError, type Tmdb } from './metadata/tmdb.ts';
import { webhookDelete } from './routes/webhook/[id]/delete.ts';
import { webhookUpdate } from './routes/webhook/[id]/put.ts';
import { webhookTestSaved } from './routes/webhook/[id]/test/post.ts';
import { webhookGet } from './routes/webhook/get.ts';
import { webhookCreate } from './routes/webhook/post.ts';
import { webhookTest } from './routes/webhook/test/post.ts';

export type Services = { queue: Queue; finder: Finder; poller: Poller; clients: Clients; importStatus?: ImportStatus };

type Options = { services?: Services; urlBase?: string; events?: Events; webDir?: string; heartbeat?: () => number; tmdb?: Tmdb; configDir?: string; backupDir?: string; enqueue?: (input: EnqueueInput) => ReturnType<typeof enqueueJob>; cancelJob?: (id: string) => void; persist?: () => void; restorer?: Restorer; indexers?: IndexerService; installUpdate?: () => Promise<{ version: string }>; pauseQueue?: () => Promise<void>; resumeQueue?: () => void; restart?: () => void };


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

export function createApp(db: Db, { services, urlBase = '', events = createEvents(), webDir, heartbeat, tmdb, configDir, backupDir, enqueue = (input) => enqueueJob(db, input), cancelJob, persist, restorer, indexers, installUpdate, pauseQueue, resumeQueue, restart }: Options = {}) {
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
  api.get('/health', healthGet(heartbeat));
  api.get('/auth/status', authStatus(db));
  api.post('/auth/setup', jsonOnly, authSetup(db));
  api.post('/auth/login', jsonOnly, authLogin(db));
  api.post('/auth/logout', requireAuth(db), authLogout(db));
  // Only the owner session reads or rotates the key. The key cannot do it for itself.
  const sessionOnly = requireAuth(db, { allowApiKey: false });
  api.get('/auth/api-key', sessionOnly, authApiKey(db));
  api.post('/auth/api-key/rotate', sessionOnly, authRotateApiKey(db));
  // The setup screen has no session, and a backup can take the place of the setup.
  if (backupDir && restorer) api.post('/setup/restore', setupRestore(restorer, db));
  // The iCal feed has no session. Its token is the credential.
  api.get('/calendar/feed.ics', calendarFeed(db));
  api.use(requireAuth(db));
  api.get('/events', eventsGet(events));
  const searchTargetHandler = searchTarget(tmdb);
  api.get('/search', searchGet(tmdb, db));
  api.get('/search/person/:id', searchPerson(tmdb, db));
  api.get('/search/:mediaType/:tmdbId', searchTargetHandler, searchTitle(tmdb, db));
  api.get('/search/:mediaType/:tmdbId/seasons', searchTargetHandler, searchSeasons(tmdb));
  api.get('/search/:mediaType/:tmdbId/cast', searchTargetHandler, searchCast(tmdb));
  api.get('/search/:mediaType/:tmdbId/recommendations', searchTargetHandler, searchRecommendations(tmdb, db));
  const feedTokenOnly = requireAuth(db, { allowApiKey: false });
  api.get('/calendar/feed', feedTokenOnly, calendarFeedTokenGet(db));
  api.post('/calendar/feed', feedTokenOnly, calendarFeedTokenPost(db));
  api.delete('/calendar/feed', feedTokenOnly, calendarFeedTokenDelete(db));
  api.get('/calendar', calendarGet(db));
  if (services) {
    api.post('/library/search/preview', librarySearchPreview(db, services.finder));
    api.post('/library/search', librarySearchStart(enqueue));
  }
  api.use('/library', libraryToolsRouter(db, { tmdb, events, enqueue, queue: services?.queue, cancelJob }));
  api.get('/library', libraryGet(db));
  api.post('/library', libraryAdd(db, { tmdb, events, enqueue }));
  api.get('/library/:key', titleParam(db), libraryTitleGet(db));
  api.get('/library/:key/upgrades', titleParam(db), libraryUpgrades(db));
  api.patch('/library/:key', titleParam(db), libraryTitleUpdate(db, { events, enqueue }));
  api.delete('/library/:key', titleParam(db), libraryTitleDelete(db, { events, queue: services?.queue, cancelJob }));
  api.post('/library/:key/refresh', titleParam(db), libraryRefresh({ tmdb, enqueue }));
  api.post('/library/:key/rescan', titleParam(db), libraryRescan({ enqueue }));
  api.get('/library/:key/episodes', titleParam(db), libraryEpisodes(db));
  api.patch('/library/:key/seasons/:season', titleParam(db), librarySeasonUpdate(db, { events }));
  api.patch('/library/:key/episodes/:season/:number', titleParam(db), libraryEpisodeUpdate(db, { events }));
  api.get('/settings', settingsGet(db));
  api.patch('/settings', settingsPatch(db));
  api.post('/settings/complete-setup', settingsCompleteSetup(db));
  api.get('/quality', qualityGet(db));
  api.post('/quality/profiles', qualityProfileCreate(db));
  api.put('/quality/order', qualityOrderPut(db));
  api.put('/quality/profiles/:id', qualityProfileUpdate(db));
  api.delete('/quality/profiles/:id', qualityProfileDelete(db));
  api.put('/quality/sizes/:quality', qualitySizesPut(db));
  const importStatus = services?.importStatus ?? createImportStatus(events);
  api.post('/import/source/detect', importSourceDetect(db, { tmdb, configDir }));
  api.post('/import/source/preview', importSourcePreview(db, { tmdb, configDir }));
  api.post('/import/source', importSourceStart(db, { tmdb, events, enqueue, status: importStatus, configDir }));
  api.post('/import/folder/preview', importFolderPreview(db, { configDir }));
  api.post('/import/folder', importFolderStart(db, { enqueue, status: importStatus, configDir }));
  api.get('/import/runs/:id', importRunGet(db, importStatus));
  api.post('/rename/examples', renameExamples());
  api.post('/rename/preview', renamePreview(db));
  api.post('/rename/overview', renameOverview(db));
  api.post('/rename/apply', renameApply(db, { enqueue, status: importStatus }));
  api.get('/webhook', webhookGet(db));
  api.post('/webhook', webhookCreate(db));
  api.put('/webhook/:id', webhookUpdate(db));
  api.delete('/webhook/:id', webhookDelete(db));
  api.post('/webhook/test', webhookTest());
  api.post('/webhook/:id/test', webhookTestSaved(db));
  api.get('/indexers', indexersGet(db));
  api.get('/indexers/:id/key', indexerKeyGet(db));
  api.post('/indexers', indexersCreate(db, { onChange: () => setupChanged('indexers') }));
  if (indexers) {
    api.post('/indexers/test', indexersTest(indexers));
    api.post('/indexers/:id/test', indexerTestSaved(db, indexers));
  }
  api.put('/indexers/:id', indexersUpdate(db, { onChange: () => setupChanged('indexers') }));
  api.patch('/indexers/:id', indexersPatch(db));
  api.delete('/indexers/:id', indexersDelete(db, { onChange: () => setupChanged('indexers') }));
  api.get('/blocklist', blocklistGet(db));
  api.delete('/blocklist', blocklistClear(db));
  api.delete('/blocklist/:id', blocklistRemove(db));
  api.get('/roots', rootsGet(db));
  api.get('/roots/browse', rootsBrowse());
  api.post('/roots/check', rootsCheck(db, { configDir }));
  api.post('/roots', rootsCreate(db, { configDir }));
  api.patch('/roots/:id', rootsUpdate(db, { configDir }));
  api.post('/roots/:id/accept-mount', rootsAcceptMount(db));
  api.delete('/roots/:id', rootsDelete(db));
  api.post('/migration/test', migrationTest());
  api.post('/migration/backup', migrationBackup());
  api.post('/migration/preview', migrationPreview(db, tmdb));
  api.post('/migration/import', migrationImport(db, enqueue));
  api.get('/migration/status', migrationStatus(db));
  if (backupDir && restorer) {
    api.post('/backups/restore', sessionRequired, backupRestore(restorer));
    api.post('/backups/:name/restore', sessionRequired, backupName, backupRestoreSaved(restorer));
  }
  if (backupDir) {
    api.get('/backups', backupsGet(backupDir));
    api.post('/backups', backupsCreate(db, backupDir));
    api.get('/backups/:name/download', backupName, backupDownload(backupDir));
    api.delete('/backups/:name', backupName, backupDelete(backupDir));
  }
  const clientCheck = services ? createClientCheck(services.clients) : undefined;
  if (services) {
    api.get('/queue/summary', queueSummaryGet(db, services.poller));
    api.post('/queue/pause', queuePausePost(services.queue));
    api.get('/queue/jobs', queueJobsGet(db, services.finder));
    api.post('/queue/jobs/:id/priority', queueJobPriorityPost(db, persist));
    api.post('/queue/jobs/:id/run', queueJobRunPost(db, persist));
    api.delete('/queue/jobs/:id', queueJobDelete(db, services.queue, persist));
    api.get('/queue', queueGet(db, services.poller, importStatus));
    api.get('/queue/groups/:titleKey', queueGroupGet(db, services.poller, importStatus));
    api.get('/queue/recent', queueRecentGet(db, services.poller, importStatus));
    api.get('/queue/entries/:id', queueEntryGet(db, services.poller, importStatus));
    api.post('/queue/search', queueSearchPost(db, services.finder));
    api.get('/queue/releases', queueReleasesGet(db, services.finder));
    api.post('/queue/releases/grab', queueReleaseGrabPost(db, services.queue, services.finder));
    api.post('/queue/entries/:id/releases/grab', queueEntryReleaseGrabPost(db, services.queue, services.finder));
    api.post('/queue/actions', queueActionsPost(db, services.queue, services.finder, services.poller, services.clients, enqueue));
    api.get('/queue/entries/:id/files', queueEntryFilesGet(db, services.clients));
    api.post('/queue/entries/:id/match', queueEntryMatchPost(db, services.queue, services.finder, services.clients, enqueue));
    const attachCache = createAttachCache();
    api.get('/queue/entries/:id/client', queueEntryClientGet(db, services.clients, attachCache));
    api.get('/queue/entries/:id/external', queueEntryExternalGet(db, services.clients));
    api.post('/queue/entries/:id/attach', queueEntryAttachPost(db, services.queue, services.clients));
    api.get('/clients', clientsGet(db));
    api.post('/clients', clientsCreate(db, { onChange: () => setupChanged('clients') }));
    api.post('/clients/test', clientsTest());
    api.post('/clients/:id/test', clientsTestSaved(db));
    api.put('/clients/:id', clientsUpdate(db, { onChange: () => setupChanged('clients') }));
    api.delete('/clients/:id', clientsDelete(db, { onChange: () => setupChanged('clients') }));
  }
  const healthSources = { tmdb, heartbeat, backupDir, clientCheck, ffprobe: services ? ffprobeAvailable : undefined };
  api.get('/system/status', systemStatus(db, healthSources));
  api.get('/system/version', systemVersion());
  api.get('/system/update', systemUpdateGet());
  api.post('/system/update', systemUpdatePost({ installUpdate, pauseQueue, resumeQueue, restart }));
  api.get('/alerts', alertsGet(db, healthSources));
  api.get('/system/setup-checks', systemSetupChecks(db, clientCheck));
  api.get('/system/logs', systemLogs());
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
  // A Seerr client adds /api/v1 to the address. The adapter lives under /seerr.
  app.use(`${urlBase}/api/v1`, seerrWrongPath(urlBase));
  app.use(`${urlBase}/api`, api, onError);

  // The adapters for the indexer manager and Seerr. They use the API key and the shapes of Sonarr and Radarr.
  for (const name of ['sonarr', 'radarr'] as const) {
    const adapter = express.Router();
    adapter.use(adapterAuth(db), express.json({ limit: '100kb' }));
    adapter.use(adapterHeaders(name));
    if (restorer) adapter.use(restoreGate(restorer));
    adapter.get('/system/status', indexerSystemStatus(name, { urlBase }));
    adapter.get('/indexer/schema', indexerSchemaGet(name));
    adapter.get('/indexer', indexerListGet(db, name));
    adapter.get('/indexer/:id', indexerGet(db, name));
    adapter.post('/indexer/test', indexerTest(name));
    adapter.post('/indexer', indexerCreate(db, name, { onChange: () => setupChanged('indexers') }));
    adapter.put('/indexer/:id', indexerUpdate(db, name, { onChange: () => setupChanged('indexers') }));
    adapter.delete('/indexer/:id', indexerDelete(db, name, { onChange: () => setupChanged('indexers') }));
    adapter.use(compatRouter(db, name, { urlBase, tmdb, events, enqueue, services }));
    adapter.use(unsupported);
    app.use(`${urlBase}/${name}/api/v3`, adapter, onError);
    // Any other path under the adapter name gets a JSON answer. The page fallback below would answer with HTML.
    app.use(`${urlBase}/${name}`, wrongPath(urlBase));
  }

  const seerr = express.Router();
  seerr.use(express.json({ limit: '100kb' }));
  if (restorer) seerr.use(restoreGate(restorer));
  seerr.use(seerrRouter(db, { urlBase, tmdb, events, enqueue, services }));
  app.use(`${urlBase}/seerr/api/v1`, seerr, onError);
  app.use(`${urlBase}/seerr`, seerrWrongPath(urlBase));

  // The same answers for the paths without the URL base. A path that the URL base itself starts with is not one of them.
  const clashes = (path: string) => urlBase === path || urlBase.startsWith(`${path}/`);
  if (urlBase) {
    for (const path of ['/sonarr', '/radarr', '/api/v3', '/seerr', '/api/v1']) {
      if (clashes(path)) continue;
      app.use(path, path === '/seerr' || path === '/api/v1' ? seerrWrongPath(urlBase) : wrongPath(urlBase));
    }
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
