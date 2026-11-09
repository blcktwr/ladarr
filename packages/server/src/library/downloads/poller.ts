import type { ClientState } from '@ladarr/shared/enums';
import type { Db } from '../../core/db.ts';
import type { Events } from '../../core/events.ts';
import type { EnqueueInput, Job } from '../../core/jobs.ts';
import { catalog, itemFields, log } from '../../core/log.ts';
import { withOutboundRequests } from '../../core/outbound.ts';
import { parseEpisodes, titleNumbers } from '../parse.ts';
import type { Clients } from './client-api.ts';
import { ClientError, type ClientHandle, type Torrent, type TorrentStatus } from './qbittorrent.ts';
import { addedByApp, type Queue, type QueueEntry } from './queue.ts';

// What the client reported about one torrent at the last good poll. One torrent is one transfer,
// even when it covers many entries, so its bytes and rate count once.
export type Transfer = {
  hash: string;
  name: string;
  observedAt: number;
  sizeBytes: number;
  progress: number;
  downloadRate: number;
  etaSeconds: number | null;
  status: TorrentStatus;
  complete: boolean;
  seeds: number;
  peers: number;
  entryIds: string[];
  // The part of the torrent that each target has, from the file of that target. A pack downloads one file before
  // another, so the part of the torrent is not the part of each episode. Null when there is no part of a file.
  entryProgress: Record<string, number> | null;
  // The file of each target in the torrent: its name and its size.
  entryFiles: Record<string, { name: string; sizeBytes: number }> | null;
  // True when the last poll failed. The numbers are the last known ones.
  stale: boolean;
};

export type ClientStatus = { state: ClientState; lastOkAt: number | null };

type Deps = {
  db: Db;
  queue: Queue;
  events: Events;
  clients: Clients;
  enqueue: (input: EnqueueInput) => Job;
  intervalMs?: number;
};

const PUBLISH_MS = 1_000;
// A torrent that the client does not list yet, soon after the add, is not a missing torrent.
const GRACE_MS = 60_000;

