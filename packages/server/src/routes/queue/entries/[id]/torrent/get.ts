import type { QueueTorrent } from '@ladarr/shared/types';
import type { RequestHandler } from 'express';
import { db } from '../../../../../core/db.ts';
import { shown } from '../../../../../helpers/queue.ts';
import { readTorrent, sendMagnet } from '../../../../../helpers/torrent.ts';
import { ClientError } from '../../../../../library/downloads/qbittorrent.ts';
import { sourceLabel } from '../../../../../library/grab/quality.ts';
import { parseRelease } from '../../../../../library/grab/release.ts';
import type { Clients, IndexerService } from '../../../../../types.ts';

export function queueEntryTorrentGet(indexers: IndexerService, clients: Clients): RequestHandler<{ id: string }> {
  return async (req, res) => {
    const entry = db.data.queue[req.params.id];
    const release = entry?.release;
    if (!entry || !shown(entry) || !release) return void res.status(404).json({ error: 'not_found' });

    const magnet = entry.source && 'magnet' in entry.source ? entry.source.magnet : release.magnet;
    const got = await readTorrent(indexers, release.link, magnet);
    if ('torrent' in got) return void res.json(got.torrent);
    if ('magnet' in got) return sendMagnet(res, got.magnet);

    const handle = clients.get(entry.clientId);
    const hash = entry.transferHash;
    if (handle && hash) {
      try {
        const torrent = await handle.api.find(hash);
        if (torrent) {
          const files = (await handle.api.files(hash)).map(({ name, sizeBytes }) => ({ path: name, sizeBytes }));
          if (files.length) {
            const parsed = parseRelease(release.title);
            return void res.json({
              name: torrent.name || release.title,
              hash: torrent.hash,
              files,
              totalBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
              resolution: parsed.resolution,
              quality: parsed.source === 'unknown' ? null : sourceLabel(parsed.source),
              comment: release.comment ?? null,
              source: null,
              createdBy: null,
              createdAt: null,
              pieceLength: null,
              pieceCount: null,
              private: null,
            } satisfies QueueTorrent);
          }
          if (torrent.status === 'metadata') return void res.status(202).json(null);
        }
      } catch (error) {
        if (error instanceof ClientError) return void res.status(502).json({ error: 'client_unreachable' });
        throw error;
      }
    }

    res.status(got.error === 'indexer_unreachable' ? 502 : 409).json({ error: got.error });
  };
}
