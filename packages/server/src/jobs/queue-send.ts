import { db } from '../core/db.ts';
import { JobError } from '../core/jobs.ts';
import { catalog, itemFields } from '../core/log.ts';
import { withTitleLock } from '../core/title-lock.ts';
import { createGrabber, reasonOf } from '../library/grab/grab.ts';
import { hasFreeSlot } from '../library/downloads/slots.ts';
import { uploadHash } from '../library/downloads/upload.ts';
import type { GrabberDeps, Handler, QueueEntry } from '../types.ts';

const MAX_ATTEMPTS = 8;

// A send works on the target that waits for a slot, and on the target that a failed try sent already.
const sendable = (entry: QueueEntry) => Boolean(entry.release) && ['waiting_slot', 'sending'].includes(entry.state.kind);

export function queueSendHandler(deps: GrabberDeps): Handler {
  const { queue, clients } = deps;
  const { send } = createGrabber(deps);
  const entriesOf = (job: { payload: unknown }) => {
    const { entryIds = [], uploadHash: hash } = job.payload as { entryIds?: string[]; uploadHash?: string };
    const entries = hash ? Object.values(db.data.queue).filter((entry) => uploadHash(entry) === hash) : entryIds.map((id) => db.data.queue[id]).filter((entry): entry is QueueEntry => Boolean(entry) && !uploadHash(entry!));
    return entries.filter(sendable);
  };

  return {
    concurrency: 2,
    maxAttempts: MAX_ATTEMPTS,
    // The target waits in the slot stage while its client runs all the downloads that it allows.
    canStart: (job) => {
      const entries = entriesOf(job);
      const payload = job.payload as { entryIds?: string[]; uploadHash?: string };
      const own = new Set(payload.uploadHash ? entries.map((entry) => entry.id) : payload.entryIds);
      const leader = entries[0];
      if (!leader) return true;
      const clientId = leader.clientId ?? clients.next()?.id;
      return !clientId || hasFreeSlot(clients, clientId, own);
    },
    run: async (job, { signal }) => {
      const run = async () => {
        signal.throwIfAborted();
        const entries = entriesOf(job);
        if (!entries.length) return;
        const releases = new Map(entries.map((entry) => [entry, entry.release]));
        try {
          await send(entries, signal);
        } catch (error) {
          if (signal.aborted) throw error;
          const reason = reasonOf(error);
          const kind = error instanceof JobError ? error.kind : 'outage';
          for (const entry of entries) {
            if (db.data.queue[entry.id] !== entry || releases.get(entry) !== entry.release || !sendable(entry)) continue;
            catalog.warn('download_failed', `Send failed: ${reason.code} (try ${job.attempts} of ${MAX_ATTEMPTS})`, itemFields(entry), { code: reason.code, try: job.attempts, maxTries: MAX_ATTEMPTS, kind });
            if (kind === 'invalid_input' || job.attempts >= MAX_ATTEMPTS) queue.block(entry, reason, 'send failed');
            else queue.observe(entry, 'send will be tried again', reason.code);
          }
          throw error;
        }
      };
      const leader = entriesOf(job)[0];
      if (!leader) return;
      const locked = uploadHash(leader) ? () => withTitleLock(leader.titleKey, run) : run;
      const hash = leader.transferHash ?? leader.release?.infoHash;
      if (hash) await withTitleLock(`send:${hash}`, locked);
      else await locked();
    },
  };
}