// One poll for each client that has a download, whatever the number of rows or browser tabs. The progress stays in memory:
// it is replaceable, and the client reports it again after a restart. The client is read to see the part of each file, and
// a download that finishes, appears, or fails, so one check each 10 seconds keeps the rows close to the client.
export function createPoller({ db, queue, events, clients, enqueue, intervalMs = 10_000 }: Deps) {
  const transfers = new Map<string, Transfer>();
  const seen = new Set<string>();
  const status: ClientStatus = { state: 'unconfigured', lastOkAt: null };
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let lastPublish = 0;
  let dirty = new Set<string>();

  const tracked = () => Object.values(db.data.queue).filter((entry) => entry.transferHash && ['sending', 'downloading', 'validating'].includes(entry.stage) && entry.branch !== 'cancelled');

  function publish(force = false) {
    const now = Date.now();
    if (!dirty.size || (!force && now - lastPublish < PUBLISH_MS)) return;
    lastPublish = now;
    const list = [...dirty].map((hash) => transfers.get(hash)).filter(Boolean);
    dirty = new Set();
    events.publish('queue.progress', { at: now, client: status, transfers: list });
  }

  function observe(entries: QueueEntry[], hash: string, torrent: Torrent, entryProgress: Record<string, number> | null, entryFiles: Record<string, { name: string; sizeBytes: number }> | null) {
    const now = Date.now();
    const before = transfers.get(hash);
    const next: Transfer = {
      hash,
      name: torrent.name,
      observedAt: now,
      sizeBytes: torrent.sizeBytes,
      progress: torrent.progress,
      downloadRate: torrent.downloadRate,
      etaSeconds: torrent.etaSeconds,
      status: torrent.status,
      complete: torrent.complete,
      seeds: torrent.seeds,
      peers: torrent.peers,
      entryIds: entries.map((entry) => entry.id),
      entryProgress,
      // A complete torrent has every file, so the poll does not read them. The names stay from the poll before.
      entryFiles: entryFiles ?? before?.entryFiles ?? null,
      stale: false,
    };
    // Only a change is news. An unchanged torrent sends nothing.
    if (
      !before ||
      before.stale ||
      before.progress !== next.progress ||
      before.status !== next.status ||
      before.downloadRate !== next.downloadRate ||
      before.etaSeconds !== next.etaSeconds ||
      before.entryIds.join() !== next.entryIds.join() ||
      JSON.stringify(before.entryProgress) !== JSON.stringify(next.entryProgress) ||
      JSON.stringify(before.entryFiles) !== JSON.stringify(next.entryFiles)
    ) {
      dirty.add(hash);
    }
    transfers.set(hash, next);
    seen.add(hash);
  }

  // The part of the torrent that each target has, and its file. The client reports the part of each file, and a pack
  // has one file for each episode. A target whose file is not listed keeps the part of the whole torrent.
  async function fileParts(handle: ClientHandle, hash: string, entries: QueueEntry[]) {
    let files: { name: string; sizeBytes: number; progress: number }[];
    try {
      files = await handle.api.files(hash);
    } catch {
      // A failed read of the files does not stop the poll. The part of the torrent stays for every target.
      return null;
    }
    const progress: Record<string, number> = {};
    const found: Record<string, { name: string; sizeBytes: number }> = {};
    const title = db.data.titles[entries[0]!.titleKey];
    for (const entry of entries) {
      const manual = entry.manualMatch?.file;
      const file =
        entry.number === null && !manual
          ? [...files].sort((a, b) => b.sizeBytes - a.sizeBytes)[0]
          : files.find((item) => {
              if (manual) return item.name === manual || item.name.endsWith(`/${manual}`);
              const name = item.name.split('/').pop() ?? item.name;
              const parsed = parseEpisodes(name) ?? parseEpisodes(item.name);
              return entry.number !== null && parsed?.season === entry.season && titleNumbers(parsed, title?.episodes ?? []).includes(entry.number);
            });
      if (file) {
        progress[entry.id] = file.progress;
        found[entry.id] = { name: file.name.split('/').at(-1)!, sizeBytes: file.sizeBytes };
      }
    }
    return Object.keys(found).length ? { progress, files: found } : null;
  }

  // Reads one client, and moves the entries that it has. Adds to `keep` the hashes that stay in `transfers`.
  async function poll(handle: ClientHandle, entries: QueueEntry[], keep: Set<string>): Promise<ClientStatus['state']> {
    let list: Torrent[];
    try {
      list = await handle.api.list();
    } catch (error) {
      // The numbers of this client stay, and they are marked as old.
      for (const entry of entries) {
        const transfer = transfers.get(entry.transferHash!);
        if (!transfer) continue;
        transfer.stale = true;
        dirty.add(transfer.hash);
        keep.add(transfer.hash);
      }
      return error instanceof ClientError && error.code === 'rejected' ? 'rejected' : 'unreachable';
    }

    const byHash = new Map(list.map((torrent) => [torrent.hash, torrent]));
    const groups = new Map<string, QueueEntry[]>();
    for (const entry of entries) {
      // A target in Sending next to an attached target keeps waiting. Only the grab decides about its torrent.
      if (entry.stage === 'sending' && entry.transferHash && !addedByApp(db, entry.transferHash)) continue;
      groups.set(entry.transferHash!, [...(groups.get(entry.transferHash!) ?? []), entry]);
    }

    for (const [hash, group] of groups) {
      const torrent = byHash.get(hash);
      if (!torrent) {
        const recent = group.every((entry) => Date.now() - entry.stageSince < GRACE_MS);
        // The torrent was there and is gone: someone removed it in the client.
        if (seen.has(hash) && !recent) {
          for (const entry of group) if (entry.reason?.code !== 'torrent_missing') queue.move(entry, { reason: { code: 'torrent_missing' } }, 'torrent is not in the client');
          seen.delete(hash);
          transfers.delete(hash);
        }
        continue;
      }
      keep.add(hash);
      // The files of a torrent give each target its own part, its name and its size. A complete torrent has every
      // file, but the names can be unknown after a restart, so they are read once.
      const knownFiles = transfers.get(hash)?.entryFiles;
      const parts = !torrent.complete || !knownFiles ? await fileParts(handle, hash, group) : null;
      observe(group, hash, torrent, parts?.progress ?? null, parts?.files ?? null);
      for (const entry of group) {
        if (entry.stage === 'sending') queue.move(entry, { stage: 'downloading', reason: null }, 'client reported the torrent');
        // The torrent is back, or the client cleared its error.
        if (entry.reason?.code === 'torrent_missing') queue.move(entry, { reason: null }, 'torrent is in the client again');
        if (torrent.status === 'error') {
          if (entry.reason?.code !== 'client_error') queue.move(entry, { reason: { code: 'client_error' } }, 'client reported an error', torrent.state);
        } else if (entry.reason?.code === 'client_error') {
          queue.move(entry, { reason: null }, 'client error cleared');
        }
        if (torrent.complete && entry.stage === 'downloading' && entry.branch !== 'paused' && !entry.reason) {
          // The client has all the data. The files are not in the library yet, so the next step is the check.
          catalog.info('download_completed', `Download completed: "${torrent.name}"`, itemFields(db, entry), { hash, name: torrent.name, sizeBytes: torrent.sizeBytes, seeds: torrent.seeds, peers: torrent.peers });
          queue.move(entry, { stage: 'validating', reason: null }, 'download complete');
        }
      }
      if (torrent.complete && group.some((entry) => entry.stage === 'validating' && !entry.branch)) {
        enqueue({ type: 'import.run', payload: { hash }, dedupeKey: `import:${hash}`, priority: group.some((entry) => entry.priority !== null) });
      }
    }
    return 'ok';
  }

  async function tick() {
    const handles = clients.all();
    if (!handles.length) status.state = 'unconfigured';
    const entries = tracked();
    if (!entries.length) {
      // Nothing to watch. A check of the client would only cost a request.
      for (const [hash, transfer] of transfers) if (!entries.some((e) => e.transferHash === hash)) transfers.delete(hash);
      return;
    }
    const keep = new Set<string>();
    let state: ClientStatus['state'] = 'ok';
    for (const handle of handles) {
      const mine = entries.filter((entry) => entry.clientId === handle.id);
      if (!mine.length) continue;
      const result = await withOutboundRequests(() => poll(handle, mine, keep));
      if (result !== 'ok' && (state === 'ok' || result === 'rejected')) state = result;
    }
    // A target of a client that is off or gone has no one to ask. Its numbers stay, and they are marked as old.
    let orphaned = false;
    for (const entry of entries) {
      const transfer = transfers.get(entry.transferHash!);
      if (transfer && !handles.some((handle) => handle.id === entry.clientId)) {
        orphaned = true;
        if (!transfer.stale) dirty.add(transfer.hash);
        transfer.stale = true;
        keep.add(transfer.hash);
      }
    }
    if (handles.length) {
      status.state = state;
      if (state === 'ok') status.lastOkAt = Date.now();
    }
    for (const hash of transfers.keys()) if (!keep.has(hash)) transfers.delete(hash);
    publish(state !== 'ok' || orphaned);
  }

  function schedule() {
    if (stopped) return;
    timer = setTimeout(async () => {
      try {
        await tick();
      } catch (error) {
        log.error('client poll failed', { error });
      }
      schedule();
    }, intervalMs);
  }

  return {
    tick,
    // The client is read every 10 seconds. A new download shows at the next check.
    start: () => schedule(),
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
    status: () => ({ ...status }),
    transfer: (hash: string) => transfers.get(hash),
    transfers: () => [...transfers.values()],
  };
}

export type Poller = ReturnType<typeof createPoller>;
