import type { QueueClientDetail } from '@ladarr/shared/types';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { db } from '../core/db.ts';
import { inside, torrentVideos } from '../library/imports/importer.ts';
import { titleFiles } from '../library/imports/local.ts';
import { isActive, phaseOfEntry } from '../library/downloads/queue.ts';
import type { AttachCache, ClientHandle, Clients, QueueEntry, Torrent } from '../types.ts';

export const HASH = /^[0-9a-f]{40}$/;
export const MAX_TORRENTS = 100;
export const MAX_TARGETS = 100;
// Opening the details of several targets of one pack reads the client once.
const TELEMETRY_TTL_MS = 5_000;

// Says if a download can be attached to the entry. Work that runs now keeps its own path.
export function attachRefusal(entry: QueueEntry): string | null {
  if (!isActive(entry)) return 'This target is not waiting for a download.';
  if (['queued', 'searching', 'fetching', 'waiting_slot', 'sending'].includes(phaseOfEntry(entry)) || (entry.state.kind === 'blocked' && ['torrent_missing', 'client_error', 'pack_partial', 'coverage_unknown', 'file_not_found'].includes(entry.state.problem.code))) return null;
  return 'This target is not waiting for a download.';
}

export const torrentInUse = (entry: QueueEntry, hash: string) =>
  Object.values(db.data.queue).some((other) => other.transferHash === hash && isActive(other) && other.titleKey !== entry.titleKey);

async function findDownload(entry: QueueEntry, clients: Clients, hash: string | undefined): Promise<{ handle: ClientHandle; torrent: Torrent } | { error: 'torrent_in_use' | 'download_not_found' | 'client_missing' | 'torrent_not_found' }> {
  if (hash && torrentInUse(entry, hash)) return { error: 'torrent_in_use' };
  const transfer = hash ?? entry.transferHash;
  if (!transfer) return { error: 'download_not_found' };
  const owner = hash ? Object.values(db.data.queue).find((other) => other.transferHash === hash && other.clientId && isActive(other)) : entry;
  const handles = owner ? [clients.get(owner.clientId)].filter((handle): handle is ClientHandle => Boolean(handle)) : clients.all();
  if (!handles.length) return { error: 'client_missing' };
  for (const handle of handles) {
    const torrent = await handle.api.find(transfer);
    if (torrent && (!hash || torrent.complete)) return { handle, torrent };
  }
  return { error: hash ? 'torrent_not_found' : 'download_not_found' };
}

export async function matchSource(entry: QueueEntry, clients: Clients, source: 'library' | 'download' = entry.transferHash ? 'download' : 'library', hash?: string) {
  const title = db.data.titles[entry.titleKey]!;
  if (source === 'library') {
    const folder = await titleFiles(title);
    if (folder.status === 'root_unavailable') return { error: 'root_unavailable' } as const;
    const root = title.rootId ? db.data.roots[title.rootId] : undefined;
    if (!root) return { error: 'root_unavailable' } as const;
    const files = await Promise.all(folder.files.map(async (file) => {
      const abs = join(root.path, file.rel);
      const info = inside(root.path, abs) ? await stat(abs).catch(() => undefined) : undefined;
      return { ...file, abs, mtimeMs: info?.mtimeMs ?? null, ino: info?.ino ?? null, dev: info?.dev ?? null };
    }));
    return { files, manifest: files, download: null };
  }
  const download = await findDownload(entry, clients, hash);
  if ('error' in download) return download;
  const { handle, torrent } = download;
  const manifest = (await handle.api.files(torrent.hash)).map(({ name, sizeBytes }) => ({ name, sizeBytes })).sort((a, b) => a.name.localeCompare(b.name));
  const found = await torrentVideos(handle, torrent);
  if (!found) return { error: 'download_not_found' } as const;
  const files = await Promise.all(found.map(async (file) => {
    const info = await stat(file.abs).catch(() => undefined);
    return { ...file, mtimeMs: info?.mtimeMs ?? null, ino: info?.ino ?? null, dev: info?.dev ?? null };
  }));
  return {
    download,
    files,
    manifest: hash ? { clientId: handle.id, savePath: torrent.savePath, contentPath: torrent.contentPath, manifest, files } : manifest,
  };
}

const hostOf = (address: string) => {
  try {
    return new URL(address).hostname || null;
  } catch {
    return null;
  }
};

// The client details of one torrent. A part that the client does not give stays null: unknown is not zero.
export async function readDetail(handle: ClientHandle, hash: string): Promise<QueueClientDetail | null> {
  const torrent = (await handle.api.byHashes([hash]))[0];
  if (!torrent) return null;
  const [trackers, slots] = await Promise.all([handle.api.trackers(hash).catch(() => null), handle.api.slots().catch(() => null)]);
  return {
    observedAt: Date.now(),
    state: torrent.state,
    status: torrent.status,
    tracker: torrent.tracker ? hostOf(torrent.tracker) : null,
    trackers,
    swarm: { seeds: torrent.swarmSeeds, peers: torrent.swarmPeers },
    availability: torrent.availability,
    queue: { waiting: torrent.state === 'queuedDL' || torrent.state === 'queuedUP', position: torrent.queuePosition },
    slots,
  };
}

export const createAttachCache = (): AttachCache => new Map();

export function pruneCache(cache: AttachCache, now: number) {
  for (const [key, item] of cache) if (now - item.at > TELEMETRY_TTL_MS) cache.delete(key);
}
