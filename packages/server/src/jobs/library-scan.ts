import type { Db } from '../core/db.ts';
import type { Events } from '../core/events.ts';
import { JobError } from '../core/jobs.ts';
import { log } from '../core/log.ts';
import { withTitleLock } from '../core/title-lock.ts';
import type { Handler } from '../core/worker.ts';
import { scanTitle } from '../library/scan.ts';

export function libraryScanHandler({ db, events }: { db: Db; events: Events }): Handler {
  return {
    concurrency: 1,
    run: async (job) => {
      const { key } = job.payload as { key: string };
      // The scan and the verification read the same folder. One of them holds the title, so a file that one links
      // is not removed or searched by the other.
      const result = await withTitleLock(key, () => scanTitle(db, key));
      if (result.status === 'changed') throw new JobError('outage', 'The files of the title changed during the scan.');
      log.info('library scan', { key, status: result.status, added: result.added, updated: result.updated, missing: result.missing });
      events.publish('library.changed', { key });
    },
  };
}
