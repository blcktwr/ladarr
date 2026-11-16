import { db } from '../../../core/db.ts';
import type { RequestHandler } from 'express';
import type { Finder } from '../../../library/grab/finder.ts';
import { deprioritize, prioritize, type EnqueueInput, type Job } from '../../../core/jobs.ts';
import type { Clients } from '../../../library/downloads/client-api.ts';
import type { Poller } from '../../../library/downloads/poller.ts';
import { ClientError, type ClientHandle, type Torrent } from '../../../library/downloads/qbittorrent.ts';
import { addedByApp, isActive, phaseOfEntry, type Queue, type QueueEntry } from '../../../library/downloads/queue.ts';
import { createRetry, sharingOf } from '../../../library/downloads/queue-api.ts';
import { bySeasonNumber, label, lanePositions, otherSeasonsTargets, shown, statusOf } from '../../../helpers/queue.ts';
import { canRetry, needsOtherSeasons } from '@ladarr/shared/queue';

export function queueActionsPost(queue: Queue, finder: Finder, poller: Poller, clients: Clients, enqueue: (input: EnqueueInput) => Job): RequestHandler {
  type Action = 'pause' | 'resume' | 'retry' | 'priority' | 'unpriority' | 'remove_torrent' | 'replace' | 'search_other_seasons';
  const ACTIONS: Action[] = ['pause', 'resume', 'retry', 'priority', 'unpriority', 'remove_torrent', 'replace', 'search_other_seasons'];

  const jobsOf = (entry: QueueEntry) =>
    Object.values(db.data.jobs).filter((job) => {
      const payload = job.payload as { entryIds?: string[]; hash?: string } | null;
      return Boolean(payload?.entryIds?.includes(entry.id)) || Boolean(payload?.hash && payload.hash === entry.transferHash);
    });

  const sharing = (entry: QueueEntry) => sharingOf(entry);

  // The torrent is one that a target of ladarr sent to the client.
  // Says if the action fits the state of the entry. A refusal is clear and changes nothing.
  function supports(action: Action, entry: QueueEntry, removal?: { torrents: Map<string, Torrent>; attached: Set<string> }): string | null {
    const phase = phaseOfEntry(entry);
    const early = ['queued', 'searching', 'fetching', 'sending'].includes(phase);
    const work = ['queued', 'searching', 'fetching', 'sending', 'downloading'].includes(entry.state.kind);
    switch (action) {
      case 'pause':
        return work && (early || entry.state.kind === 'downloading') ? null : 'The state of this target does not allow a pause.';
      case 'resume':
        return entry.state.kind === 'paused' ? null : 'This target is not paused.';
      case 'retry':
        return canRetry(entry.state) ? null : 'This target does not need a retry.';
      case 'priority':
        return isActive(entry) && entry.priority === null && entry.state.kind !== 'paused' && early ? null : 'Only waiting work can have priority.';
      case 'unpriority':
        return entry.priority !== null ? null : 'This target has no priority.';
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
        return entry.state.kind === 'blocked' && entry.state.problem.code === 'destination_exists' ? null : 'This target has no file to replace.';
      case 'search_other_seasons':
        // A pack that held a part of its season. The user starts the search of the other seasons of the releases.
        return needsOtherSeasons(entry.state) ? null : 'This target does not need a search of other seasons.';
    }
  }

  // The entries that the action changes. Pause and resume of a download act on the whole transfer.
  function scope(action: Action, entry: QueueEntry) {
    // The torrent goes for all targets that point at it.
    if (action === 'remove_torrent') return Object.values(db.data.queue).filter((other) => other.transferHash === entry.transferHash);
    if ((action === 'pause' || action === 'resume') && entry.state.kind === 'downloading' && entry.transferHash) {
      const matching = action === 'pause' ? 'downloading' : 'paused';
      return Object.values(db.data.queue).filter(
        (other) => other.transferHash === entry.transferHash && (other.state.kind === 'downloading' || other.state.kind === 'paused') && other.state.kind === matching,
      );
    }
    return [entry];
  }

  const { retry } = createRetry({ queue, enqueue });

  async function apply(action: Action, entries: QueueEntry[]) {
    const removed = new Set<string>();
    for (const entry of entries) {
      // Each target acts on the client that has its torrent.
      const api = clients.get(entry.clientId)?.api;
      switch (action) {
        case 'pause': {
          if (entry.state.kind === 'downloading') {
            if (!api) throw new ClientError('unreachable', 'No download client.');
            await api.setPaused(entry.transferHash!, true);
          }
          queue.pause(entry, 'paused by the user');
          break;
        }
        case 'resume': {
          const was = entry.state.kind === 'paused' ? entry.state.resume : null;
          if (was === 'downloading') {
            if (!api) throw new ClientError('unreachable', 'No download client.');
            await api.setPaused(entry.transferHash!, false);
            queue.resume(entry, 'resumed by the user');
          } else if ((was === 'fetching' || was === 'sending') && entry.release) {
            queue.resume(entry, 'resumed by the user');
            enqueue({ type: 'queue.grab', payload: { entryIds: [entry.id] }, dedupeKey: `grab:${entry.id}`, runAt: entry.createdAt });
          } else {
            queue.resume(entry, 'resumed by the user');
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
        case 'remove_torrent': {
          if (!api) throw new ClientError('unreachable', 'No download client.');
          // One request for each torrent, also when many targets point at it. The data stays on the disk.
          if (!removed.has(entry.transferHash!)) await api.remove(entry.transferHash!, false);
          removed.add(entry.transferHash!);
          // The torrent is gone, so the record of the torrents that ladarr sent no longer covers it.
          delete db.data.sentTorrents[entry.transferHash!];
          queue.observe(entry, 'torrent removed from the client', 'The data stays on the disk.');
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
    // The retry of a title starts again the targets that wait for its work: the ones that a problem stops, and the ones
    // that wait for their next search with a result. The search of the other seasons takes the targets of the season that
    // a pack left without a file, in the state that they have now.
    if (group && typeof group.titleKey === 'string') {
      picked =
        action === 'search_other_seasons'
          ? otherSeasonsTargets(group.titleKey, group.season ?? null)
          : groupEntries(group.titleKey, group.season ?? null).filter((entry) => action !== 'retry' || canRetry(entry.state));
    } else if (action === 'search_other_seasons') return void res.status(400).json({ error: 'invalid_request' });
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
    const summary = { action, affected: list.map((entry) => ({ id: entry.id, label: label(entry), status: statusOf(entry), phase: phaseOfEntry(entry), lane: lane.get(entry.id) ?? null })), unsupported, sharedTransfers: [...transfers].map(([hash, count]) => ({ name: poller.transfer(hash)?.name ?? removal?.torrents.get(hash)?.name ?? hash, entries: count })) };
    if (preview) return void res.json(summary);
    if (!list.length) return void res.status(409).json({ error: 'action_not_supported', unsupported });
    // The search of the other seasons moves the targets to the queue and starts one job for the season. It needs no
    // request to the download client.
    if (action === 'search_other_seasons') {
      finder.startOtherSeasons(list);
      return void res.json({ ...summary, done: true });
    }
    try {
      await apply(action, list);
    } catch (error) {
      if (error instanceof ClientError) return void res.status(502).json({ error: error.code === 'rejected' ? 'client_rejected' : 'client_unreachable' });
      throw error;
    }
    res.json({ ...summary, done: true });
  };
}
