import { db } from '../core/db.ts';
import { backupAutoHandler } from './backup-auto.ts';
import { importResumeHandler } from './import-resume.ts';
import { importRunHandler } from './import-run.ts';
import { importLocalHandler } from './import-local.ts';
import { libraryScanHandler } from './library-scan.ts';
import { librarySearchHandler } from './library-search.ts';
import { libraryVerifyHandler } from './library-verify.ts';
import { verifySweepHandler } from './verify-sweep.ts';
import { metadataRefreshHandler } from './metadata-refresh.ts';
import { metadataSweepHandler } from './metadata-sweep.ts';
import { migrationImportHandler } from './migration-import.ts';
import { queueGrabHandler } from './queue-grab.ts';
import { queueInitialHandler } from './queue-initial.ts';
import { queueRetryHandler } from './queue-retry.ts';
import { queueRssHandler } from './queue-rss.ts';
import { queueSearchHandler } from './queue-search.ts';
import { queueSendHandler } from './queue-send.ts';
import { queueSweepHandler } from './queue-sweep.ts';
import { webhookDeliverHandler } from './webhook-deliver.ts';
import type { Handler, IndexDeps } from '../types.ts';

export function jobHandlers({ backupDir, events, save, tmdb, enqueue, clients, queue, finder, indexers, importStatus }: IndexDeps): Record<string, Handler> {
  return {
    'backup.auto': backupAutoHandler(backupDir),
    'library.scan': libraryScanHandler({ events }),
    'library.verify': libraryVerifyHandler({ queue, clients, finder, events, enqueue }),
    'library.verify.sweep': verifySweepHandler({ enqueue }),
    ...(tmdb ? { 'metadata.refresh': metadataRefreshHandler({ tmdb, events }), 'metadata.sweep': metadataSweepHandler(), 'migration.import': migrationImportHandler({ tmdb, events, save, enqueue }) } : {}),
    'library.search': librarySearchHandler({ finder, enqueue }),
    'queue.search': queueSearchHandler(finder),
    'queue.initial': queueInitialHandler({ queue, finder }),
    'queue.rss': queueRssHandler(finder),
    'queue.sweep': queueSweepHandler(finder),
    'queue.grab': queueGrabHandler({ queue, finder, indexers, clients, save, enqueue }),
    'queue.send': queueSendHandler({ queue, finder, indexers, clients, save, enqueue }),
    'queue.retry': queueRetryHandler({ queue, finder, clients, enqueue, events }),
    'import.run': importRunHandler({ queue, events, clients, save, status: importStatus, partial: finder.partial }),
    'import.resume': importResumeHandler(),
    'import.local': importLocalHandler({ queue, clients }),
    ...webhookDeliverHandler({}),
  };
}
