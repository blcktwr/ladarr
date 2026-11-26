import type { RequestHandler } from 'express';
import { db } from '../../../../../../core/db.ts';
import { shown } from '../../../../../../helpers/queue.ts';
import { readTorrent, sendMagnet } from '../../../../../../helpers/torrent.ts';
import type { IndexerService } from '../../../../../../types.ts';

// The request identifies the rejected release by indexer ID and GUID.
export function queueEntryReleaseTorrentGet(indexers: IndexerService): RequestHandler<{ id: string }> {
  return async (req, res) => {
    const entry = db.data.queue[req.params.id];
    if (!entry || !shown(entry)) return void res.status(404).json({ error: 'not_found' });
    const indexerId = Number(req.query.indexerId);
    const guid = typeof req.query.guid === 'string' ? req.query.guid : null;
    if (!Number.isInteger(indexerId) || !guid) return void res.status(400).json({ error: 'invalid_request' });
    const release = (entry.search?.rejected ?? []).find((item) => item.indexerId === indexerId && item.guid === guid);
    if (!release) return void res.status(404).json({ error: 'release_not_found' });
    const got = await readTorrent(indexers, release.link, release.magnet);
    if ('torrent' in got) return void res.json(got.torrent);
    if ('magnet' in got) return sendMagnet(res, got.magnet);
    res.status(got.error === 'indexer_unreachable' ? 502 : 409).json({ error: got.error });
  };
}
