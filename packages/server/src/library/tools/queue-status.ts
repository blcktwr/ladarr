import { db } from '../../core/db.ts';
import { loadingTitleKeys, queueKey, type QueueEntry } from '../downloads/queue.ts';

// The stages in the order that the page shows them, with the work first. A target that waits for its next
// search without a result counts as searching, like the Activity page shows it.
const queueOrder = ['searching', 'fetching', 'sending', 'downloading', 'validating', 'importing', 'stuck', 'not_found', 'no_match', 'queued', 'paused', 'cancelled'];
const statusKey = (entry: QueueEntry) => {
  const key = queueKey(entry);
  return key === 'waiting' ? 'searching' : key;
};

// The status of the title in the queue, or null when the queue has no target for it.
export function queueStatusOf(titleKey: string) {
  // A series is in the queue while its episodes load, before it has a target.
  if (loadingTitleKeys().has(titleKey)) return 'searching';
  const counts: Record<string, number> = {};
  for (const entry of Object.values(db.data.queue)) {
    if (entry.titleKey !== titleKey || entry.attempt === 0 || entry.clearedAt) continue;
    const key = statusKey(entry);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return queueOrder.find((key) => counts[key]) ?? (counts.available ? 'available' : null);
}
