import type { EnqueueInput, Job } from '../../core/jobs.ts';
import { db } from '../../core/db.ts';
import { isActive, type Queue, type QueueEntry } from './queue.ts';

// The active targets that point at the same torrent.
export const sharingOf = (entry: QueueEntry) => (entry.transferHash ? Object.values(db.data.queue).filter((other) => other.transferHash === entry.transferHash && isActive(other)) : [entry]);

// A new try for a target that waits for the user. The attempt starts here, and the worker resolves the target: the
// phases of its journey run again in order, from the file in the library to a new search, and the first phase that
// resolves it moves the target. A retry never takes the state of the target away before it checks it.
export function createRetry({ queue, enqueue }: { queue: Queue; enqueue: (input: EnqueueInput) => Job }) {
  function retry(entry: QueueEntry) {
    queue.retryAttempt(entry, 'retry');
    enqueue({ type: 'queue.retry', payload: { entryIds: [entry.id] }, dedupeKey: `retry:${entry.id}`, priority: entry.priority !== null });
  }

  // The targets that wait because of one cause, such as no indexer, go on when the user lifts that cause.
  function retryBlocked(code: string) {
    for (const entry of Object.values(db.data.queue)) if (entry.state.kind === 'blocked' && entry.state.problem.code === code && db.data.titles[entry.titleKey]) retry(entry);
  }

  return { retry, retryBlocked };
}
