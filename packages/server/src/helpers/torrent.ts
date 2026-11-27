import type { QueueTorrent, QueueTorrentDetail } from '@ladarr/shared/types';
import type { Response } from 'express';
import { downloaderOf } from '../library/grab/grab.ts';
import { sourceLabel } from '../library/grab/quality.ts';
import { parseRelease } from '../library/grab/release.ts';
import { torrentInfo } from '../library/grab/torrent.ts';
import { IndexerError } from '../library/grab/torznab.ts';
import type { IndexerService, ReleaseRef } from '../types.ts';
import { publicText } from './queue.ts';

export function detailOf(hash: string, release: Pick<ReleaseRef, 'title' | 'link' | 'comment'>, files: QueueTorrentDetail['files'], totalBytes: number, name = release.title): QueueTorrentDetail {
  const parsed = parseRelease(release.title);
  return {
    name, hash, files, totalBytes, resolution: parsed.resolution,
    quality: parsed.source === 'unknown' ? null : sourceLabel(parsed.source),
    comment: release.comment ? publicText(release.comment, release.link) : null,
    source: null, createdBy: null, createdAt: null, pieceLength: null, pieceCount: null, private: null,
  };
}

type TorrentSource = { torrent: QueueTorrent } | { magnet: string } | { error: 'torrent_unavailable' | 'no_indexers' | 'indexer_unreachable' };

export async function readTorrent(indexers: IndexerService, link: string | null, magnet: string | null): Promise<TorrentSource> {
  const fallback = magnet?.startsWith('magnet:') ? { magnet } : null;
  if (!link) return fallback ?? { error: 'torrent_unavailable' };
  const indexer = downloaderOf(link);
  if (!indexer) return fallback ?? { error: 'no_indexers' };
  let got: Awaited<ReturnType<IndexerService['download']>>;
  try {
    got = await indexers.download(indexer, link);
  } catch (error) {
    if (!(error instanceof IndexerError)) throw error;
    return fallback ?? { error: 'indexer_unreachable' };
  }
  if ('magnet' in got) return got;
  try {
    return { torrent: torrentInfo(got.torrent) };
  } catch {
    return fallback ?? { error: 'torrent_unavailable' };
  }
}

// A magnet can contain a tracker key. Only an owner session can read the magnet.
export function sendMagnet(res: Response, magnet: string) {
  if (!res.locals.session) return void res.status(403).json({ error: 'session_required' });
  res.json({ magnet });
}
