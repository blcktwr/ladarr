import { db } from '../../core/db.ts';
import { isActive } from './queue.ts';
import type { EnqueueInput, Job, Queue, QueueEntry } from '../../types.ts';

// The active targets that point at the same torrent.
export const sharingOf = (entry: QueueEntry) => (entry.transferHash ? Object.values(db.data.queue).filter((other) => other.transferHash === entry.transferHash && isActive(other)) : [entry]);

// A new try for a target that waits for the user. The phases of its journey run again in order, from the file in the
// library to a new search, and the first phase that resolves it moves the target. A retry never takes the state of the
// target away before it checks it.
export function createRetry({ queue, enqueue }: { queue: Queue; enqueue: (input: EnqueueInput) => Job }) {
  function retry(entry: QueueEntry) {
    const hash = entry.transferHash ?? entry.release?.infoHash ?? null;
    // An import that failed keeps its download. The retry runs the import checks again, with no limit, and it never
    // searches the indexers or fetches the torrent again.
    if (entry.state.kind === 'blocked' && entry.state.at === 'importing' && hash) {
      entry.transferHash ??= hash;
      queue.retryAttempt(entry, 'retry');
      queue.enter(entry, 'importing', 'retry: the import checks run again');
      const job = enqueue({ type: 'import.run', payload: { hash, manual: true }, dedupeKey: `import:${hash}`, priority: entry.priority !== null });
      // A job that waits already holds the automatic mode. The user asked for a manual run, and the budget does not stop it.
      if (job.type === 'import.run' && job.state === 'waiting') job.payload = { hash, manual: true };
      return;
    }
    queue.retryAttempt(entry, 'retry');
    // The target leaves its problem now, so the page shows the new work at the click. The job then reads the files
    // and the client again, and stops at the first phase that resolves it.
    queue.enter(entry, 'queued', 'retry');
    enqueue({ type: 'queue.retry', payload: { entryIds: [entry.id] }, dedupeKey: `retry:${entry.id}`, priority: entry.priority !== null });
  }

  // The targets that wait because of one cause, such as no indexer, go on when the user lifts that cause.
  function retryBlocked(code: string) {
    for (const entry of Object.values(db.data.queue)) if (entry.state.kind === 'blocked' && entry.state.problem.code === code && db.data.titles[entry.titleKey]) retry(entry);
  }

  return { retry, retryBlocked };
}
