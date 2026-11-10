import { db } from '../../../../../core/db.ts';
import type { QueuePackFiles } from '@ladarr/shared/types';
import type { RequestHandler } from 'express';
import type { Clients } from '../../../../../library/downloads/client-api.ts';
import { ClientError } from '../../../../../library/downloads/qbittorrent.ts';
import { sharingOf } from '../../../../../library/downloads/queue-api.ts';
import { listDownloadFiles } from '../../../../../library/imports/importer.ts';
import { label, shown } from '../../../../../helpers/queue.ts';

export function queueEntryFilesGet(clients: Clients): RequestHandler<{ id: string }> {
  return async (req, res) => {
    const entry = db.data.queue[req.params.id];
    const handle = clients.get(entry?.clientId);
    if (!entry?.transferHash || !shown(entry)) return void res.status(404).json({ error: 'not_found' });
    if (!handle) return void res.status(409).json({ error: 'client_missing' });
    try {
      const files = await listDownloadFiles(handle, entry.transferHash);
      if (!files) return void res.status(409).json({ error: 'download_not_found' });
      res.json({ files, entries: sharingOf(entry).map((other) => ({ id: other.id, label: label(other), season: other.season, number: other.number })) } satisfies QueuePackFiles);
    } catch (error) {
      if (error instanceof ClientError) return void res.status(502).json({ error: 'client_unreachable' });
      throw error;
    }
  };
}
