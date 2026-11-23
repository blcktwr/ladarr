import type { AttachCandidates, QueueClientDetail } from '@ladarr/shared/types';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { db } from '../core/db.ts';
import { inside, torrentVideos } from '../library/imports/importer.ts';
import { titleFiles } from '../library/imports/local.ts';
import { entryId, isActive, newEntry, phaseOfEntry } from '../library/downloads/queue.ts';
import { shown } from './queue.ts';
import type { AttachCache, ClientHandle, Clients, QueueEntry, Torrent } from '../types.ts';

export const HASH = /^[0-9a-f]{40}$/;
export const MAX_TORRENTS = 100;
export const MAX_TARGETS = 100;
// Opening the details of several targets of one pack reads the client once.
const TELEMETRY_TTL_MS = 5_000;

export function matchEntry(id: string, hash: unknown) {
  const entry = db.data.queue[id];
  if (entry && shown(entry)) return entry;
  if (typeof hash !== 'string' || !HASH.test(hash)) return;
  const title = db.data.titles[id.slice(0, id.lastIndexOf(':'))];
  const episode = title?.episodes.find((point) => entryId(title.key, point.season, point.number) === id);
  // A catalog episode enters the queue only when the user applies its mapping.
  if (title && episode) return entry ?? newEntry(title.key, episode.season, episode.number, 0);
}

// Says if a download can be attached to the entry. Work that runs now keeps its own path.
export function attachRefusal(entry: QueueEntry): string | null {
  if (entry.release?.uploadPath) return 'This target has an uploaded torrent.';
  if (!isActive(entry)) return 'This target is not waiting for a download.';
  if (['queued', 'searching', 'fetching', 'waiting_slot', 'sending'].includes(phaseOfEntry(entry)) || (entry.state.kind === 'blocked' && ['torrent_missing', 'client_error', 'pack_partial', 'coverage_unknown', 'file_not_found'].includes(entry.state.problem.code))) return null;
  return 'This target is not waiting for a download.';
}

export const torrentInUse = (entry: Pick<QueueEntry, 'titleKey'>, hash: string) =>
  Object.values(db.data.queue).some((other) => other.transferHash === hash && isActive(other) && other.titleKey !== entry.titleKey);

export async function attachCandidates(handles: ClientHandle[], titleKey: string, mapping: boolean, q = '') {
  const byHash = new Map<string, Torrent>();
  for (const list of await Promise.all(handles.map((handle) => handle.api.listAll()))) {
    for (const torrent of list) if ((!mapping || torrent.complete) && !byHash.has(torrent.hash)) byHash.set(torrent.hash, torrent);
  }
  const busy = new Set<string>();
  for (const entry of Object.values(db.data.queue)) if (entry.transferHash && isActive(entry) && entry.titleKey !== titleKey) busy.add(entry.transferHash);
  const free = [...byHash.values()].filter((torrent) => !busy.has(torrent.hash) && (!q || torrent.name.toLowerCase().includes(q))).sort((a, b) => b.addedAt - a.addedAt);
  const torrents: AttachCandidates['torrents'] = (mapping ? free : free.slice(0, MAX_TORRENTS)).map(({ hash, name, sizeBytes, progress, complete, category, addedAt }) =>
    ({ hash, name, sizeBytes, progress, complete, category, addedAt }));
  return { total: free.length, torrents };
}

export async function findDownload(entry: Pick<QueueEntry, 'titleKey' | 'transferHash' | 'clientId'>, clients: Clients, hash: string | undefined): Promise<{ handle: ClientHandle; torrent: Torrent } | { error: 'torrent_in_use' | 'download_not_found' | 'client_missing' | 'torrent_not_found' }> {
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
