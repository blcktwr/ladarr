import { db } from '../../../core/db.ts';
import { normalizeNumbering, releasePoint, releaseSeasons } from '../../../library/numbering.ts';
import type { QueueActionName } from '@ladarr/shared/enums';
import type { WorkPhase } from '@ladarr/shared/queue';
import type { RequestHandler } from 'express';
import { deprioritize, prioritize } from '../../../core/jobs.ts';
import { ClientError } from '../../../library/downloads/qbittorrent.ts';
import { addedByApp, forgetSource, isActive, ownsUpload, phaseOfEntry } from '../../../library/downloads/queue.ts';
import { createRetry, sharingOf } from '../../../library/downloads/queue-api.ts';
import { enqueueUpload, uploadHash } from '../../../library/downloads/upload.ts';
import { actionsOf, associationState, bySeasonNumber, label, lanePositions, otherSeasonsTargets, resolutionCurrent, resolutionVersion, shown, statusOf } from '../../../helpers/queue.ts';
import { preparedFiles, preparedMapping, resumePreparedMapping } from '../../../helpers/queue-attach.ts';
import { canRetry, needsOtherSeasons } from '@ladarr/shared/queue';
import type { ClientHandle, Clients, EnqueueInput, Finder, Job, Poller, Queue, QueueEntry, QueueTurn, Torrent } from '../../../types.ts';

