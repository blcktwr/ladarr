import type { Finder, SearchPayload } from '../acquisition/finder.ts';
import { withTitleLock } from '../core/title-lock.ts';
import type { Handler } from '../core/worker.ts';

export function queueSearchHandler(finder: Finder): Handler {
  return {
    concurrency: 1,
    maxAttempts: 6,
    run: (job, { signal }) => {
      const payload = job.payload as SearchPayload;
      // The verification reads the files and the client for the same title. A search that waits for the lock reads
      // the state that the verification left.
      return withTitleLock(payload.titleKey, () => finder.search(payload, signal, job.attempts >= 6));
    },
  };
}
