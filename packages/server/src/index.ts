import { dirname } from 'node:path';
import { loadConfig } from '@ladarr/shared/config';
import { createApp } from './app.ts';
import { createClientCheck, createClients } from './downloads/client-api.ts';
import { createImportStatus } from './library/import-status.ts';
import { createFinder } from './acquisition/finder.ts';
import { collectProblems } from './system/health.ts';
import { unfinishedImports } from './library/importer.ts';
import { createLimiter } from './core/limiter.ts';
import { ffprobeAvailable } from './library/probe.ts';
import { createPoller } from './downloads/poller.ts';
import { createQueue } from './downloads/queue.ts';
import { createIndexerService } from './acquisition/torznab.ts';
import { createSaver, openDb, SCHEMA_VERSION } from './core/db.ts';
import { createEvents } from './core/events.ts';
import { closeLog, configureItemLogs, log, logToFile } from './core/log.ts';
import { createRestorer } from './system/restore.ts';
import { firstUnwritable } from './core/permissions.ts';
import { installUpdate } from './system/update.ts';
import { createTmdb } from './metadata/tmdb.ts';
import { createWebhooks } from './integrations/webhook.ts';
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
const db = await openDb(config.dbFile, config.queueFile);
// An older version must not write to a file of a newer version. It could lose data that it does not know.
if (db.data.schemaVersion > SCHEMA_VERSION) {
  console.error(`The data file ${config.dbFile} has schema version ${db.data.schemaVersion}. This version reads schema version ${SCHEMA_VERSION} at most. Start a newer version, or restore a backup from this version.`);
  process.exit(1);
}
// The log of each target in the queue has a file of its own, as the settings say.
configureItemLogs(db);
const events = createEvents();

const tmdb = config.tmdbApiKey ? createTmdb({ apiKey: config.tmdbApiKey, baseUrl: config.tmdbBaseUrl }) : undefined;
if (!tmdb) log.warn('No TMDB key is in this build, so titles cannot be searched');
// Not awaited: the server starts at once, and the status shows the result when it arrives.
else void withOutboundRequests(() => tmdb.check().then(({ ok, code }) => ok || log.warn('TMDB check failed', { code })));

const save = createSaver(db);
const persist = () => void save().catch((error) => log.error('could not save the database', { error }));
const clients = createClients(db);
const clientCheck = createClientCheck(clients);
const webhooks = createWebhooks({
  db,
  persist,
  enqueue: (input) => worker.enqueue(input),
  problems: () => collectProblems({ db, tmdb, heartbeat: () => worker.heartbeat, backupDir: config.backupDir, clientCheck, ffprobe: ffprobeAvailable }),
});
const queue = createQueue(db, events, persist, webhooks.onMove);
const limiter = createLimiter(db, persist);
const indexers = createIndexerService(db, limiter, {}, persist);
const finder = createFinder({ db, queue, indexers, enqueue: (input) => worker.enqueue(input) });
const poller = createPoller({ db, queue, events, clients, enqueue: (input) => worker.enqueue(input) });
const importStatus = createImportStatus(events);
const worker = createWorker(
  db,
  save,
  jobHandlers({ db, backupDir: config.backupDir, events, save, tmdb, enqueue: (input) => worker.enqueue(input), clients, queue, finder, indexers, importStatus }),
);
worker.start();
webhooks.start();
poller.start();
// An import that stopped in the middle runs again. Its journal says where to go on.
for (const hash of unfinishedImports(db)) worker.enqueue({ type: 'import.run', payload: { hash }, dedupeKey: `import:${hash}` });

const restorer = createRestorer({ db, dir: config.backupDir, worker });

const server = createApp(db, {
  urlBase: config.urlBase,
  events,
  webDir: config.webDir,
  heartbeat: () => worker.heartbeat,
  tmdb,
  configDir: config.configDir,
  backupDir: config.backupDir,
  restorer,
  enqueue: worker.enqueue,
  cancelJob: (id) => worker.cancel(id),
  persist,
  services: { queue, finder, poller, clients, importStatus },
  indexers,
  installUpdate: () => installUpdate(),
  // The jobs stop before the files change. The ones that run finish first, so no import is cut in the middle.
  pauseQueue: () => worker.drain(),
  resumeQueue: () => worker.resume(),
  // The files of the new version are in place. A clean stop saves the data, and Docker starts the process again.
  restart: () => void shutdown('update'),
}).listen(config.port, () => {
  log.info('server listening', { port: config.port });
});

let stopping = false;
async function shutdown(signal: string) {
  // A second signal must not start a second shutdown.
  if (stopping) return;
  stopping = true;
  log.info('server stopping', { signal });
  try {
    server.close();
    server.closeAllConnections();
    poller.stop();
    webhooks.stop();
    limiter.stop();
    // The worker aborts its jobs, waits for them, and saves the database.
    await worker.stop();
    log.info('server stopped');
    await closeLog();
    process.exit(0);
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
