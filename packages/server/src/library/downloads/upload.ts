import { db } from '../../core/db.ts';
import type { Clients, EnqueueInput, Job, QueueEntry } from '../../types.ts';
import { addedByApp, isActive, ownsUpload, phaseOfEntry } from './queue.ts';

export const uploadHash = (entry: QueueEntry) => entry.release?.uploadPath ? entry.release.infoHash : null;

export function uploadOwner(titleKey: string, hash: string, clientId: string) {
  return Object.values(db.data.queue).some((entry) => {
    if (entry.titleKey !== titleKey || entry.transferHash !== hash || entry.clientId !== clientId) return false;
    if (entry.release?.uploadPath) return ownsUpload(entry);
    return !entry.release?.external && ['downloading', 'importing', 'available'].includes(phaseOfEntry(entry)) && addedByApp(hash);
  }) ? clientId : undefined;
}

export function uploadInUse(titleKey: string, hash: string) {
  return Object.values(db.data.queue).some((entry) => entry.titleKey !== titleKey && isActive(entry) && (entry.transferHash === hash || entry.release?.infoHash === hash))
    || Object.values(db.data.files).some((file) => file.titleKey !== titleKey && !file.missing && file.download?.hash === hash);
}

export async function findUpload(clients: Clients, hash: string, preferred?: string | null) {
  const handles = clients.all();
  const results = await Promise.allSettled(handles.map(async (handle) => {
    const torrent = await handle.api.find(hash);
    return torrent?.hash === hash ? { handle, torrent } : null;
  }));
  const found = results.flatMap((result) => result.status === 'fulfilled' && result.value ? [result.value] : []);
  const download = found.find(({ handle }) => handle.id === preferred) ?? found[0];
  if (!download) {
    const error = results.find((result) => result.status === 'rejected');
    if (error) throw error.reason;
  }
  return { download, handle: download?.handle ?? handles.find((handle) => handle.id === preferred) ?? handles[0] };
}

export function enqueueUpload(enqueue: (input: EnqueueInput) => Job, entries: QueueEntry[], hash: string) {
  const job = enqueue({
    type: 'queue.send', payload: { entryIds: entries.map((entry) => entry.id), uploadHash: hash },
    dedupeKey: `send:upload:${hash}`, runAt: Math.min(...entries.map((entry) => entry.createdAt)),
    priority: entries.some((entry) => entry.priority !== null),
  });
  if (job.state === 'waiting') {
    const payload = job.payload as { entryIds: string[]; uploadHash: string };
    payload.entryIds = [...new Set([...payload.entryIds, ...entries.map((entry) => entry.id)])];
  }
  return job;
}
