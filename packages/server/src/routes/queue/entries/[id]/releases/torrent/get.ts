import type { RequestHandler } from 'express';
import { db } from '../../../../../../core/db.ts';
import { shown } from '../../../../../../helpers/queue.ts';
import { readTorrent } from '../../../../../../helpers/torrent.ts';
import { IndexerError, type IndexerService } from '../../../../../../library/grab/torznab.ts';

// What the .torrent of a rejected release holds, so a person reads its files before a manual grab. The link stays on
// the server, so the client names the release by its indexer and its guid.
export function queueEntryReleaseTorrentGet(indexers: IndexerService): RequestHandler<{ id: string }> {
  return async (req, res) => {
    const entry = db.data.queue[req.params.id];
    if (!entry || !shown(entry)) return void res.status(404).json({ error: 'not_found' });
    const indexerId = Number(req.query.indexerId);
    const guid = typeof req.query.guid === 'string' ? req.query.guid : null;
    if (!Number.isInteger(indexerId) || !guid) return void res.status(400).json({ error: 'invalid_request' });
    const release = (entry.search?.rejected ?? []).find((item) => item.indexerId === indexerId && item.guid === guid);
    if (!release) return void res.status(404).json({ error: 'release_not_found' });
    if (!release.link) return void res.status(409).json({ error: 'torrent_unavailable' });
    try {
      const got = await readTorrent(indexers, release.link);
      if ('error' in got) return void res.status(409).json({ error: got.error });
      res.json(got.torrent);
    } catch (error) {
      if (error instanceof IndexerError) return void res.status(502).json({ error: 'indexer_unreachable' });
      throw error;
    }
  };
}
