import { db } from '../core/db.ts';
import type { Events } from '../core/events.ts';
import type { EnqueueInput, Job } from '../core/jobs.ts';
import type { Handler } from '../core/worker.ts';
import type { Finder } from '../library/grab/finder.ts';
import type { IndexerService } from '../library/grab/torznab.ts';
import type { Clients } from '../library/downloads/client-api.ts';
import type { Queue } from '../library/downloads/queue.ts';
import type { ImportStatus } from '../library/imports/status.ts';
import type { Tmdb } from '../metadata/tmdb.ts';
import { backupAutoHandler } from './backup-auto.ts';
import { importResumeHandler } from './import-resume.ts';
import { importRunHandler } from './import-run.ts';
import { libraryScanHandler } from './library-scan.ts';
import { librarySearchHandler } from './library-search.ts';
import { libraryVerifyHandler } from './library-verify.ts';
import { verifySweepHandler } from './verify-sweep.ts';
import { metadataRefreshHandler } from './metadata-refresh.ts';
import { metadataSweepHandler } from './metadata-sweep.ts';
import { migrationImportHandler } from './migration-import.ts';
import { queueGrabHandler } from './queue-grab.ts';
import { queueInitialHandler } from './queue-initial.ts';
import { queueRssHandler } from './queue-rss.ts';
import { queueSearchHandler } from './queue-search.ts';
import { queueSweepHandler } from './queue-sweep.ts';
import { webhookDeliverHandler } from './webhook-deliver.ts';

type Deps = {
  backupDir: string;
  events: Events;
  save: () => Promise<void>;
  tmdb?: Tmdb;
  enqueue: (input: EnqueueInput) => Job;
  clients: Clients;
  queue: Queue;
  finder: Finder;
  indexers: IndexerService;
  importStatus: ImportStatus;
};

export function jobHandlers({ backupDir, events, save, tmdb, enqueue, clients, queue, finder, indexers, importStatus }: Deps): Record<string, Handler> {
  return {
    'backup.auto': backupAutoHandler(backupDir),
    'library.scan': libraryScanHandler({ events }),
    'library.verify': libraryVerifyHandler({ queue, clients, finder, events }),
    'library.verify.sweep': verifySweepHandler({ enqueue }),
    ...(tmdb ? { 'metadata.refresh': metadataRefreshHandler({ tmdb, events }), 'metadata.sweep': metadataSweepHandler(), 'migration.import': migrationImportHandler({ tmdb, events, save, enqueue }) } : {}),
    'library.search': librarySearchHandler({ finder, enqueue }),
    'queue.search': queueSearchHandler(finder),
    'queue.initial': queueInitialHandler({ queue, finder }),
    'queue.rss': queueRssHandler(finder),
    'queue.sweep': queueSweepHandler(finder),
    'queue.grab': queueGrabHandler({ queue, finder, indexers, clients, save }),
    'import.run': importRunHandler({ queue, events, clients, save, status: importStatus }),
    'import.resume': importResumeHandler(),
    ...webhookDeliverHandler({}),
  };
}
