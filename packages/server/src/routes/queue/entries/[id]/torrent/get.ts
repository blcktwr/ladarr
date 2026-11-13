import type { QueueTorrent } from '@ladarr/shared/types';
import type { RequestHandler } from 'express';
import { db } from '../../../../../core/db.ts';
import { shown } from '../../../../../helpers/queue.ts';
import { downloaderOf } from '../../../../../library/grab/grab.ts';
import { torrentInfo } from '../../../../../library/grab/torrent.ts';
import { IndexerError, type IndexerService } from '../../../../../library/grab/torznab.ts';

// What the .torrent of the release holds. ladarr does not keep the file, so the indexer sends it again.
export function queueEntryTorrentGet(indexers: IndexerService): RequestHandler<{ id: string }> {
  return async (req, res) => {
    const entry = db.data.queue[req.params.id];
    const link = entry?.release?.link;
    if (!entry || !shown(entry) || !link) return void res.status(404).json({ error: 'not_found' });
    const indexer = downloaderOf(link);
    if (!indexer) return void res.status(409).json({ error: 'no_indexers' });
    try {
      const got = await indexers.download(indexer, link);
      // The indexer sends a magnet when it has no file to send. A magnet carries no file list.
      if ('magnet' in got) return void res.status(409).json({ error: 'torrent_unavailable' });
      let torrent: QueueTorrent;
      try {
        torrent = torrentInfo(got.torrent);
      } catch {
        // The indexer sent something that is not a torrent.
        return void res.status(409).json({ error: 'torrent_unavailable' });
      }
      res.json(torrent);
    } catch (error) {
      if (error instanceof IndexerError) return void res.status(502).json({ error: 'indexer_unreachable' });
      throw error;
    }
  };
}
