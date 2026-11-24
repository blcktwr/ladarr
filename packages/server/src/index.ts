import { existsSync, unlinkSync } from 'node:fs';
import type { Server } from 'node:http';
import { dirname } from 'node:path';
import { loadConfig, ports } from '@ladarr/shared/config';
import { createApp } from './app.ts';
import { createClients } from './library/downloads/client-api.ts';
import { createImportStatus } from './library/imports/status.ts';
import { createFinder } from './library/grab/finder.ts';
import { unfinishedImports } from './library/imports/importer.ts';
import { createLimiter } from './core/limiter.ts';
import { createPoller } from './library/downloads/poller.ts';
import { createQueue } from './library/downloads/queue.ts';
import { enqueueUpload, uploadHash } from './library/downloads/upload.ts';
import { createIndexerService } from './library/grab/torznab.ts';
import { UpdateError, installUpdate } from './system/update.ts';
import { SCHEMA_VERSION, createSaver, db, open } from './core/db.ts';
import { createEvents } from './core/events.ts';
import { sonarr } from './proxy/sonarr.ts';
import { radarr } from './proxy/radarr.ts';
import { seerr } from './proxy/seerr.ts';
import { closeLog, configureItemLogs, log, logToFile } from './core/log.ts';
import { createRestorer } from './system/restore.ts';
import { firstUnwritable } from './core/permissions.ts';
import { UPDATE_EXIT_CODE } from './system/exit.ts';
import { createTmdb } from './metadata/tmdb.ts';
import { createWebhooks } from './core/webhook.ts';
import { createWorker } from './core/worker.ts';
import { withOutboundRequests } from './core/outbound.ts';
import { jobHandlers } from './jobs/index.ts';

const config = loadConfig();
// The log is a file, so the console is the only place that can say why the start failed.
const blocked = firstUnwritable([config.configDir, config.dbFile, config.queueFile, dirname(config.logFile), config.logFile]);
if (blocked) {
  console.error(`Cannot write to ${blocked}. The server runs as user ${process.getuid?.()} and group ${process.getgid?.()}. Give this user write access to the path.`);
  process.exit(1);
}
logToFile(config.logFile);
await open();
// An older version must not write to a file of a newer version. It could lose data that it does not know.
if (db.data.schemaVersion > SCHEMA_VERSION) {
  console.error(`The data file ${config.dbFile} has schema version ${db.data.schemaVersion}. This version reads schema version ${SCHEMA_VERSION} at most. Start a newer version, or restore a backup from this version.`);
  process.exit(1);
}
// Only the update bundle contains this file. Remove it after saving so a normal restart keeps a manual pause.
const resumeAfterUpdate = new URL('../../../.resume-queue', import.meta.url);
if (existsSync(resumeAfterUpdate)) {
  db.data.queuePaused = false;
  await db.write();
  unlinkSync(resumeAfterUpdate);
}
// The log of each target in the queue has a file of its own, as the settings say.
configureItemLogs();
const events = createEvents();

const tmdb = config.tmdbApiKey ? createTmdb({ apiKey: config.tmdbApiKey, baseUrl: config.tmdbBaseUrl }) : undefined;
if (!tmdb) log.warn('No TMDB key is in this build, so titles cannot be searched');
// Not awaited: the server starts at once, and the status shows the result when it arrives.
else void withOutboundRequests(() => tmdb.check().then(({ ok, code }) => ok || log.warn('TMDB check failed', { code })));

