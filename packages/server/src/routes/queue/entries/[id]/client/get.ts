import { get } from '../../../../../core/db.ts';
import type { RequestHandler } from 'express';
import type { Clients } from '../../../../../library/downloads/client-api.ts';
import { ClientError } from '../../../../../library/downloads/qbittorrent.ts';
import type { AttachCache } from '../../../../../helpers/queue-attach.ts';
import { pruneCache, readDetail } from '../../../../../helpers/queue-attach.ts';
import { shown } from '../../../../../helpers/queue.ts';

export function queueEntryClientGet(clients: Clients, cache: AttachCache): RequestHandler<{ id: string }> {
  const db = get();
  return async (req, res) => {
    const entry = db.data.queue[req.params.id];
    const handle = clients.get(entry?.clientId);
    if (!entry?.transferHash || !shown(db, entry)) return void res.status(404).json({ error: 'not_found' });
    if (!handle) return void res.status(409).json({ error: 'client_missing' });
    const hash = entry.transferHash;
    const now = Date.now();
    pruneCache(cache, now);
    let item = cache.get(hash);
    if (!item) {
      item = { at: now, value: readDetail(handle, hash) };
      cache.set(hash, item);
      // A failed read must not stay in the cache.
      item.value.catch(() => cache.delete(hash));
    }
    try {
      const detail = await item.value;
      if (!detail) return void res.status(404).json({ error: 'torrent_not_found' });
      res.json({ detail });
    } catch (error) {
      if (error instanceof ClientError) return void res.status(502).json({ error: 'client_unreachable' });
      throw error;
    }
  };
}
