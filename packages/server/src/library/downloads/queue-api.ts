import type { Finder } from '../grab/finder.ts';
import { get, type Db } from '../../core/db.ts';
import type { EnqueueInput, Job } from '../../core/jobs.ts';
import { isActive, type Queue, type QueueEntry } from './queue.ts';

// The active targets that point at the same torrent.
export const sharingOf = (db: Db, entry: QueueEntry) => (entry.transferHash ? Object.values(db.data.queue).filter((other) => other.transferHash === entry.transferHash && isActive(other)) : [entry]);

// A new search, or a new send, for a target that waits for the user.
export function createRetry({ queue, finder, enqueue }: { queue: Queue; finder: Finder; enqueue: (input: EnqueueInput) => Job }) {
  const db = get();
  const sharing = (entry: QueueEntry) => sharingOf(db, entry);

  function reset(entry: QueueEntry, cause: string) {
    queue.endAttempt(entry, 'failed', cause);
    queue.startAttempt(entry, cause);
  }

  function retry(entry: QueueEntry) {
    reset(entry, 'retry');
    const hash = entry.transferHash;
    if (hash && (entry.stage === 'validating' || entry.stage === 'importing')) {
      queue.move(entry, { branch: null, reason: null }, 'retry');
      enqueue({ type: 'import.run', payload: { hash }, dedupeKey: `import:${hash}` });
    } else if ((entry.stage === 'fetching' || entry.stage === 'sending') && entry.release) {
      queue.move(entry, { branch: null, reason: null }, 'retry');
      enqueue({ type: 'queue.grab', payload: { entryIds: sharing(entry).filter((e) => e.stage === 'fetching' || e.stage === 'sending').map((e) => e.id) }, dedupeKey: `grab:${entry.id}`, runAt: entry.createdAt });
    } else {
      entry.release = null;
      entry.transferHash = null;
      entry.clientId = null;
      entry.search = null;
      queue.move(entry, { stage: 'queued', branch: null, reason: null }, 'retry');
      finder.enqueueSearch({ titleKey: entry.titleKey, season: entry.season, entryIds: [entry.id], fresh: true, ...(entry.season === null ? {} : { manual: true }) });
    }
  }

  // The targets that wait because of one cause, such as no indexer, go on when the user lifts that cause.
  function retryBlocked(code: string) {
    for (const entry of Object.values(db.data.queue)) if (entry.branch !== 'cancelled' && entry.branch !== 'paused' && entry.reason?.code === code && db.data.titles[entry.titleKey]) retry(entry);
  }

  return { retry, retryBlocked };
}
