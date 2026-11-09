import { catalog, titleFields } from '../core/log.ts';
import { JobError } from '../core/jobs.ts';
import { withTitleLock } from '../core/title-lock.ts';
import type { Db } from '../core/db.ts';
import type { Queue } from '../library/downloads/queue.ts';
import type { Finder } from '../library/grab/finder.ts';
import type { Handler } from '../core/worker.ts';

export function queueInitialHandler({ db, queue, finder }: { db: Db; queue: Queue; finder: Finder }): Handler {
  return {
    concurrency: 1,
    maxAttempts: 10,
    // The search for a title that the user just added. A series waits until its episodes are loaded.
    run: async (job) => {
      const key = (job.payload as { key: string }).key;
      const title = db.data.titles[key];
      if (!title || title.paused) return;
      // A title that entered the queue first waits for the facts that the search needs.
      if (title.mediaType === 'movie' && title.metaLoadedAt === null) {
        if (job.attempts <= 1) catalog.info('waiting', 'The search waits for the metadata to load', titleFields(title));
        throw new JobError('outage', 'The metadata is not loaded yet.');
      }
      if (title.mediaType === 'tv' && !title.episodesLoadedAt) {
        // The first run says why the search waits. The next runs wait without a new line.
        if (job.attempts <= 1) catalog.info('waiting', 'The search waits for the episodes to load', titleFields(title));
        throw new JobError('outage', 'The episodes are not loaded yet.');
      }
      // A title with nothing to search leaves the queue. The page learns it from this message.
      await withTitleLock(key, async () => {
        if (!finder.requestSearch(title.key, { reason: 'title added' }).length) {
          catalog.info('empty', 'No target to search: no episode is due', titleFields(title));
          queue.notify();
        }
      });
    },
  };
}
