import { get } from '../../../../../core/db.ts';
import type { AttachCandidates } from '@ladarr/shared/types';
import type { RequestHandler } from 'express';
import type { Clients } from '../../../../../library/downloads/client-api.ts';
import { ClientError, type Torrent } from '../../../../../library/downloads/qbittorrent.ts';
import { isActive } from '../../../../../library/downloads/queue.ts';
import { attachRefusal, MAX_TORRENTS } from '../../../../../helpers/queue-attach.ts';
import { label, shown } from '../../../../../helpers/queue.ts';

// The torrents of the client that the user can attach to the target, and the targets that can share the download.
export function queueEntryExternalGet(clients: Clients): RequestHandler<{ id: string }> {
  const db = get();
  return async (req, res) => {
    const entry = db.data.queue[req.params.id];
    const handles = clients.all();
    if (!entry || !shown(db, entry)) return void res.status(404).json({ error: 'not_found' });
    const refusal = attachRefusal(entry);
    if (refusal) return void res.status(409).json({ error: 'attach_not_supported', reason: refusal });
    if (!handles.length) return void res.status(409).json({ error: 'client_missing' });
    const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
    let all: Torrent[];
    try {
      // A torrent that two clients have shows once.
      const byHash = new Map<string, Torrent>();
      for (const list of await Promise.all(handles.map((handle) => handle.api.listAll()))) for (const torrent of list) if (!byHash.has(torrent.hash)) byHash.set(torrent.hash, torrent);
      all = [...byHash.values()];
    } catch (error) {
      if (error instanceof ClientError) return void res.status(502).json({ error: 'client_unreachable' });
      throw error;
    }
    // A torrent that works for a target of another title is not free.
    const busy = new Set<string>();
    for (const other of Object.values(db.data.queue)) if (other.transferHash && isActive(other) && other.titleKey !== entry.titleKey) busy.add(other.transferHash);
    const free = all.filter((torrent) => !busy.has(torrent.hash) && (!q || torrent.name.toLowerCase().includes(q))).sort((a, b) => b.addedAt - a.addedAt);
    const siblings =
      entry.season === null
        ? []
        : Object.values(db.data.queue).filter((other) => other.id !== entry.id && other.titleKey === entry.titleKey && other.season === entry.season && shown(db, other) && attachRefusal(other) === null);
    const body: AttachCandidates = {
      total: free.length,
      torrents: free.slice(0, MAX_TORRENTS).map((torrent) => ({
        hash: torrent.hash,
        name: torrent.name,
        sizeBytes: torrent.sizeBytes,
        progress: torrent.progress,
        complete: torrent.complete,
        category: torrent.category,
        addedAt: torrent.addedAt,
      })),
      siblings: siblings.sort((a, b) => (a.number ?? 0) - (b.number ?? 0)).map((other) => ({ id: other.id, label: label(db, other) })),
    };
    res.json(body);
  };
}
