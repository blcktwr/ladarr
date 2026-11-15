import { aggregate } from '@ladarr/shared/queue';
import { db } from '../../core/db.ts';
import { pendingTitleKeys } from '../../helpers/queue.ts';

// The status of the title in the queue, or null when the queue has no target for it. The aggregate of the whole title
// uses the same rule as the row of a season, so the catalog and Activity agree.
export function queueStatusOf(titleKey: string) {
  // A series is in the queue while its episodes load, before it has a target.
  if (pendingTitleKeys().has(titleKey)) return 'searching';
  const states = Object.values(db.data.queue)
    .filter((entry) => entry.titleKey === titleKey && entry.attempt > 0 && !entry.clearedAt)
    .map((entry) => entry.state);
  return states.length ? aggregate(states).status : null;
}
