import { JobError } from '../core/jobs.ts';
import { ClientError } from '../downloads/qbittorrent.ts';
import { createImporter, type ImportDeps } from '../library/importer.ts';
import type { Handler } from '../core/worker.ts';

export function importRunHandler(deps: ImportDeps): Handler {
  const { run } = createImporter(deps);
  return {
    concurrency: 1,
    maxAttempts: 5,
    run: async (job) => {
      try {
        await run((job.payload as { hash: string }).hash);
      } catch (error) {
        if (error instanceof ClientError) throw new JobError('outage', error.message);
        throw error;
      }
    },
  };
}
