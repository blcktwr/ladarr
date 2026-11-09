import type { Db } from '../core/db.ts';
import type { EnqueueInput, Job } from '../core/jobs.ts';
import type { Finder } from '../library/grab/finder.ts';
import { BULK_SEARCH_JOB, type BulkSearchPayload } from '../library/calendar/calendar-search.ts';
import type { Handler } from '../core/worker.ts';

// One batch ends at 25 titles or 300 started targets, whichever comes first.
const BATCH_TITLES = 25;
const BATCH_TARGETS = 300;
// An upgrade search asks the indexers itself, for each file, so its batch is smaller.
const UPGRADE_BATCH_TITLES = 5;
const UPGRADE_BATCH_TARGETS = 10;
// While this many season searches wait, the next batch waits too.
const MAX_BACKLOG = 50;
const BACKLOG_WAIT_MS = 30_000;

type Deps = { db: Db; finder: Finder; enqueue: (input: EnqueueInput) => Job };

export function librarySearchHandler({ db, finder, enqueue }: Deps): Handler {
  return {
    concurrency: 1,
    run: async (job, { signal }) => {
      const { planId, keys, offset, kind = 'search', resolution } = job.payload as BulkSearchPayload;
      const [maxTitles, maxTargets] = kind === 'upgrades' ? [UPGRADE_BATCH_TITLES, UPGRADE_BATCH_TARGETS] : [BATCH_TITLES, BATCH_TARGETS];
      let next = offset;
      let started = 0;
      while (next < keys.length && next - offset < maxTitles && started < maxTargets) {
        signal.throwIfAborted();
        // A target that is in the journey starts nothing, so a batch that runs twice adds no second job.
        started += kind === 'upgrades' ? await finder.upgradeTitle(keys[next++]!, signal, resolution!) : finder.requestSearch(keys[next++]!, { fresh: true }).length;
        // A retry after a stop starts at the next title, so it does not search a finished title again.
        const live = db.data.jobs[job.id];
        if (live) (live.payload as BulkSearchPayload).offset = next;
        // The batch lets other work run between two titles.
        await new Promise((resolve) => setImmediate(resolve));
      }
      if (next >= keys.length) return;
      const backlog = Object.values(db.data.jobs).filter((other) => other.type === 'queue.search' && other.state === 'waiting').length;
      enqueue({ type: BULK_SEARCH_JOB, payload: { planId, keys, offset: next, ...(kind === 'upgrades' ? { kind, resolution } : {}) } satisfies BulkSearchPayload, dedupeKey: `${BULK_SEARCH_JOB}:${planId}:${next}`, runAt: Date.now() + (backlog >= MAX_BACKLOG ? BACKLOG_WAIT_MS : 0) });
    },
  };
}
