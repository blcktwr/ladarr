import type { Db } from '../core/db.ts';
import { JobError } from '../core/jobs.ts';
import { catalog, itemFields } from '../core/log.ts';
import { createGrabber, reasonOf, type GrabberDeps } from '../acquisition/grab.ts';
import type { Clients } from '../downloads/client-api.ts';
import type { QueueEntry } from '../downloads/queue.ts';
import type { Handler } from '../core/worker.ts';

const MAX_ATTEMPTS = 8;

const busy = (entry: QueueEntry) => entry.stage === 'sending' || entry.stage === 'downloading';

// The downloads of a client that run now: one for each torrent in Sending or Downloading, and one for each grab
// that still fetches its torrent. The targets of the same torrent count once.
function runningDownloads(db: Db, clients: Clients, clientId: string, own: ReadonlySet<string>) {
  const hashes = new Set<string>();
  for (const entry of Object.values(db.data.queue)) {
    if (entry.clientId !== clientId || entry.branch === 'cancelled' || own.has(entry.id)) continue;
    if (busy(entry) && entry.transferHash) hashes.add(entry.transferHash);
  }
  let count = hashes.size;
  for (const job of Object.values(db.data.jobs)) {
    if (job.type !== 'queue.grab' || job.state !== 'running') continue;
    const ids = (job.payload as { entryIds?: unknown }).entryIds;
    if (!Array.isArray(ids)) continue;
    const entries = ids.filter((id): id is string => typeof id === 'string' && !own.has(id)).map((id) => db.data.queue[id]).filter((entry): entry is QueueEntry => Boolean(entry));
    if (!entries.length) continue;
    const leader = entries[0]!;
    if ((leader.clientId ?? clients.next()?.id) !== clientId) continue;
    // A grab that moved its targets to Sending is in the torrents above.
    if (entries.some(busy)) continue;
    count++;
  }
  return count;
}

export function queueGrabHandler(deps: GrabberDeps): Handler {
  const { db, queue, clients } = deps;
  const grab = createGrabber(deps);
  return {
    concurrency: 2,
    maxAttempts: MAX_ATTEMPTS,
    // A target waits in Fetching while its client runs the downloads that it allows.
    canStart: (job) => {
      const { entryIds } = job.payload as { entryIds: string[] };
      const own = new Set(entryIds);
      const leader = entryIds.map((id) => db.data.queue[id]).find((entry) => entry && (entry.stage === 'fetching' || entry.stage === 'sending') && entry.release && !entry.branch);
      if (!leader) return true;
      const client = leader.clientId ? clients.get(leader.clientId) : clients.next();
      if (!client || client.config.maxDownloads === 0) return true;
      return runningDownloads(db, clients, client.id, own) < client.config.maxDownloads;
    },
    run: async (job, { signal }) => {
      const { entryIds } = job.payload as { entryIds: string[] };
      const entries = entryIds.map((id) => queue.get(id)).filter((entry): entry is QueueEntry => Boolean(entry) && (entry!.stage === 'fetching' || entry!.stage === 'sending') && Boolean(entry!.release) && !entry!.branch);
      if (!entries.length) return;
      try {
        await grab(entries, signal);
      } catch (error) {
        if (signal.aborted) throw error;
        const reason = reasonOf(error);
        const kind = error instanceof JobError ? error.kind : 'outage';
        for (const entry of entries) {
          catalog.warn('download_failed', `Download failed: ${reason.code} (try ${job.attempts} of ${MAX_ATTEMPTS})`, itemFields(db, entry), { code: reason.code, try: job.attempts, maxTries: MAX_ATTEMPTS, kind });
        }
        if (kind === 'invalid_input' || job.attempts >= MAX_ATTEMPTS) {
          for (const entry of entries) queue.move(entry, { reason }, 'grab failed');
        } else {
          // The entry stays in Sending. The reason shows why it waits.
          for (const entry of entries) queue.move(entry, { reason }, 'grab will be tried again');
        }
        throw error;
      }
    },
  };
}
