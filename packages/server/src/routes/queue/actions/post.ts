import { db } from '../../../core/db.ts';
import type { RequestHandler } from 'express';
import type { Finder } from '../../../library/grab/finder.ts';
import { deprioritize, prioritize, type EnqueueInput, type Job } from '../../../core/jobs.ts';
import type { Clients } from '../../../library/downloads/client-api.ts';
import type { Poller } from '../../../library/downloads/poller.ts';
import { ClientError, type ClientHandle, type Torrent } from '../../../library/downloads/qbittorrent.ts';
import { addedByApp, isActive, queueKey, type Queue, type QueueEntry } from '../../../library/downloads/queue.ts';
import { createRetry, sharingOf } from '../../../library/downloads/queue-api.ts';
import { bySeasonNumber, label, lanePositions, shown } from '../../../helpers/queue.ts';

export function queueActionsPost(queue: Queue, finder: Finder, poller: Poller, clients: Clients, enqueue: (input: EnqueueInput) => Job): RequestHandler {
  type Action = 'pause' | 'resume' | 'retry' | 'priority' | 'unpriority' | 'clear' | 'remove_torrent' | 'replace';
  const ACTIONS: Action[] = ['pause', 'resume', 'retry', 'priority', 'unpriority', 'clear', 'remove_torrent', 'replace'];

  const jobsOf = (entry: QueueEntry) =>
    Object.values(db.data.jobs).filter((job) => {
      const payload = job.payload as { entryIds?: string[]; hash?: string } | null;
      return Boolean(payload?.entryIds?.includes(entry.id)) || Boolean(payload?.hash && payload.hash === entry.transferHash);
    });

  const sharing = (entry: QueueEntry) => sharingOf(entry);

  // The torrent is one that a target of ladarr sent to the client.
  // Says if the action fits the stage of the entry. A refusal is clear and changes nothing.
  function supports(action: Action, entry: QueueEntry, removal?: { torrents: Map<string, Torrent>; attached: Set<string> }): string | null {
    const early = ['queued', 'searching', 'fetching', 'sending'].includes(entry.stage);
    switch (action) {
      case 'pause':
        return entry.branch === null && (early || entry.stage === 'downloading') ? null : 'The stage of this target does not allow a pause.';
      case 'resume':
        return entry.branch === 'paused' ? null : 'This target is not paused.';
      case 'retry':
        return entry.branch !== 'paused' && entry.branch !== 'cancelled' && entry.reason !== null ? null : 'This target does not need a retry.';
      case 'priority':
        return isActive(entry) && entry.priority === null && entry.branch !== 'paused' && early ? null : 'Only waiting work can have priority.';
      case 'unpriority':
        return entry.priority !== null ? null : 'This target has no priority.';
      case 'clear':
        return (entry.stage === 'available' || entry.branch === 'cancelled') && !entry.clearedAt ? null : 'Only finished targets can be cleared.';
      case 'remove_torrent': {
        if (!entry.transferHash) return 'This target has no torrent.';
        if (sharing(entry).length > 0) return 'A target still uses this torrent.';
        // ladarr removes only a torrent that it added. A download that the user attached stays in the client.
        if (removal?.attached.has(entry.transferHash)) return 'This torrent was not added by the app. Delete it in the download client.';
        const found = removal?.torrents.get(entry.transferHash);
        return found && !addedByApp(found.hash) ? 'This torrent was not added by the app. Delete it in the download client.' : null;
      }
      case 'replace':
        // A target that stopped on a taken destination name. The importer finds the exact file again.
        return entry.reason?.code === 'destination_exists' ? null : 'This target has no file to replace.';
    }
  }

  // The entries that the action changes. Pause and resume of a download act on the whole transfer.
  function scope(action: Action, entry: QueueEntry) {
    // The torrent goes for all targets that point at it.
    if (action === 'remove_torrent') return Object.values(db.data.queue).filter((other) => other.transferHash === entry.transferHash);
    if ((action === 'pause' || action === 'resume') && entry.stage === 'downloading' && entry.transferHash) {
      return Object.values(db.data.queue).filter((other) => other.transferHash === entry.transferHash && other.stage === 'downloading' && (action === 'pause' ? other.branch === null : other.branch === 'paused'));
    }
    return [entry];
  }

  const { retry } = createRetry({ queue, finder, enqueue });

  async function apply(action: Action, entries: QueueEntry[]) {
    const removed = new Set<string>();
    for (const entry of entries) {
      // Each target acts on the client that has its torrent.
      const api = clients.get(entry.clientId)?.api;
      switch (action) {
        case 'pause': {
          if (entry.stage === 'downloading') {
            if (!api) throw new ClientError('unreachable', 'No download client.');
            await api.setPaused(entry.transferHash!, true);
          }
          queue.move(entry, { branch: 'paused' }, 'paused by the user');
          break;
        }
        case 'resume': {
          if (entry.stage === 'downloading') {
            if (!api) throw new ClientError('unreachable', 'No download client.');
            await api.setPaused(entry.transferHash!, false);
            queue.move(entry, { branch: null }, 'resumed by the user');
          } else if ((entry.stage === 'fetching' || entry.stage === 'sending') && entry.release) {
            queue.move(entry, { branch: null }, 'resumed by the user');
            enqueue({ type: 'queue.grab', payload: { entryIds: [entry.id] }, dedupeKey: `grab:${entry.id}`, runAt: entry.createdAt });
          } else {
            queue.move(entry, { stage: 'queued', branch: null, reason: null }, 'resumed by the user');
            finder.enqueueSearch({ titleKey: entry.titleKey, season: entry.season, entryIds: [entry.id] });
          }
          break;
        }
        case 'retry':
          retry(entry);
          break;
        case 'replace':
          // The importer sees the file at the destination and removes it before it stages the new one.
          entry.replaceDestination = true;
          queue.touch(entry);
          retry(entry);
          break;
        case 'priority': {
          queue.setPriority(entry, true);
          for (const job of jobsOf(entry)) prioritize(job.id);
          break;
        }
        case 'unpriority': {
          queue.setPriority(entry, false);
          for (const job of jobsOf(entry)) deprioritize(job.id);
          break;
        }
        case 'clear':
          entry.clearedAt = Date.now();
          queue.touch(entry);
          break;
        case 'remove_torrent': {
          if (!api) throw new ClientError('unreachable', 'No download client.');
          // One request for each torrent, also when many targets point at it. The data stays on the disk.
          if (!removed.has(entry.transferHash!)) await api.remove(entry.transferHash!, false);
          removed.add(entry.transferHash!);
          // The torrent is gone, so the record of the torrents that ladarr sent no longer covers it.
          delete db.data.sentTorrents[entry.transferHash!];
          queue.move(entry, {}, 'torrent removed from the client', 'The data stays on the disk.');
          entry.transferHash = null;
          entry.clientId = null;
          break;
        }
      }
    }
  }

  // The entries of a group in the order that they have now, for an action on a group. A null season takes every season.
  function groupEntries(titleKey: string, season: number | null) {
    return Object.values(db.data.queue).filter((entry) => entry.titleKey === titleKey && (season === null || entry.season === season) && shown(entry)).sort((a, b) => a.createdAt - b.createdAt || bySeasonNumber(a, b));
  }

  return async (req, res) => {
    const { action, ids, group, preview } = (req.body ?? {}) as { action?: Action; ids?: unknown; group?: { titleKey?: string; season?: number | null }; preview?: boolean };
    if (!action || !ACTIONS.includes(action)) return void res.status(400).json({ error: 'invalid_action' });
    let picked: QueueEntry[];
    if (group && typeof group.titleKey === 'string') picked = groupEntries(group.titleKey, group.season ?? null);
    else if (Array.isArray(ids) && ids.length <= 1000 && ids.every((id) => typeof id === 'string')) picked = ids.flatMap((id) => (db.data.queue[id] && shown(db.data.queue[id]!) ? [db.data.queue[id]!] : []));
    else return void res.status(400).json({ error: 'invalid_request' });

    // Before a removal, read the torrents in the client. The queue decides if ladarr added a torrent.
    let removal: { torrents: Map<string, Torrent>; attached: Set<string> } | undefined;
    if (action === 'remove_torrent') {
      // Each client reads the hashes of the torrents that it has.
      const byClient = new Map<ClientHandle, Set<string>>();
      for (const entry of picked) {
        if (!entry.transferHash) continue;
        const handle = clients.get(entry.clientId);
        if (!handle) return void res.status(409).json({ error: 'client_missing' });
        byClient.set(handle, (byClient.get(handle) ?? new Set()).add(entry.transferHash));
      }
      try {
        const torrents = new Map<string, Torrent>();
        for (const [handle, hashes] of byClient) for (const torrent of await handle.api.byHashes([...hashes])) torrents.set(torrent.hash, torrent);
        const attached = new Set(Object.values(db.data.queue).flatMap((entry) => (entry.release?.external && entry.transferHash ? [entry.transferHash] : [])));
        removal = { torrents, attached };
      } catch (error) {
        if (error instanceof ClientError) return void res.status(502).json({ error: 'client_unreachable' });
        throw error;
      }
    }

    // A group action takes the entries that the action fits. A single request for one entry that does not fit is refused.
    const unsupported: { id: string; reason: string }[] = [];
    const affected = new Map<string, QueueEntry>();
    for (const entry of picked) {
      const refusal = supports(action, entry, removal);
      if (refusal) unsupported.push({ id: entry.id, reason: refusal });
      else for (const other of scope(action, entry)) affected.set(other.id, other);
    }
    const lane = lanePositions();
    const list = [...affected.values()];
    const transfers = new Map<string, number>();
    for (const entry of list) if (entry.transferHash && ['pause', 'resume', 'remove_torrent'].includes(action)) transfers.set(entry.transferHash, (transfers.get(entry.transferHash) ?? 0) + 1);
    const summary = { action, affected: list.map((entry) => ({ id: entry.id, label: label(entry), stage: entry.stage, key: queueKey(entry), lane: lane.get(entry.id) ?? null })), unsupported, sharedTransfers: [...transfers].map(([hash, count]) => ({ name: poller.transfer(hash)?.name ?? removal?.torrents.get(hash)?.name ?? hash, entries: count })) };
    if (preview) return void res.json(summary);
    if (!list.length) return void res.status(409).json({ error: 'action_not_supported', unsupported });
    try {
      await apply(action, list);
    } catch (error) {
      if (error instanceof ClientError) return void res.status(502).json({ error: error.code === 'rejected' ? 'client_rejected' : 'client_unreachable' });
      throw error;
    }
    res.json({ ...summary, done: true });
  };
}
