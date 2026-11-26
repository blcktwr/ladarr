import type { QueueTorrent, QueueTorrentDetail } from '@ladarr/shared/types';
import type { RequestHandler } from 'express';
import { db } from '../../../../../core/db.ts';
import { publicText, rejectedId, shown } from '../../../../../helpers/queue.ts';
import { readTorrent } from '../../../../../helpers/torrent.ts';
import { itemFor } from '../../../../../library/downloads/queue.ts';
import { ClientError } from '../../../../../library/downloads/qbittorrent.ts';
import { sourceLabel } from '../../../../../library/grab/quality.ts';
import { parseRelease } from '../../../../../library/grab/release.ts';
import { torrentInfo } from '../../../../../library/grab/torrent.ts';
import type { Clients, IndexerService, ReleaseRef } from '../../../../../types.ts';

function detailOf(hash: string, release: ReleaseRef, files: QueueTorrentDetail['files'], totalBytes: number, name = release.title): QueueTorrentDetail {
  const parsed = parseRelease(release.title);
  return {
    name, hash, files, totalBytes, resolution: parsed.resolution,
    quality: parsed.source === 'unknown' ? null : sourceLabel(parsed.source),
    comment: release.comment ? publicText(release.comment, release.link) : null,
    source: null, createdBy: null, createdAt: null, pieceLength: null, pieceCount: null, private: null,
  };
}

export function queueEntryTorrentGet(indexers: IndexerService, clients: Clients): RequestHandler<{ id: string }> {
  return async (req, res) => {
    const entry = db.data.queue[req.params.id];
    if (!entry || !shown(entry)) return void res.status(404).json({ error: 'not_found' });
    const key = typeof req.query.selection === 'string' ? req.query.selection : null;
    const item = itemFor(entry);
    const selected = item && (key
      ? (Object.hasOwn(item.selected, key) ? item.selected[key] : Object.values(item.selected).find(({ release }) => rejectedId(release) === key))
      : Object.values(item.selected).find(({ matches }) => Object.hasOwn(matches, entry.id)));
    const inspecting = key && item?.candidate && rejectedId(item.candidate) === key;
    const release = selected?.release ?? entry.release;
    if (key && !selected && inspecting) return void res.status(202).json(null);
    if (!release || (key && !selected && key !== (entry.transferHash ?? release.infoHash ?? rejectedId(release)))) return void res.status(404).json({ error: 'not_found' });

    const hash = selected?.hash ?? entry.transferHash ?? release.infoHash;
    const saved = hash && db.data.torrents[hash];
    if (saved) {
      try {
        const torrent = torrentInfo(Buffer.from(saved, 'base64'));
        if (torrent.hash === hash) return void res.json({ ...torrent, comment: torrent.comment ? publicText(torrent.comment, release.link) : null } satisfies QueueTorrent);
      } catch {
        // The saved copy cannot supply the file list.
      }
    }

    // After acceptance the queue can discard the saved torrent. Read the original metadata before using the client file list.
    const got = !selected || (selected.status === 'accepted' && release.link)
      ? await readTorrent(indexers, release.link, null)
      : undefined;
    if (got && 'torrent' in got && (!hash || got.torrent.hash === hash)) {
      return void res.json({ ...got.torrent, comment: got.torrent.comment ? publicText(got.torrent.comment, release.link) : null });
    }
    const handle = selected ? (selected.status === 'accepted' ? clients.get(selected.clientId) : undefined) : (entry.transferHash ? clients.get(entry.clientId) : undefined);
    if (handle && hash) {
      try {
        const torrent = await handle.api.find(hash);
        if (torrent) {
          const files = (await handle.api.files(hash)).map(({ name, sizeBytes }) => ({ path: name, sizeBytes }));
          if (files.length) {
            return void res.json(detailOf(torrent.hash, release, files, files.reduce((sum, file) => sum + file.sizeBytes, 0), torrent.name || release.title));
          }
          if (torrent.status === 'metadata') return void res.status(202).json(null);
        }
      } catch (error) {
        if (error instanceof ClientError) return void res.status(502).json({ error: 'client_unreachable' });
        throw error;
      }
    }

    const manifest = selected?.manifest;
    if (hash && manifest?.length) return void res.json(detailOf(hash, release, manifest.map((path) => ({ path, sizeBytes: null })), release.sizeBytes));
    const error = got && 'error' in got ? got.error : 'torrent_unavailable';
    res.status(error === 'indexer_unreachable' ? 502 : 409).json({ error });
  };
}
