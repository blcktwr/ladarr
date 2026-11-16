import type { QueueTorrent } from '@ladarr/shared/types';
import { downloaderOf } from '../library/grab/grab.ts';
import { torrentInfo } from '../library/grab/torrent.ts';
import type { IndexerService } from '../types.ts';

// What the .torrent of a link holds. ladarr does not keep the file, so the indexer sends it again. The indexer sends a
// magnet when it has no file to send, and a magnet carries no file list.
export async function readTorrent(indexers: IndexerService, link: string): Promise<{ torrent: QueueTorrent } | { error: 'torrent_unavailable' | 'no_indexers' }> {
  const indexer = downloaderOf(link);
  if (!indexer) return { error: 'no_indexers' };
  const got = await indexers.download(indexer, link);
  if ('magnet' in got) return { error: 'torrent_unavailable' };
  try {
    return { torrent: torrentInfo(got.torrent) };
  } catch {
    // The indexer sent something that is not a torrent.
    return { error: 'torrent_unavailable' };
  }
}
