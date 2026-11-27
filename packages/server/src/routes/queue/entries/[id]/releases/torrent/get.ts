import type { QueueTorrentDetail } from '@ladarr/shared/types';
import type { RequestHandler } from 'express';
import { db } from '../../../../../../core/db.ts';
import { mappingFile, rejectedSource, seasonRejection } from '../../../../../../helpers/queue-releases.ts';
import { publicText, shown } from '../../../../../../helpers/queue.ts';
import { detailOf } from '../../../../../../helpers/torrent.ts';
import { torrentInfo } from '../../../../../../library/grab/torrent.ts';
import type { Clients, IndexerService } from '../../../../../../types.ts';

// The request uses the rejection ID from the queue.
export function queueEntryReleaseTorrentGet(indexers: IndexerService, clients: Clients): RequestHandler<{ id: string }> {
  return async (req, res) => {
    const entry = db.data.queue[req.params.id];
    if (!entry || !shown(entry)) return void res.status(404).json({ error: 'not_found' });
    const indexerId = Number(req.query.indexerId);
    const guid = typeof req.query.guid === 'string' ? req.query.guid : null;
    if (!Number.isInteger(indexerId) || !guid) return void res.status(400).json({ error: 'invalid_request' });
    const release = seasonRejection(entry, indexerId, guid);
    if (!release) return void res.status(404).json({ error: 'release_not_found' });
    const result = await rejectedSource(entry, release, indexers, clients);
    if (!result.evidence) return void res.status(result.error.endsWith('_unreachable') ? 502 : 409).json({ error: result.error });
    const { source, hash, files } = result.evidence;
    const torrent: QueueTorrentDetail = 'torrent' in source ? torrentInfo(source.torrent, true)
      : detailOf(hash, release, files.map((path) => ({ path, sizeBytes: null })), release.sizeBytes);
    if (torrent.comment) torrent.comment = publicText(torrent.comment, release.link);
    if (req.query.mapping === 'true') torrent.files = torrent.files.filter(({ path, sizeBytes }) => mappingFile(path, sizeBytes));
    res.json(torrent);
  };
}
