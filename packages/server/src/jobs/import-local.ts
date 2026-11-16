import { withTitleLock } from '../core/title-lock.ts';
import { importLocal } from '../library/imports/local.ts';
import type { Clients, Handler, Queue } from '../types.ts';

// Reads the folder of a title again and takes the files that are there. It runs after a match by the user and after a
// restart, so a target that stopped on its folder resolves without a search.
export function importLocalHandler({ queue, clients }: { queue: Queue; clients: Clients }): Handler {
  return {
    concurrency: 1,
    maxAttempts: 3,
    run: async (job) => {
      const { titleKey } = job.payload as { titleKey: string };
      await withTitleLock(titleKey, () => importLocal({ queue, clients }, { titleKey }));
    },
  };
}
