import type { Clients, Indexer, IndexerService, ReleaseRef } from '../../types.ts';
import { magnetHash, torrentInfo } from './torrent.ts';
import { IndexerError } from './torznab.ts';

type Evidence =
  | { hash: string; files: string[]; source: { torrent: Buffer }; comment?: string }
  | { hash: string; files: string[]; source: { magnet: string }; comment?: undefined };

export function linkOf(link: string | null) {
  if (!link) return null;
  try {
    const url = new URL(link);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

export const hashOfMagnet = (magnet: string) => /^magnet:\?/i.test(magnet) ? magnetHash(magnet) : undefined;

export function torrentManifest(bytes: Buffer) {
  const { hash, files, comment } = torrentInfo(bytes, true);
  return { hash, files: files.filter(({ sizeBytes }) => sizeBytes > 0).map(({ path }) => path), comment: comment ?? undefined };
}

export async function readSource(
  release: ReleaseRef, indexer: Indexer | undefined, indexers: IndexerService, clients: Clients, signal: AbortSignal,
  held?: { magnet: string; files?: string[] } | { torrent: Buffer },
): Promise<{ evidence: Evidence } | { problem: string } | { waiting: { magnet: string } }> {
  const link = linkOf(release.link);
  let source = held;
  if (!source && link && indexer && link.origin === new URL(indexer.baseUrl).origin) {
    try {
      source = await indexers.download(indexer, link.href, { signal });
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof IndexerError && error.code === 'invalid_response') return { problem: 'invalid_torrent' };
      throw error;
    }
  }
  if (!source && release.magnet) source = { magnet: release.magnet };
  signal.throwIfAborted();
  if (!source) return { problem: 'no_download_link' };
  if ('torrent' in source) {
    try {
      const manifest = torrentManifest(source.torrent);
      if (release.infoHash && manifest.hash !== release.infoHash.toLowerCase()) return { problem: 'invalid_torrent' };
      return { evidence: { ...manifest, source } };
    } catch {
      return { problem: 'invalid_torrent' };
    }
  }
  const hash = hashOfMagnet(source.magnet);
  if (!hash) return { problem: 'invalid_magnet' };
  if (held && 'magnet' in held && held.files?.length) {
    if (hash !== release.infoHash) return { problem: 'invalid_magnet' };
    return { evidence: { hash, files: held.files, source: { magnet: source.magnet } } };
  }
  const connection = clients.next();
  if (!connection) return { waiting: source };
  const files = await connection.api.metadataFiles(source.magnet, hash, signal);
  signal.throwIfAborted();
  return files.some(Boolean) ? { evidence: { hash, files, source } } : { problem: 'metadata_unavailable' };
}
