import { db } from '../core/db.ts';
import { JobError } from '../core/jobs.ts';
import { catalog, itemFields } from '../core/log.ts';
import { createGrabber, reasonOf } from '../library/grab/grab.ts';
import { hasFreeSlot } from '../library/downloads/slots.ts';
import type { GrabberDeps, Handler, QueueEntry } from '../types.ts';

const MAX_ATTEMPTS = 8;

// A send works on the target that waits for a slot, and on the target that a failed try sent already.
const sendable = (entry: QueueEntry) => Boolean(entry.release) && ['waiting_slot', 'sending'].includes(entry.state.kind);

export function queueSendHandler(deps: GrabberDeps): Handler {
  const { queue, clients } = deps;
  const { send } = createGrabber(deps);
  const entriesOf = (job: { payload: unknown }) =>
    ((job.payload as { entryIds?: string[] }).entryIds ?? []).map((id) => db.data.queue[id]).filter((entry): entry is QueueEntry => Boolean(entry) && sendable(entry!));

  return {
    concurrency: 2,
    maxAttempts: MAX_ATTEMPTS,
    // The target waits in the slot stage while its client runs all the downloads that it allows.
    canStart: (job) => {
      const own = new Set((job.payload as { entryIds?: string[] }).entryIds ?? []);
      const leader = entriesOf(job)[0];
      if (!leader) return true;
      const clientId = leader.clientId ?? clients.next()?.id;
      return !clientId || hasFreeSlot(clients, clientId, own);
    },
    run: async (job, { signal }) => {
      const entries = entriesOf(job);
      if (!entries.length) return;
      try {
        await send(entries, signal);
      } catch (error) {
        if (signal.aborted) throw error;
        const reason = reasonOf(error);
        const kind = error instanceof JobError ? error.kind : 'outage';
        for (const entry of entries) {
          catalog.warn('download_failed', `Send failed: ${reason.code} (try ${job.attempts} of ${MAX_ATTEMPTS})`, itemFields(entry), { code: reason.code, try: job.attempts, maxTries: MAX_ATTEMPTS, kind });
        }
        if (kind === 'invalid_input' || job.attempts >= MAX_ATTEMPTS) {
          for (const entry of entries) queue.block(entry, reason, 'send failed');
        } else {
          for (const entry of entries) queue.observe(entry, 'send will be tried again', reason.code);
        }
        throw error;
      }
    },
  };
}
