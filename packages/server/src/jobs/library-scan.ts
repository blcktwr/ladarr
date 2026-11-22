import { db } from '../core/db.ts';
import { JobError } from '../core/jobs.ts';
import { log } from '../core/log.ts';
import { withTitleLock } from '../core/title-lock.ts';
import { reconcile } from '../library/imports/reconcile.ts';
import { scanTitle } from '../library/scan.ts';
import type { Events, Handler, Queue } from '../types.ts';

export function libraryScanHandler({ events, queue }: { events: Events; queue: Queue }): Handler {
  return {
    concurrency: 1,
    run: async (job) => {
      const { key } = job.payload as { key: string };
      // The scan and the verification read the same folder. One of them holds the title, so a file that one links
      // is not removed or searched by the other.
      const result = await withTitleLock(key, async () => {
        const scan = await scanTitle(key);
        if (scan.status === 'ok') await reconcile(queue, key);
        return scan;
      });
      if (result.status === 'changed') throw new JobError('outage', 'The files of the title changed during the scan.');
      log.info('library scan', { key, status: result.status, added: result.added, updated: result.updated, missing: result.missing });
      events.publish('library.changed', { key });
    },
  };
}
