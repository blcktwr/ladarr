import type { Db } from '../core/db.ts';
import type { Events } from '../core/events.ts';
import { JobError } from '../core/jobs.ts';
import type { MigrateDeps } from '../migration/migration.ts';
import { AddError, addTitle } from '../library/tools/add.ts';
import { requestVerification } from '../library/verification.ts';
import { TmdbError } from '../metadata/tmdb.ts';
import { log } from '../core/log.ts';
import type { Handler } from '../core/worker.ts';

const SAVE_EVERY = 25;

export function migrationImportHandler({ db, tmdb, events, save, enqueue }: MigrateDeps): Handler {
  return {
    concurrency: 1,
    run: async (_job, { signal }) => {
      let done = 0;
      for (const entry of Object.values(db.data.ledger)) {
        if (entry.status !== 'pending') continue;
        signal.throwIfAborted();
        const { request } = entry;
        try {
          const { title } = await addTitle({ db, tmdb, enqueue }, { ...request, mode: request.paused ? 'paused' : 'all' });
          entry.status = 'imported';
          entry.key = title.key;
          // The files, the torrents, and the queue of the title are checked after the add. A paused title is not
          // searched, so nothing starts for it.
          if (!title.paused) requestVerification(db, enqueue, title.key, { downloads: request.downloads, episodes: request.sourceEpisodes });
        } catch (err) {
          // The title is in the library already, so the import has nothing to add.
          if (err instanceof AddError) {
            entry.status = 'matched';
            entry.key = err.key;
            if (!db.data.titles[err.key]?.paused) requestVerification(db, enqueue, err.key, { downloads: request.downloads, episodes: request.sourceEpisodes });
          } else if (err instanceof TmdbError && err.code === 'not_found') {
            entry.status = 'failed';
            entry.error = 'tmdb_not_found';
          } else {
            // An outage of TMDB stops the job. The entries stay pending, and the job runs again later.
            throw err;
          }
        }
        entry.updatedAt = Date.now();
        events.publish('migration.progress', {});
        events.publish('library.changed', { key: entry.key });
        if (++done % SAVE_EVERY === 0) await save();
      }
      log.info('migration import ended', { titles: done });
    },
  };
}
