import { type Db, db } from '../core/db.ts';
import type { EnqueueInput, Job } from '../core/jobs.ts';
import type { Handler } from '../core/worker.ts';
import { verifyJob } from '../library/verification.ts';

const VERIFY_EVERY_MS = 10 * 60_000;

// A verification that a client or a root stopped stays pending. This job starts it again, whatever the retry budget
// of the job was, so the work of an import never ends because an outside system was away.
export function verifySweepHandler({ enqueue }: { enqueue: (input: EnqueueInput) => Job }): Handler {
  return {
    concurrency: 1,
    every: VERIFY_EVERY_MS,
    run: async () => {
      for (const state of Object.values(db.data.verifications)) {
        if (!state.pending || !db.data.titles[state.key]) continue;
        enqueue(verifyJob(state.key));
      }
    },
  };
}
