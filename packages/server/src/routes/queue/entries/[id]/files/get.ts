import { db } from '../../../../../core/db.ts';
import type { QueuePackFiles } from '@ladarr/shared/types';
import type { RequestHandler } from 'express';
import { ClientError } from '../../../../../library/downloads/qbittorrent.ts';
import { isActive } from '../../../../../library/downloads/queue.ts';
import { sharingOf } from '../../../../../library/downloads/queue-api.ts';
import { listDownloadFiles } from '../../../../../library/imports/importer.ts';
import { titleFiles } from '../../../../../library/imports/local.ts';
import { label, shown } from '../../../../../helpers/queue.ts';
import type { Clients } from '../../../../../types.ts';

export function queueEntryFilesGet(clients: Clients): RequestHandler<{ id: string }> {
  return async (req, res) => {
    const entry = db.data.queue[req.params.id];
    if (!entry || !shown(entry)) return void res.status(404).json({ error: 'not_found' });
    // A target without a torrent reads the folder of its title. The files are the same paths as its library records.
    if (!entry.transferHash) {
      const title = db.data.titles[entry.titleKey];
      if (!title) return void res.status(404).json({ error: 'not_found' });
      const folder = await titleFiles(title);
      if (folder.status === 'root_unavailable') return void res.status(409).json({ error: 'root_unavailable' });
      const entries = Object.values(db.data.queue)
        .filter((other) => other.titleKey === entry.titleKey && other.attempt > 0 && isActive(other) && other.season !== null)
        .sort((a, b) => a.season! - b.season! || a.number! - b.number!)
        .map((other) => ({ id: other.id, label: label(other), season: other.season, number: other.number }));
      return void res.json({ files: folder.files, entries } satisfies QueuePackFiles);
    }
    const handle = clients.get(entry.clientId);
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
