import type { QueueClientDetail } from '@ladarr/shared/types';
import type { ClientHandle } from '../library/downloads/qbittorrent.ts';
import { isActive, type QueueEntry } from '../library/downloads/queue.ts';

export const HASH = /^[0-9a-f]{40}$/;
export const MAX_TORRENTS = 100;
export const MAX_TARGETS = 100;
// Opening the details of several targets of one pack reads the client once.
const TELEMETRY_TTL_MS = 5_000;

// Says if a download can be attached to the entry. Work that runs now keeps its own path.
export function attachRefusal(entry: QueueEntry): string | null {
  if (!isActive(entry)) return 'This target is not waiting for a download.';
  if (['queued', 'searching', 'fetching', 'sending'].includes(entry.stage) || entry.reason?.code === 'torrent_missing') return null;
  return 'This target is not waiting for a download.';
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

export type AttachCache = Map<string, { at: number; value: Promise<QueueClientDetail | null> }>;

export const createAttachCache = (): AttachCache => new Map();

export function pruneCache(cache: AttachCache, now: number) {
  for (const [key, item] of cache) if (now - item.at > TELEMETRY_TTL_MS) cache.delete(key);
}
