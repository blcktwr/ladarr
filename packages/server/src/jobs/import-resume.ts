import type { Db } from '../core/db.ts';
import { enqueue as enqueueJob } from '../core/jobs.ts';
import { unfinishedImports } from '../library/imports/importer.ts';
import type { Handler } from '../core/worker.ts';

const RESUME_EVERY_MS = 10 * 60_000;

// A journal can stay open after its job failed, for example after an outage of the disk or of the client.
// The title stays busy until the journal ends, so this job asks for a new run of each open journal.
export function importResumeHandler(db: Db): Handler {
  return {
    concurrency: 1,
    every: RESUME_EVERY_MS,
    run: async () => {
      for (const hash of unfinishedImports()) enqueueJob({ type: 'import.run', payload: { hash }, dedupeKey: `import:${hash}` });
    },
  };
}
