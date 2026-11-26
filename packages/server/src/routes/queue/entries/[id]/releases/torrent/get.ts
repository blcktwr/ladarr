import type { RequestHandler } from 'express';
import { db } from '../../../../../../core/db.ts';
import { findRejected, publicText, shown } from '../../../../../../helpers/queue.ts';
import { readTorrent } from '../../../../../../helpers/torrent.ts';
import type { IndexerService } from '../../../../../../types.ts';

// The request uses the rejection ID from the queue.
export function queueEntryReleaseTorrentGet(indexers: IndexerService): RequestHandler<{ id: string }> {
  return async (req, res) => {
    const entry = db.data.queue[req.params.id];
    if (!entry || !shown(entry)) return void res.status(404).json({ error: 'not_found' });
    const indexerId = Number(req.query.indexerId);
    const guid = typeof req.query.guid === 'string' ? req.query.guid : null;
    if (!Number.isInteger(indexerId) || !guid) return void res.status(400).json({ error: 'invalid_request' });
    const release = findRejected(entry, indexerId, guid);
    if (!release) return void res.status(404).json({ error: 'release_not_found' });
    const got = await readTorrent(indexers, release.link, release.magnet);
    if ('torrent' in got) return void res.json({ ...got.torrent, comment: got.torrent.comment ? publicText(got.torrent.comment, release.link) : null });
    const error = 'error' in got ? got.error : 'torrent_unavailable';
    res.status(error === 'indexer_unreachable' ? 502 : 409).json({ error });
  };
}