export function queueActionsPost(queue: Queue, finder: Finder, poller: Poller, clients: Clients, enqueue: (input: EnqueueInput) => Job): RequestHandler {
  type Action = QueueActionName;
  const ACTIONS: Action[] = ['pause', 'resume', 'retry', 'priority', 'unpriority', 'remove_torrent', 'replace', 'search_other_seasons', 'apply_numbering', 'retry_fetch', 'retry_send', 'check_download', 'retry_import'];

  const jobsOf = (entry: QueueEntry) =>
    Object.values(db.data.jobs).filter((job) => {
      const payload = job.payload as { entryIds?: string[]; hash?: string } | null;
      return Boolean(payload?.entryIds?.includes(entry.id)) || Boolean(payload?.hash && payload.hash === entry.transferHash);
    });

  const sharing = (entry: QueueEntry) => sharingOf(entry);

  function canRestart(entry: QueueEntry, group: boolean) {
    if (canRetry(entry.state)) return true;
    if ((!group && entry.season !== null) || !['queued', 'searching', 'waiting', 'fetching', 'waiting_slot'].includes(entry.state.kind)) return false;
    const item = queue.itemFor(entry);
    return Boolean(item && item.entryIds.includes(entry.id) && canRetry(item.state));
  }

  // The torrent is one that a target of ladarr sent to the client.
  // Says if the action fits the state of the entry. A refusal is clear and changes nothing.
  function supports(action: Action, entry: QueueEntry, removal?: { torrents: Map<string, Torrent>; attached: Set<string> }, group = false): string | null {
    const phase = phaseOfEntry(entry);
    const early = ['queued', 'searching', 'fetching', 'waiting_slot', 'sending'].includes(phase);
    const work = ['queued', 'searching', 'fetching', 'waiting_slot', 'sending', 'downloading'].includes(entry.state.kind);
    switch (action) {
      case 'pause':
        return work && (early || entry.state.kind === 'downloading') ? null : 'The state of this target does not allow a pause.';
      case 'resume':
        return entry.state.kind === 'paused' ? null : 'This target is not paused.';
      case 'retry':
        return canRestart(entry, group) ? null : 'This target does not need a retry.';
      case 'apply_numbering':
        return entry.state.kind === 'blocked' && entry.season !== null ? null : 'This target has no blocked acquisition.';
      case 'retry_fetch':
      case 'retry_send':
      case 'check_download':
      case 'retry_import':
        return actionsOf([entry]).some((item) => item.action === action) ? null : 'This action does not apply to this target.';
      case 'priority':
        return isActive(entry) && entry.priority === null && entry.state.kind !== 'paused' && early ? null : 'Only waiting work can have priority.';
      case 'unpriority':
        return entry.priority !== null ? null : 'This target has no priority.';
      case 'remove_torrent': {
        if (!entry.transferHash) return 'This target has no torrent.';
        if (sharing(entry).length > 0) return 'A target still uses this torrent.';
        // ladarr removes only a torrent that it added. A download that the user attached stays in the client.
        if (entry.release?.uploadPath) return ownsUpload(entry) ? null : 'This torrent was not added by the app. Delete it in the download client.';
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
    if (action === 'remove_torrent') return Object.values(db.data.queue).filter((other) => other.transferHash === entry.transferHash && (!entry.release?.uploadPath || other.clientId === entry.clientId));
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
    if (action === 'retry') return finder.restartSearch(entries);
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
          } else if ((was === 'fetching' || was === 'waiting_slot' || was === 'sending') && entry.release) {
            queue.resume(entry, 'resumed by the user');
            // A fetched torrent goes to the send. A release without its source is fetched first.
            const upload = uploadHash(entry);
            if (upload) enqueueUpload(enqueue, [entry], upload);
            else if (entry.source) enqueue({ type: 'queue.send', payload: { entryIds: [entry.id] }, dedupeKey: `send:${entry.id}`, runAt: entry.createdAt });
            else enqueue({ type: 'queue.grab', payload: { entryIds: [entry.id] }, dedupeKey: `grab:${entry.id}`, runAt: entry.createdAt });
          } else {
            queue.resume(entry, 'resumed by the user');
            if (uploadHash(entry)) retry(entry);
            else finder.enqueueSearch({ titleKey: entry.titleKey, season: entry.season, entryIds: [entry.id] });
          }
          break;
        }
        case 'retry_fetch':
        case 'retry_send':
        case 'check_download':
        case 'retry_import':
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
          if (entry.release?.uploadPath) {
            forgetSource(entry);
            entry.release.uploadOwner = undefined;
            entry.release.external = true;
          } else delete db.data.sentTorrents[entry.transferHash!];
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
    const { action, ids, group, preview, version } = (req.body ?? {}) as { action?: Action; ids?: unknown; group?: { titleKey?: string; season?: number | null }; preview?: boolean; version?: unknown };
    if (!action || !ACTIONS.includes(action)) return void res.status(400).json({ error: 'invalid_action' });
    let picked: QueueEntry[];
    // The retry of a title starts again the targets that wait for its work: the ones that a problem stops, and the ones
    // that wait for their next search with a result. The search of the other seasons takes the targets of the season that
    // a pack left without a file, in the state that they have now.
    if (group && typeof group.titleKey === 'string') {
      picked =
        action === 'search_other_seasons'
          ? otherSeasonsTargets(group.titleKey, group.season ?? null)
          : groupEntries(group.titleKey, group.season ?? null).filter((entry) => action !== 'retry' || canRestart(entry, true));
    } else if (action === 'search_other_seasons') return void res.status(400).json({ error: 'invalid_request' });
    else if (Array.isArray(ids) && ids.length <= 1000 && ids.every((id) => typeof id === 'string')) picked = ids.flatMap((id) => (db.data.queue[id] && shown(db.data.queue[id]!) ? [db.data.queue[id]!] : []));
    else return void res.status(400).json({ error: 'invalid_request' });

    if (action === 'apply_numbering') {
      const selected = [...new Map(picked.map((entry) => [entry.id, entry])).values()];
      const unsupported = selected.flatMap((entry) => {
        const reason = supports(action, entry);
        return reason ? [{ id: entry.id, reason }] : [];
      });
      const scope = { action, ids: selected.map((entry) => entry.id).sort() };
      const numbering = selected.map((entry) => ({ id: entry.id, from: normalizeNumbering(entry.numbering), to: normalizeNumbering(db.data.titles[entry.titleKey]?.numbering), phase: 'queued' as WorkPhase }));
      const manifest: unknown[] = [];
      const prepared = new Map<string, { item: QueueTurn; revision: number; hash: string }>();
      try {
        for (const item of numbering) {
          const entry = db.data.queue[item.id]!;
          if (entry.season !== null && !releasePoint(item.to, { season: entry.season, number: entry.number! })) return void res.status(409).json({ error: 'numbering_required' });
          const mapping = preparedMapping(entry);
          const turn = queue.itemFor(entry);
          const selection = turn && (entry.transferHash ? turn.selected[entry.transferHash] :
            Object.values(turn.selected).find(({ matches }) => Object.hasOwn(matches, entry.id)));
          if (selection?.status === 'uncertain') return void res.status(409).json({ error: 'action_not_supported', unsupported });
          if (mapping || (selection?.status === 'prepared' && turn)) {
            const pending = mapping?.item ?? turn!;
            const candidate = mapping?.candidate ?? selection!;
            const files = preparedFiles(candidate);
            if (!files?.length) return void res.status(409).json({ error: 'download_not_found' });
            prepared.set(entry.id, { item: pending, revision: pending.revision, hash: candidate.hash });
            manifest.push({ id: entry.id, item: pending.id, revision: pending.revision, candidate, files });
            item.phase = 'fetching';
          } else if (entry.transferHash && entry.clientId) {
            const handle = clients.get(entry.clientId);
            if (!handle) return void res.status(409).json({ error: 'client_missing' });
            const torrent = (await handle.api.byHashes([entry.transferHash]))[0];
            const files = torrent ? await handle.api.files(entry.transferHash) : [];
            manifest.push({ id: entry.id, torrent: torrent ? { hash: torrent.hash, complete: torrent.complete, contentPath: torrent.contentPath } : null, files: files.map(({ name, sizeBytes }) => ({ name, sizeBytes })) });
            if (!torrent) return void res.status(409).json({ error: 'torrent_not_found' });
            item.phase = torrent.complete ? 'importing' : 'downloading';
          } else if (entry.release) item.phase = 'fetching';
          else if (phaseOfEntry(entry) === 'importing') item.phase = 'importing';
        }
      } catch (error) {
        if (error instanceof ClientError) return void res.status(502).json({ error: 'client_unreachable' });
        throw error;
      }
      if (selected.some((entry) => db.data.queue[entry.id] !== entry)) return void res.status(409).json({ error: 'preview_changed' });
      if ([...prepared.values()].some(({ item, revision }) => queue.getItem(item.id) !== item || item.revision !== revision)) return void res.status(409).json({ error: 'preview_changed' });
      const boundScope = { ...scope, maps: numbering.map(({ id, to }) => ({ id, to })), manifest };
      const state = { selected, associations: [...new Set(selected.map((entry) => entry.titleKey))].map(associationState) };
      const summary = {
        action,
        version: resolutionVersion(boundScope, state),
        affected: selected.filter((entry) => !unsupported.some((item) => item.id === entry.id)).map((entry) => ({ id: entry.id, label: label(entry), status: statusOf(entry), phase: phaseOfEntry(entry), lane: lanePositions().get(entry.id) ?? null })),
        unsupported,
        sharedTransfers: [],
        numbering,
      };
      if (preview) return void res.json(summary);
      if (typeof version !== 'string' || !version) return void res.status(409).json({ error: 'preview_required' });
      const already = selected.length > 0 && numbering.every((item) => {
        const entry = db.data.queue[item.id]!;
        return JSON.stringify(normalizeNumbering(entry.numbering)) === JSON.stringify(item.to) && entry.state.kind === item.phase;
      });
      if (version === undefined || !resolutionCurrent(version, boundScope, already ? undefined : state)) return void res.status(409).json({ error: 'preview_changed' });
      if (already) return void res.json({ ...summary, done: true });
      if (unsupported.length || !selected.length) return void res.status(409).json({ error: 'action_not_supported', unsupported });
      const recheck = new Map<QueueTurn, { hashes: Set<string>; entryIds: string[] }>();
      for (const item of numbering) {
        const entry = db.data.queue[item.id]!;
        entry.numbering = structuredClone(item.to);
        queue.retryAttempt(entry, 'apply numbering');
        queue.resolve(entry, item.phase, 'numbering applied by the user');
        if (item.phase === 'importing') {
          if (entry.transferHash) {
            const entryIds = numbering.filter((other) => other.phase === 'importing' && db.data.queue[other.id]?.transferHash === entry.transferHash).map((other) => other.id);
            const payload = { hash: entry.transferHash, entryIds, manual: true };
            const job = enqueue({ type: 'import.run', payload, dedupeKey: `import:${entry.transferHash}`, priority: entry.priority !== null });
            if (job.type === 'import.run' && job.state === 'waiting') job.payload = payload;
          } else {
            const entryIds = numbering.filter((other) => other.phase === 'importing' && db.data.queue[other.id]?.titleKey === entry.titleKey && !db.data.queue[other.id]?.transferHash).map((other) => other.id);
            const payload = { titleKey: entry.titleKey, entryIds, localOnly: true };
            const job = enqueue({ type: 'import.local', payload, dedupeKey: `local:${entry.titleKey}`, priority: entry.priority !== null });
            if (job.type === 'import.local' && job.state === 'waiting') job.payload = payload;
          }
        }
        else if (item.phase === 'fetching') {
          const pending = prepared.get(entry.id);
          if (pending) {
            const group = recheck.get(pending.item) ?? { hashes: new Set<string>(), entryIds: [] };
            group.hashes.add(pending.hash);
            group.entryIds.push(entry.id);
            recheck.set(pending.item, group);
          } else {
            const item = queue.itemFor(entry);
            if (item?.state.kind === 'blocked') queue.transitionItem(item, { kind: 'fetching' });
            enqueue({ type: 'queue.grab', payload: { entryIds: [entry.id] }, dedupeKey: `grab:${entry.id}`, priority: entry.priority !== null });
          }
        }
        else if (item.phase === 'queued') finder.enqueueSearch({ titleKey: entry.titleKey, season: entry.season, entryIds: [entry.id] });
      }
      for (const [item, { hashes, entryIds }] of recheck) {
        const revision = normalizeNumbering(db.data.titles[item.titleKey]?.numbering).revision;
        const selected = Object.fromEntries(Object.entries(item.selected).map(([hash, source]) =>
          [hash, source.status === 'prepared' && (hashes.has(hash) || source.numberingRevision !== revision) ? { ...source, status: 'verify' as const } : source]));
        queue.updateItem(item, { selected });
        resumePreparedMapping(queue, finder, item, entryIds, 'numbering applied by the user');
      }
      if (recheck.size) await db.write();
      return void res.json({ ...summary, done: true });
    }

    // The search of the other seasons needs the saved numbering of the season. The map is a decision of the user, so a
    // missing one opens the editor instead of guessing from the files of a pack.
    if (action === 'search_other_seasons' && group && typeof group.titleKey === 'string') {
      const title = db.data.titles[group.titleKey];
      const season = group.season ?? null;
      const mapped = title && season !== null ? releaseSeasons(normalizeNumbering(title.numbering), season).filter((releaseSeason) => releaseSeason !== season) : [];
      if (!mapped.length) return void res.status(409).json({ error: 'numbering_required' });
    }

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
      const refusal = supports(action, entry, removal, Boolean(group));
      if (refusal) unsupported.push({ id: entry.id, reason: refusal });
      else for (const other of scope(action, entry)) affected.set(other.id, other);
    }
    const lane = lanePositions();
    const list = [...affected.values()];
    const transfers = new Map<string, number>();
    for (const entry of list) if (entry.transferHash && ['pause', 'resume', 'remove_torrent'].includes(action)) transfers.set(entry.transferHash, (transfers.get(entry.transferHash) ?? 0) + 1);
    const actionScope = { action, ids: picked.map((entry) => entry.id).sort(), affected: list.map((entry) => entry.id).sort() };
    const actionState = { entries: list, associations: [...new Set(list.map((entry) => entry.titleKey))].map(associationState) };
    const summary = { action, version: resolutionVersion(actionScope, actionState), affected: list.map((entry) => ({ id: entry.id, label: label(entry), status: statusOf(entry), phase: phaseOfEntry(entry), lane: lane.get(entry.id) ?? null })), unsupported, sharedTransfers: [...transfers].map(([hash, count]) => ({ name: poller.transfer(hash)?.name ?? removal?.torrents.get(hash)?.name ?? hash, entries: count })) };
    if (preview) return void res.json(summary);
    if (action === 'replace' && (typeof version !== 'string' || !version)) return void res.status(409).json({ error: 'preview_required' });
    if (version !== undefined && !resolutionCurrent(version, actionScope, actionState)) return void res.status(409).json({ error: 'preview_changed' });
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
