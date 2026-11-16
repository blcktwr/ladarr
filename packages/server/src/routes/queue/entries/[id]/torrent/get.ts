import type { RequestHandler } from 'express';
import { db } from '../../../../../core/db.ts';
import { shown } from '../../../../../helpers/queue.ts';
import { readTorrent } from '../../../../../helpers/torrent.ts';
import { IndexerError } from '../../../../../library/grab/torznab.ts';
import type { IndexerService } from '../../../../../types.ts';

// What the .torrent of the release holds. ladarr does not keep the file, so the indexer sends it again.
export function queueEntryTorrentGet(indexers: IndexerService): RequestHandler<{ id: string }> {
  return async (req, res) => {
    const entry = db.data.queue[req.params.id];
    const link = entry?.release?.link;
    if (!entry || !shown(entry) || !link) return void res.status(404).json({ error: 'not_found' });
    try {
      const got = await readTorrent(indexers, link);
      if ('error' in got) return void res.status(409).json({ error: got.error });
      res.json(got.torrent);
    } catch (error) {
      if (error instanceof IndexerError) return void res.status(502).json({ error: 'indexer_unreachable' });
      throw error;
    }
  };
}
