import { db } from '../core/db.ts';
import { JobError } from '../core/jobs.ts';
import { catalog, itemFields } from '../core/log.ts';
import { withTitleLock } from '../core/title-lock.ts';
import { getItem, itemFor } from '../library/downloads/queue.ts';
import { canReconcileMovie, createGrabber, currentSelection, readySelection, reasonOf, sendPhase } from '../library/grab/grab.ts';
import { hasFreeSlot } from '../library/downloads/slots.ts';
import { uploadHash } from '../library/downloads/upload.ts';
import type { GrabberDeps, Handler, QueueEntry } from '../types.ts';

const MAX_ATTEMPTS = 8;

// A send works on the target that waits for a slot, and on the target that a failed try sent already.
const sendable = (entry: QueueEntry) => Boolean(entry.release) && ['waiting_slot', 'sending'].includes(entry.state.kind);

export function queueSendHandler(deps: GrabberDeps): Handler {
  const { queue, clients } = deps;
  const { sendUpload, submit } = createGrabber(deps);
  const selectedOf = (job: { payload: unknown }) => {
    const { itemId, hash, entryIds = [], uploadHash: upload } = job.payload as { itemId?: string; hash?: string; entryIds?: string[]; uploadHash?: string };
    if (upload) return;
    const leader = entryIds.map((id) => queue.get(id)).find((entry) => entry && sendPhase(entry));
    const item = itemId ? getItem(itemId) : leader && itemFor(leader);
    const key = hash ?? leader?.transferHash;
    const torrent = key && item?.selected[key];
    if (!item || !torrent || !currentSelection(item, torrent) || (!readySelection(item) && !canReconcileMovie(item, torrent))) return;
    const entries = Object.keys(torrent.matches).flatMap((id) => {
      const entry = queue.get(id);
      return entry && item.entryIds.includes(id) && (!entry.transferHash || entry.transferHash === torrent.hash) &&
        sendPhase(entry) && !uploadHash(entry) ? [entry] : [];
    });
    if (entries.length) return { item, torrent, entries };
  };
  const entriesOf = (job: { payload: unknown }) => {
    const { uploadHash: hash } = job.payload as { uploadHash?: string };
    return hash ? Object.values(db.data.queue).filter((entry) => uploadHash(entry) === hash && sendable(entry)) : [];
  };

  return {
    concurrency: 2,
    maxAttempts: MAX_ATTEMPTS,
    canStart: (job) => {
      const selected = selectedOf(job);
      if (selected) {
        const { torrent, entries } = selected;
        const client = torrent.status === 'uncertain' && torrent.clientId ? clients.get(torrent.clientId) : clients.next();
        return Boolean(client && (torrent.status === 'uncertain' || hasFreeSlot(clients, client.id, new Set(entries.map(({ id }) => id)))));
      }
      const entries = entriesOf(job);
      const own = new Set(entries.map((entry) => entry.id));
      const leader = entries[0];
      if (!leader) return true;
      const client = clients.get(leader.clientId) ?? clients.next();
      return Boolean(client && (leader.state.kind === 'sending' || hasFreeSlot(clients, client.id, own)));
    },
    run: async (job, { signal }) => {
      const prepared = selectedOf(job);
      if (prepared) {
        await withTitleLock(`send:${prepared.torrent.hash}`, async () => {
          signal.throwIfAborted();
          const selected = selectedOf(job);
          if (!selected || selected.torrent.hash !== prepared.torrent.hash) return;
          const { item, torrent, entries } = selected;
          try {
            await submit(item, torrent, signal);
          } catch (error) {
            if (signal.aborted) throw error;
            if (getItem(item.id) !== item || item.selected[torrent.hash] !== torrent || (!readySelection(item) && !canReconcileMovie(item, torrent))) return;
            const reason = reasonOf(error);
            const kind = error instanceof JobError ? error.kind : 'outage';
            const final = kind === 'invalid_input' || job.attempts >= MAX_ATTEMPTS;
            for (const entry of entries.filter(sendPhase)) {
              catalog.warn('download_failed', `Send failed: ${reason.code} (try ${job.attempts} of ${MAX_ATTEMPTS})`, itemFields(entry), { code: reason.code, try: job.attempts, maxTries: MAX_ATTEMPTS, kind });
              if (final) queue.block(entry, reason, 'send failed');
              else queue.observe(entry, 'send will be tried again', reason.code);
            }
            if (final) queue.transitionItem(item, { kind: 'blocked', at: 'fetching', problem: reason });
            throw error;
          }
        });
        return;
      }
      const run = async () => {
        signal.throwIfAborted();
        const entries = entriesOf(job);
        if (!entries.length) return;
        const releases = new Map(entries.map((entry) => [entry, entry.release]));
        try {
          await sendUpload(entries, signal);
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
      await withTitleLock(`send:${uploadHash(leader)}`, () => withTitleLock(leader.titleKey, run));
    },
  };
}
