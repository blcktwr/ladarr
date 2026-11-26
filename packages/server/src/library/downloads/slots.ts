import { db } from '../../core/db.ts';
import { isActive, phaseOfEntry } from './queue.ts';
import type { Clients, QueueEntry } from '../../types.ts';

const busy = (entry: QueueEntry) => isActive(entry) && ['sending', 'downloading'].includes(phaseOfEntry(entry));

// The downloads that a client runs now: one for each torrent in Sending or Downloading, and one for each send job that
// still waits for its slot. The targets of the same torrent count once.
export function runningDownloads(clients: Clients, clientId: string, own: ReadonlySet<string>) {
  const hashes = new Set<string>();
  for (const entry of Object.values(db.data.queue)) {
    if (entry.clientId !== clientId || entry.state.kind === 'cancelled' || own.has(entry.id)) continue;
    if (busy(entry) && entry.transferHash) hashes.add(entry.transferHash);
  }
  for (const item of Object.values(db.data.queueItems)) {
    if (!['fetching', 'downloading', 'importing'].includes(item.state.kind)) continue;
    for (const torrent of Object.values(item.selected)) {
      if (torrent.status === 'uncertain' && torrent.clientId === clientId && !Object.keys(torrent.matches).some((id) => own.has(id))) hashes.add(torrent.hash);
    }
  }
  for (const job of Object.values(db.data.jobs)) {
    if (job.type !== 'queue.send' || job.state !== 'running') continue;
    const { entryIds: ids, hash, uploadHash } = job.payload as { entryIds?: unknown; hash?: string; uploadHash?: string };
    if (!Array.isArray(ids)) continue;
    const entries = ids
      .filter((id): id is string => typeof id === 'string' && !own.has(id))
      .map((id) => db.data.queue[id])
      .filter((entry): entry is QueueEntry => Boolean(entry));
    if (!entries.length) continue;
    const leader = entries[0]!;
    if ((leader.clientId ?? clients.next()?.id) !== clientId) continue;
    hashes.add(hash ?? uploadHash ?? leader.transferHash ?? leader.release?.infoHash ?? job.id);
  }
  return hashes.size;
}

// True while the client has room for the torrent of these targets. A limit of zero means no limit.
export function hasFreeSlot(clients: Clients, clientId: string, own: ReadonlySet<string>) {
  const client = clients.get(clientId);
  if (!client || client.config.maxDownloads === 0) return true;
  return runningDownloads(clients, clientId, own) < client.config.maxDownloads;
}
