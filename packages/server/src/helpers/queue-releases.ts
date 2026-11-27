import { db } from '../core/db.ts';
import { itemFor } from '../library/downloads/queue.ts';
import { ClientError } from '../library/downloads/qbittorrent.ts';
import { hashOfMagnet, readSource } from '../library/grab/source.ts';
import { IndexerError } from '../library/grab/torznab.ts';
import { isSample, isVideoFile } from '../library/parse.ts';
import type { Clients, IndexerService, QueueEntry, RejectedRelease } from '../types.ts';
import { findRejected, shown } from './queue.ts';

// A legacy search can omit the hash. The first manifest identifies the source for later requests.
const manifestHashes = new WeakMap<RejectedRelease, string>();

export function mappingFile(path: string, sizeBytes: number | null = null) {
  return (sizeBytes === null || sizeBytes > 0) && isVideoFile(path) && !isSample(path) && Buffer.byteLength(path) <= 4096 &&
    !/[\\\x00-\x1f]/.test(path) && path.split('/').every((part) =>
      part.trim() && part !== '.' && part !== '..' && Buffer.byteLength(part) <= 255 && !/^[a-z]:/i.test(part));
}

export function seasonRejection(entry: QueueEntry, indexerId: number, guid: string) {
  const release = findRejected(entry, indexerId, guid);
  if (release || itemFor(entry) || entry.season === null) return release;
  // Before season items, each episode kept its own search.
  for (const other of Object.values(db.data.queue)) {
    if (other.titleKey !== entry.titleKey || other.season !== entry.season || other.clearedAt || !shown(other)) continue;
    const candidate = findRejected(other, indexerId, guid);
    if (candidate) return candidate;
  }
}

export async function rejectedSource(entry: QueueEntry, candidate: RejectedRelease, indexers: IndexerService, clients: Clients) {
  const matches = (release: { indexerId: number; guid: string } | null) => release?.indexerId === candidate.indexerId && release.guid === candidate.guid;
  const item = itemFor(entry);
  const retained = Object.values(item?.selected ?? {}).find(({ release }) => matches(release));
  const legacy = item ? undefined : Object.values(db.data.queue).find((other) => other.titleKey === entry.titleKey && other.season === entry.season &&
    other.source && matches(other.release));
  const stored = retained?.source ?? legacy?.source;
  const storedHash = retained?.hash ?? legacy?.transferHash ?? legacy?.release?.infoHash;
  const hash = candidate.infoHash?.toLowerCase() ?? (candidate.magnet ? hashOfMagnet(candidate.magnet) : undefined) ?? storedHash ?? manifestHashes.get(candidate);
  if (hash && storedHash && storedHash !== hash) return { error: 'invalid_torrent' } as const;
  const saved = hash && db.data.torrents[hash];
  const magnet = stored && 'magnet' in stored ? stored.magnet : retained?.manifest?.length ? retained.release.magnet ?? candidate.magnet : null;
  const held = saved ? { torrent: Buffer.from(saved, 'base64') } : magnet ? { magnet, files: retained?.manifest } : undefined;
  const indexer = db.data.indexers[candidate.indexerId];
  const release = { ...candidate, infoHash: hash ?? null, indexerName: indexer?.push.sonarr?.name ?? 'Indexer', manual: true };
  try {
    const result = await readSource(release, indexer, indexers, clients, new AbortController().signal, held);
    if ('waiting' in result) return { error: 'metadata_unavailable' } as const;
    if ('problem' in result) return { error: result.problem } as const;
    const { evidence } = result;
    const previous = manifestHashes.get(candidate);
    if ((hash && hash !== evidence.hash) || (previous && previous !== evidence.hash)) {
      return { error: 'torrent' in evidence.source ? 'invalid_torrent' : 'invalid_magnet' } as const;
    }
    if ('magnet' in evidence.source && new Set(evidence.files).size !== evidence.files.length) {
      return { error: 'invalid_magnet' } as const;
    }
    manifestHashes.set(candidate, evidence.hash);
    return { evidence } as const;
  } catch (error) {
    if (error instanceof IndexerError) return { error: 'indexer_unreachable' } as const;
    if (error instanceof ClientError) return { error: 'client_unreachable' } as const;
    throw error;
  }
}
