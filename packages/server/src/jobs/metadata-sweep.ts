import { type Db, db } from '../core/db.ts';
import { enqueue } from '../core/jobs.ts';
import { movieEligibleAt, type Title } from '../library/library.ts';
import { refreshJob } from '../library/metadata.ts';
import type { Handler } from '../core/worker.ts';

const ACTIVE_REFRESH_MS = 12 * 60 * 60_000;
const IDLE_REFRESH_MS = 7 * 24 * 60 * 60_000;
const SWEEP_EVERY_MS = 60 * 60_000;
const DONE_STATUSES = ['Ended', 'Canceled', 'Released'];

// A title changes more while it is not finished. A movie that waits for a digital release is not finished either.
function isActive(title: Title, now: number) {
  if (title.paused) return false;
  if (title.mediaType === 'movie') {
    const at = movieEligibleAt(title);
    if (at === null || at > now) return true;
  }
  return !DONE_STATUSES.includes(title.meta.status);
}

export function metadataSweepHandler(): Handler {
  return {
    every: SWEEP_EVERY_MS,
    // Finds the titles that are due. Jobs with the same key merge, so a slow TMDB does not build a backlog.
    run: async () => {
      const now = Date.now();
      for (const title of Object.values(db.data.titles)) {
        // A title from an older version has no regions for its aliases. One refresh fills them.
        if (title.meta.aliasRegions === undefined) {
          enqueue(refreshJob(title.key));
          continue;
        }
        const interval = isActive(title, now) ? ACTIVE_REFRESH_MS : IDLE_REFRESH_MS;
        if (now - title.refreshedAt >= interval) enqueue(refreshJob(title.key));
      }
    },
  };
}
