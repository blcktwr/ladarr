import type { AttachCandidates, AttachPreview, QueueClientDetail } from '@ladarr/shared/types';
import { Router } from 'express';
import type { Db } from '../core/db.ts';
import type { Clients } from './client-api.ts';
import { ClientError, type ClientHandle, type Torrent } from './qbittorrent.ts';
import { isActive, type Queue, type QueueEntry } from './queue.ts';
import { attachTorrent } from './attach.ts';

type Deps = {
  db: Db;
  queue: Queue;
  clients: Clients;
  shown: (entry: QueueEntry) => boolean;
  label: (entry: QueueEntry) => string;
};

const HASH = /^[0-9a-f]{40}$/;
const MAX_TORRENTS = 100;
const MAX_TARGETS = 100;
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
async function readDetail(handle: ClientHandle, hash: string): Promise<QueueClientDetail | null> {
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

export function attachRouter({ db, queue, clients, shown, label }: Deps) {
  const router = Router();
  const cache = new Map<string, { at: number; value: Promise<QueueClientDetail | null> }>();

  router.get('/entries/:id/client', async (req, res) => {
    const entry = db.data.queue[req.params.id];
    const handle = clients.get(entry?.clientId);
    if (!entry?.transferHash || !shown(entry)) return void res.status(404).json({ error: 'not_found' });
    if (!handle) return void res.status(409).json({ error: 'client_missing' });
    const hash = entry.transferHash;
    const now = Date.now();
    for (const [key, item] of cache) if (now - item.at > TELEMETRY_TTL_MS) cache.delete(key);
    let item = cache.get(hash);
    if (!item) {
      item = { at: now, value: readDetail(handle, hash) };
      cache.set(hash, item);
      // A failed read must not stay in the cache.
      item.value.catch(() => cache.delete(hash));
    }
    try {
      const detail = await item.value;
      if (!detail) return void res.status(404).json({ error: 'torrent_not_found' });
      res.json({ detail });
    } catch (error) {
      if (error instanceof ClientError) return void res.status(502).json({ error: 'client_unreachable' });
      throw error;
    }
  });

  // The torrents of the client that the user can attach to the target, and the targets that can share the download.
  router.get('/entries/:id/external', async (req, res) => {
    const entry = db.data.queue[req.params.id];
    const handles = clients.all();
    if (!entry || !shown(entry)) return void res.status(404).json({ error: 'not_found' });
    const refusal = attachRefusal(entry);
    if (refusal) return void res.status(409).json({ error: 'attach_not_supported', reason: refusal });
    if (!handles.length) return void res.status(409).json({ error: 'client_missing' });
    const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
    let all: Torrent[];
    try {
      // A torrent that two clients have shows once.
      const byHash = new Map<string, Torrent>();
      for (const list of await Promise.all(handles.map((handle) => handle.api.listAll()))) for (const torrent of list) if (!byHash.has(torrent.hash)) byHash.set(torrent.hash, torrent);
      all = [...byHash.values()];
    } catch (error) {
      if (error instanceof ClientError) return void res.status(502).json({ error: 'client_unreachable' });
      throw error;
    }
    // A torrent that works for a target of another title is not free.
    const busy = new Set<string>();
    for (const other of Object.values(db.data.queue)) if (other.transferHash && isActive(other) && other.titleKey !== entry.titleKey) busy.add(other.transferHash);
    const free = all.filter((torrent) => !busy.has(torrent.hash) && (!q || torrent.name.toLowerCase().includes(q))).sort((a, b) => b.addedAt - a.addedAt);
    const siblings =
      entry.season === null
        ? []
        : Object.values(db.data.queue).filter((other) => other.id !== entry.id && other.titleKey === entry.titleKey && other.season === entry.season && shown(other) && attachRefusal(other) === null);
    const body: AttachCandidates = {
      total: free.length,
      torrents: free.slice(0, MAX_TORRENTS).map((torrent) => ({
        hash: torrent.hash,
        name: torrent.name,
        sizeBytes: torrent.sizeBytes,
        progress: torrent.progress,
        complete: torrent.complete,
        category: torrent.category,
        addedAt: torrent.addedAt,
      })),
      siblings: siblings.sort((a, b) => (a.number ?? 0) - (b.number ?? 0)).map((other) => ({ id: other.id, label: label(other) })),
    };
    res.json(body);
  });

  // Attaches a torrent that is in the client already. The user confirms the owner and the title before anything changes.
  router.post('/entries/:id/attach', async (req, res) => {
    const entry = db.data.queue[req.params.id];
    const { hash: rawHash, ids, confirmOwner, confirmTitle, preview } = (req.body ?? {}) as { hash?: unknown; ids?: unknown; confirmOwner?: unknown; confirmTitle?: unknown; preview?: unknown };
    if (!entry || !shown(entry)) return void res.status(404).json({ error: 'not_found' });
    const hash = typeof rawHash === 'string' ? rawHash.toLowerCase() : '';
    if (!HASH.test(hash) || (ids !== undefined && (!Array.isArray(ids) || ids.length > MAX_TARGETS || !ids.every((id) => typeof id === 'string')))) return void res.status(400).json({ error: 'invalid_request' });
    if (!preview && (confirmOwner !== true || confirmTitle !== true)) return void res.status(400).json({ error: 'confirmation_required' });

    const targets = [entry];
    for (const id of (ids ?? []) as string[]) {
      const other = db.data.queue[id];
      if (!other || !shown(other) || other.titleKey !== entry.titleKey) return void res.status(400).json({ error: 'invalid_request' });
      if (!targets.includes(other)) targets.push(other);
    }
    const refused = () =>
      targets.flatMap((target) => {
        const reason = attachRefusal(target);
        return reason ? [{ id: target.id, reason }] : [];
      });
    const unsupported = refused();
    if (unsupported.length) return void res.status(409).json({ error: 'attach_not_supported', unsupported });

    const handles = clients.all();
    if (!handles.length) return void res.status(409).json({ error: 'client_missing' });
    let torrent: Torrent | undefined;
    let owner: ClientHandle | undefined;
    try {
      for (const handle of handles) {
        torrent = (await handle.api.byHashes([hash]))[0];
        if (torrent) {
          owner = handle;
          break;
        }
      }
    } catch (error) {
      if (error instanceof ClientError) return void res.status(502).json({ error: 'client_unreachable' });
      throw error;
    }
    if (!torrent || !owner) return void res.status(404).json({ error: 'torrent_not_found' });
    // The client took time to answer. A target can have changed in that time, so the targets are checked again, and no wait follows.
    const changed = refused();
    if (changed.length) return void res.status(409).json({ error: 'attach_not_supported', unsupported: changed });
    if (Object.values(db.data.queue).some((other) => other.transferHash === hash && isActive(other) && other.titleKey !== entry.titleKey)) return void res.status(409).json({ error: 'torrent_in_use' });

    const summary: AttachPreview = { hash, name: torrent.name, affected: targets.map((target) => ({ id: target.id, label: label(target) })) };
    if (preview) return void res.json(summary);

    await attachTorrent({ queue }, { handle: owner, torrent, targets, cause: 'download attached by the user' });
    res.json({ ...summary, done: true });
  });

  return router;
}
