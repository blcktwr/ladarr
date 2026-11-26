import { db } from '../../core/db.ts';
import { catalog, itemFields, log } from '../../core/log.ts';
import { withOutboundRequests } from '../../core/outbound.ts';
import { MAX_IMPORT_ATTEMPTS } from '../imports/limits.ts';
import { inspectCoverage } from '../coverage.ts';
import { ClientError } from './qbittorrent.ts';
import { addedByApp, isActive, phaseOfEntry } from './queue.ts';
import type { ClientHandle, ClientStatus, PollerDeps, QueueEntry, Torrent, Transfer } from '../../types.ts';

const PUBLISH_MS = 1_000;
// A torrent that the client does not list yet, soon after the add, is not a missing torrent.
const GRACE_MS = 60_000;

// One poll for each client that has a download, whatever the number of rows or browser tabs. The progress stays in memory:
// it is replaceable, and the client reports it again after a restart. The client is read to see the part of each file, and
// a download that finishes, appears, or fails, so one check each 10 seconds keeps the rows close to the client.
export function createPoller({ queue, events, clients, enqueue, intervalMs = 10_000 }: PollerDeps) {
  const transfers = new Map<string, Transfer>();
  const seen = new Set<string>();
  const status: ClientStatus = { state: 'unconfigured', lastOkAt: null };
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  let stopped = false;
  let lastPublish = 0;
  let dirty = new Set<string>();

  // A blocked target keeps its torrent telemetry, but only a user action can release the target.
  // A target that imports keeps its torrent too: the poll sees
  // a complete download that has no import job, such as one that the user attached.
  const tracked = () => Object.values(db.data.queue).filter((entry) => isActive(entry) && entry.transferHash && ['sending', 'downloading', 'importing'].includes(phaseOfEntry(entry)));

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
  // has one file for each episode. An episode without a matching file has no progress.
  async function fileParts(handle: ClientHandle, hash: string, entries: QueueEntry[]) {
    let files: { name: string; sizeBytes: number; progress: number }[];
    try {
      files = await handle.api.files(hash);
    } catch {
      // A failed read of the files does not stop the poll.
      return null;
    }
    const progress: Record<string, number> = {};
    const found: Record<string, { name: string; sizeBytes: number }> = {};
    const absent = new Set<string>();
    const names = files.map((file) => file.name);
    const manifests = new Map<string, ReturnType<typeof inspectCoverage>>();
    for (const entry of entries) {
      const upload = entry.release?.uploadPath;
      const manual = entry.manualMatch?.file;
      const title = db.data.titles[entry.titleKey];
      const numbering = entry.numbering === undefined ? title?.numbering : entry.numbering;
      const key = JSON.stringify([entry.titleKey, numbering]);
      if (title && entry.number !== null && !upload && !manual && !manifests.has(key)) manifests.set(key, inspectCoverage(names, title, numbering));
      const file =
        upload && !manual ? files.find((item) => item.name === upload) :
        entry.number === null && !manual
          ? [...files].sort((a, b) => b.sizeBytes - a.sizeBytes)[0]
          : files.find((item) => {
              if (manual) return item.name === manual || item.name.endsWith(`/${manual}`);
              return manifests.get(key)?.byFile.get(item.name)?.some((ep) => ep.season === entry.season && ep.number === entry.number);
            });
      if (file) {
        progress[entry.id] = file.progress;
        found[entry.id] = { name: file.name.split('/').at(-1)!, sizeBytes: file.sizeBytes };
      } else if (entry.season !== null && entry.number !== null && manifests.get(key)?.status({ season: entry.season, number: entry.number }) === 'absent') {
        absent.add(entry.id);
      }
    }
    return { progress, files: found, absent };
  }

  // Reads one client, and moves the entries that it has. Adds to `keep` the hashes that stay in `transfers`.
  async function poll(handle: ClientHandle, entries: QueueEntry[], keep: Set<string>): Promise<ClientStatus['state']> {
    let list: Torrent[];
    try {
      list = await clients.list(handle, { fresh: true });
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
      if (entry.state.kind === 'sending' && entry.transferHash && (entry.number !== null || entry.release?.uploadPath || !addedByApp(entry.transferHash))) continue;
      groups.set(entry.transferHash!, [...(groups.get(entry.transferHash!) ?? []), entry]);
    }

    for (const [hash, group] of groups) {
      const torrent = byHash.get(hash);
      if (!torrent) {
        const recent = group.every((entry) => Date.now() - entry.phaseSince < GRACE_MS);
        // The torrent was there and is gone: someone removed it in the client.
        if (seen.has(hash) && !recent) {
          for (const entry of group) if (entry.state.kind !== 'blocked') queue.block(entry, { code: 'torrent_missing' }, 'torrent is not in the client');
          seen.delete(hash);
          transfers.delete(hash);
        }
        continue;
      }
      keep.add(hash);
      // The files of a torrent give each target its own part, its name and its size. A complete torrent has every
      // file, but the names can be unknown after a restart, so they are read once.
      const knownFiles = transfers.get(hash)?.entryFiles;
      const revisions = new Map(group.map((entry) => [entry, entry.revision]));
      const parts = !torrent.complete || !knownFiles || !Object.keys(knownFiles).length ? await fileParts(handle, hash, group) : null;
      observe(group, hash, torrent, parts?.progress ?? null, parts?.files ?? null);
      for (const entry of group) {
        if (entry.state.kind === 'blocked' || db.data.queue[entry.id] !== entry || entry.revision !== revisions.get(entry)) continue;
        if (entry.state.kind === 'downloading' && !torrent.complete && torrent.status !== 'metadata' && parts?.absent.has(entry.id)) {
          queue.block(entry, { code: 'pack_partial' }, 'the torrent has no file for this episode');
          continue;
        }
        if (entry.state.kind === 'sending') queue.enter(entry, 'downloading', 'client reported the torrent');
        if (torrent.status === 'error') {
          queue.block(entry, { code: 'client_error' }, 'client reported an error', torrent.state);
        }
        if (torrent.complete && entry.state.kind === 'downloading') {
          // The client has all the data. The files are not in the library yet, so the next step is the import and
          // its checks.
          catalog.info('download_completed', `Download completed: "${torrent.name}"`, itemFields(entry), { hash, name: torrent.name, sizeBytes: torrent.sizeBytes, seeds: torrent.seeds, peers: torrent.peers });
          queue.enter(entry, 'importing', 'download complete');
        }
      }
      // A complete torrent with a target that imports runs the import. The budget stops the automatic attempts, and a
      // target that is blocked is not in Importing any more. An open journal keeps its own recovery: the job retries
      // with its backoff, and the start of the server finishes it.
      const journal = Object.values(db.data.imports).some((item) => item.hash === hash);
      if (!journal && torrent.complete && group.some((entry) => entry.state.kind === 'importing' && (entry.importTries ?? 0) < MAX_IMPORT_ATTEMPTS)) {
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
    timer = setTimeout(() => {
      running = tick().catch((error) => log.error('client poll failed', { error })).finally(() => {
        running = undefined;
        schedule();
      });
    }, intervalMs);
  }

  function stop() {
    stopped = true;
    clearTimeout(timer);
  }

  return {
    tick,
    // The client is read every 10 seconds. A new download shows at the next check.
    start() {
      stopped = false;
      schedule();
    },
    stop,
    async pause() {
      stop();
      await running;
    },
    reset() {
      transfers.clear();
      seen.clear();
      dirty.clear();
      status.state = 'unconfigured';
      status.lastOkAt = null;
    },
    status: () => ({ ...status }),
    transfer: (hash: string) => transfers.get(hash),
    transfers: () => [...transfers.values()],
  };
}
