import { db } from '../core/db.ts';
import { JobError } from '../core/jobs.ts';
import { catalog, itemFields } from '../core/log.ts';
import { createGrabber, reasonOf } from '../library/grab/grab.ts';
import { isActive, phaseOfEntry } from '../library/downloads/queue.ts';
import type { GrabberDeps, Handler, QueueEntry } from '../types.ts';

const MAX_ATTEMPTS = 8;

// A grab can still work on a target that a try blocked: the entry keeps the phase of the fetch.
const grabbable = (entry: QueueEntry) => isActive(entry) && entry.state.kind !== 'paused' && Boolean(entry.release) && phaseOfEntry(entry) === 'fetching';

export function queueGrabHandler(deps: GrabberDeps): Handler {
  const { queue } = deps;
  const { fetch } = createGrabber(deps);
  return {
    concurrency: 2,
    maxAttempts: MAX_ATTEMPTS,
    // The fetch does not wait for a slot of the client. A full client stops the send, not the fetch.
    run: async (job, { signal }) => {
      const { entryIds } = job.payload as { entryIds: string[] };
      const entries = entryIds.map((id) => db.data.queue[id]).filter((entry): entry is QueueEntry => Boolean(entry) && grabbable(entry!));
      if (!entries.length) return;
      try {
        await fetch(entries, signal);
      } catch (error) {
        if (signal.aborted) throw error;
        const reason = reasonOf(error);
        const kind = error instanceof JobError ? error.kind : 'outage';
        for (const entry of entries) {
          catalog.warn('download_failed', `Download failed: ${reason.code} (try ${job.attempts} of ${MAX_ATTEMPTS})`, itemFields(entry), { code: reason.code, try: job.attempts, maxTries: MAX_ATTEMPTS, kind });
        }
        if (kind === 'invalid_input' || job.attempts >= MAX_ATTEMPTS) {
          for (const entry of entries) queue.block(entry, reason, 'grab failed');
        } else {
          // The entry keeps its phase. The problem shows why it waits.
          for (const entry of entries) queue.block(entry, reason, 'grab will be tried again');
        }
        throw error;
      }
    },
  };
}
