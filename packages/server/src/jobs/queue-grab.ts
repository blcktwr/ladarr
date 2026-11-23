import { db } from '../core/db.ts';
import { JobError } from '../core/jobs.ts';
import { catalog, itemFields } from '../core/log.ts';
import { createGrabber, reasonOf } from '../library/grab/grab.ts';
import type { GrabberDeps, Handler, QueueEntry } from '../types.ts';

const MAX_ATTEMPTS = 8;

const grabbable = (entry: QueueEntry) => entry.state.kind === 'fetching' && Boolean(entry.release);

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
      const releases = new Map(entries.map((entry) => [entry, entry.release]));
      try {
        await fetch(entries, signal);
      } catch (error) {
        if (signal.aborted) throw error;
        const reason = reasonOf(error);
        const kind = error instanceof JobError ? error.kind : 'outage';
        for (const entry of entries) {
          if (db.data.queue[entry.id] !== entry || releases.get(entry) !== entry.release || !grabbable(entry)) continue;
          catalog.warn('download_failed', `Download failed: ${reason.code} (try ${job.attempts} of ${MAX_ATTEMPTS})`, itemFields(entry), { code: reason.code, try: job.attempts, maxTries: MAX_ATTEMPTS, kind });
          if (kind === 'invalid_input' || job.attempts >= MAX_ATTEMPTS) queue.block(entry, reason, 'grab failed');
          else queue.observe(entry, 'grab will be tried again', reason.code);
        }
        throw error;
      }
    },
  };
}