const save = createSaver();
const persist = () => save().catch((error) => log.error('could not save the database', { error }));
const clients = createClients();
const webhooks = createWebhooks({
  enqueue: (input) => worker.enqueue(input),
});
const queue = createQueue(events, persist, webhooks.onState);
const limiter = createLimiter(persist);
const indexers = createIndexerService(limiter, {}, persist);
const finder = createFinder({ queue, indexers, enqueue: (input) => worker.enqueue(input), clients });
const poller = createPoller({ queue, events, clients, enqueue: (input) => worker.enqueue(input) });
const importStatus = createImportStatus(events);
const worker = createWorker(
  save,
  jobHandlers({ backupDir: config.backupDir, events, save, tmdb, enqueue: (input) => worker.enqueue(input), clients, queue, finder, indexers, importStatus }),
);
worker.start();
poller.start();
// An import that stopped in the middle runs again. Its journal says where to go on.
for (const hash of unfinishedImports()) worker.enqueue({ type: 'import.run', payload: { hash }, dedupeKey: `import:${hash}` });
// A local import has no journal. A target that stopped in one has no torrent to resume, so the folder is read again.
const local = new Set(Object.values(db.data.queue).filter((entry) => !entry.transferHash && entry.state.kind === 'importing').map((entry) => entry.titleKey));
for (const titleKey of local) worker.enqueue({ type: 'import.local', payload: { titleKey }, dedupeKey: `local:${titleKey}` });
// A target that fetched its torrent waits for a slot. The source stays in the data, so the send does not ask the
// indexer for the release again.
const uploads = new Map<string, (typeof db.data.queue)[string][]>();
for (const entry of Object.values(db.data.queue)) {
  const hash = uploadHash(entry);
  if (hash) {
    if (entry.state.kind === 'waiting_slot' || entry.state.kind === 'sending') {
      const entries = uploads.get(hash) ?? [];
      entries.push(entry);
      uploads.set(hash, entries);
    }
    continue;
  }
  if (entry.state.kind !== 'waiting_slot' || !entry.source) continue;
  worker.enqueue({ type: 'queue.send', payload: { entryIds: [entry.id] }, dedupeKey: `send:${entry.id}`, runAt: entry.createdAt });
}
for (const [hash, entries] of uploads) enqueueUpload(worker.enqueue, entries, hash);

const restorer = createRestorer({ dir: config.backupDir, worker });
const services = { queue, finder, poller, clients, importStatus };
const indexersChanged = () => {
  events.publish('indexers.changed');
};

const servers: Server[] = [];
function listen(app: ReturnType<typeof createApp>, port: number, name: string) {
  const server = app.listen(port, () => {
    log.info('server listening', { port, app: name });
    // The log is a file, so the console shows where each app answers.
    console.log(`${name[0]!.toUpperCase()}${name.slice(1)}  http://localhost:${port}${name === 'ladarr' ? config.urlBase : ''}`);
  });
  server.on('error', (error) => {
    log.error('could not listen', { port, app: name, error });
    void shutdown('listen', 1);
  });
  servers.push(server);
}

listen(
  createApp({
    urlBase: config.urlBase,
    events,
    webDir: config.webDir,
    devOrigin: config.devOrigin,
    heartbeat: () => worker.heartbeat,
    tmdb,
    configDir: config.configDir,
    backupDir: config.backupDir,
    restorer,
    enqueue: worker.enqueue,
    cancelJob: (id) => worker.cancel(id),
    persist,
    services,
    indexers,
    installUpdate: () => installUpdate(),
    // The queue pauses before the files change, and the update replaces the app and restarts it. A job that still
    // runs is stopped and starts again after the restart. A queue that does not stop in the grace time gives up.
    pauseQueue: async () => {
      queue.setPaused(true);
      if (!(await worker.pause())) throw new UpdateError('busy', 'The queue is still busy.');
    },
    resumeQueue: () => {
      queue.setPaused(false);
      worker.resume();
    },
    // The files of the new version are in place. A clean stop saves the data, and the supervisor starts the server again.
    restart: () => void shutdown('update', UPDATE_EXIT_CODE),
  }),
  config.port,
  'ladarr',
);

if (config.proxy) {
  const deps = { restorer, tmdb, events, enqueue: worker.enqueue, services };
  listen(sonarr({ ...deps, onChange: indexersChanged }), ports.Sonarr, 'sonarr');
  listen(radarr({ ...deps, onChange: indexersChanged }), ports.Radarr, 'radarr');
  listen(seerr(deps), ports.Seerr, 'seerr');
}

let stopping = false;
async function shutdown(signal: string, code = 0) {
  // A second signal must not start a second shutdown.
  if (stopping) return;
  stopping = true;
  log.info('server stopping', { signal });
  try {
    for (const server of servers) {
      server.close();
      server.closeAllConnections();
    }
    poller.stop();
    limiter.stop();
    // The worker aborts its jobs, waits for them, and saves the database.
    await worker.stop();
    log.info('server stopped');
    await closeLog();
    process.exit(code);
  } catch (error) {
    log.error('could not stop cleanly', { error });
    await closeLog();
    process.exit(1);
  }
}

// The log is a file and not the console, so a crash must reach the file before the process ends.
// An error that nothing caught, and a promise that nothing handled, both come here.
process.on('uncaughtException', (error) => {
  log.error('uncaught exception', { error });
  void closeLog().finally(() => process.exit(1));
});
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
