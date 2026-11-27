import { randomUUID } from 'node:crypto';
import { db } from '../../core/db.ts';
import { JobError } from '../../core/jobs.ts';
import { catalog, itemFields } from '../../core/log.ts';
import { inspectCoverage } from '../coverage.ts';
import { ClientError } from '../downloads/qbittorrent.ts';
import { forgetSource, getItem, isActive, phaseOfEntry } from '../downloads/queue.ts';
import { hasFreeSlot } from '../downloads/slots.ts';
import { findUpload, uploadHash, uploadInUse, uploadOwner } from '../downloads/upload.ts';
import { matchMovie } from './match.ts';
import { hashOfMagnet, torrentManifest } from './source.ts';
import { IndexerError } from './torznab.ts';
import type { ClientHandle, EnqueueInput, GrabberDeps, Job, QueueEntry, QueueTorrent, QueueTurn, Torrent } from '../../types.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The indexer of a release can be gone, for example when the user adds it again. The link is complete, so an indexer with the same host downloads it.
export function downloaderOf(link: string) {
  const list = Object.values(db.data.indexers);
  const origin = new URL(link).origin;
  return list.find((indexer) => new URL(indexer.baseUrl).origin === origin) ?? list[0];
}

// What the user reads when a try fails. The codes are stable. The texts are in the user interface.
export function reasonOf(error: unknown) {
  if (error instanceof ClientError) return { code: error.code === 'rejected' ? 'client_rejected' : 'client_unreachable' };
  if (error instanceof IndexerError) return { code: error.code === 'rejected' ? 'indexer_rejected' : 'indexer_unavailable' };
  return { code: 'grab_failed' };
}

export const sendPhase = (entry: QueueEntry) => ['fetching', 'waiting_slot', 'sending'].includes(entry.state.kind);

function legacyMovie(item: QueueTurn, torrent: QueueTorrent) {
  const id = item.entryIds[0];
  return item.season === null && id && Object.hasOwn(torrent.matches, id) && !torrent.matches[id] ? id : undefined;
}

export function savedFiles(torrent: Pick<QueueTorrent, 'hash' | 'manifest' | 'source'>) {
  if (torrent.source && 'magnet' in torrent.source) {
    return hashOfMagnet(torrent.source.magnet) === torrent.hash ? torrent.manifest : undefined;
  }
  const saved = torrent.source && db.data.torrents[torrent.hash];
  if (!saved) return;
  try {
    const manifest = torrentManifest(Buffer.from(saved, 'base64'));
    if (manifest.hash === torrent.hash) return manifest.files;
  } catch {}
}

export function currentSelection(item: QueueTurn, torrent: QueueTorrent) {
  const title = db.data.titles[item.titleKey];
  const source = torrent.source && ('magnet' in torrent.source || db.data.torrents[torrent.hash]);
  return Boolean(title && !title.paused &&
    ((torrent.status === 'prepared' && source) || (torrent.status === 'uncertain' && (source || (torrent.clientId && legacyMovie(item, torrent))))) &&
    (item.season === null || (torrent.numberingRevision ?? 0) === (title.numbering?.revision ?? 0)));
}

export const canReconcileMovie = (item: QueueTurn, torrent: QueueTorrent) =>
  ['fetching', 'downloading', 'importing'].includes(item.state.kind) && Boolean(legacyMovie(item, torrent));

export function readySelection(item: QueueTurn) {
  if (!['fetching', 'downloading', 'importing'].includes(item.state.kind)) return false;
  const title = db.data.titles[item.titleKey];
  if (!title || title.paused) return false;
  const sources = Object.values(item.selected);
  const manifests = new Map<string, ReturnType<typeof inspectCoverage> | null>();
  const matched = (torrent: QueueTorrent, entry: QueueEntry) => {
    if (!Object.hasOwn(torrent.matches, entry.id)) return false;
    if (torrent.status === 'accepted' || torrent.matches[entry.id]) return true;
    if (entry.season === null) return Boolean(matchMovie(savedFiles(torrent) ?? []).file);
    if (entry.number === null) return false;
    if (!manifests.has(torrent.hash)) {
      const files = savedFiles(torrent);
      manifests.set(torrent.hash, files ? inspectCoverage(files, title, title.numbering) : null);
    }
    return manifests.get(torrent.hash)?.status({ season: entry.season, number: entry.number }) === 'identified';
  };
  return item.entryIds.every((id) => {
    const entry = db.data.queue[id];
    if (!entry) return false;
    if (!isActive(entry)) return true;
    if (entry.transferHash && entry.clientId && ['downloading', 'importing'].includes(entry.state.kind)) return true;
    return sources.some((torrent) => (torrent.status === 'accepted' || currentSelection(item, torrent)) && matched(torrent, entry));
  });
}

export function enqueueSelection(item: QueueTurn, enqueue: (input: EnqueueInput) => Job) {
  const ready = readySelection(item);
  for (const torrent of Object.values(item.selected)) {
    if (!currentSelection(item, torrent) || (!ready && !canReconcileMovie(item, torrent))) continue;
    if (Object.values(db.data.jobs).some((job) => {
      if (job.type !== 'queue.send' || job.state === 'failed') return false;
      const payload = job.payload as { itemId?: string; hash?: string };
      return payload.itemId === item.id && payload.hash === torrent.hash;
    })) continue;
    enqueue({
      type: 'queue.send',
      payload: { itemId: item.id, hash: torrent.hash, entryIds: Object.keys(torrent.matches) },
      dedupeKey: `send:${item.id}:${torrent.hash}`,
      runAt: item.createdAt,
      priority: item.priority !== null,
    });
  }
}

export function createGrabber({ queue, clients, save, enqueue, reconcileMs = 1_000 }: GrabberDeps) {
  // A client response applies only to the upload that made the request.
  function snapshot(entries: QueueEntry[]) {
    const input = (entry: QueueEntry) => JSON.stringify({
      state: entry.state, attempt: entry.attempt, release: entry.release, source: entry.source,
      numbering: entry.numbering === undefined ? db.data.titles[entry.titleKey]?.numbering : entry.numbering,
      hash: entry.transferHash, clientId: entry.clientId, manualMatch: entry.manualMatch,
    });
    const expected = entries.map((entry) => ({ entry, title: db.data.titles[entry.titleKey], release: entry.release, source: entry.source, input: input(entry) }));
    return () => expected.filter((saved) => db.data.queue[saved.entry.id] === saved.entry
      && db.data.titles[saved.entry.titleKey] === saved.title && saved.entry.release === saved.release && saved.entry.source === saved.source
      && saved.entry.state.kind !== 'blocked' && saved.entry.state.kind !== 'paused' && isActive(saved.entry) && input(saved.entry) === saved.input).map((saved) => saved.entry);
  }

  function block(entries: QueueEntry[], code: string, cause: string) {
    for (const entry of entries) queue.block(entry, { code }, cause);
  }

  // The client has the torrent. The target waits for it or starts the import when the data is there.
  function adopt(entries: QueueEntry[], connection: ClientHandle, found: Torrent, external: boolean) {
    for (const entry of entries) {
      // Automatic adoption leaves stopped targets unchanged.
      if (!isActive(entry) || entry.state.kind === 'blocked' || entry.state.kind === 'paused') continue;
      entry.transferHash = found.hash;
      entry.clientId = connection.id;
      if (entry.release) {
        entry.release.infoHash = found.hash;
        if (entry.release.uploadPath) {
          entry.release.uploadOwner = external ? undefined : connection.id;
          entry.release.external = external;
        }
        if (external) entry.release.external = true;
      }
      if (external) catalog.warn('download_exists', `The torrent is already in ${connection.config.name} and belongs to the user`, itemFields(entry), { client: connection.config.name, hash: found.hash, name: found.name });
      else catalog.info('download_added', `${connection.config.name} added "${found.name}"`, itemFields(entry), { client: connection.config.name, hash: found.hash, name: found.name });
      queue.enter(entry, found.complete ? 'importing' : 'downloading', external ? 'torrent is in the client already' : 'client accepted', found.name);
      if (!uploadHash(entry)) forgetSource(entry);
    }
    // The download is in the client already, so the import checks it now.
    if (found.complete && entries.some((entry) => entry.state.kind === 'importing')) {
      enqueue({ type: 'import.run', payload: { hash: found.hash }, dedupeKey: `import:${found.hash}`, priority: entries.some((entry) => entry.priority !== null) });
    }
  }

  async function submit(item: QueueTurn, torrent: QueueTorrent, signal: AbortSignal) {
    const { hash } = torrent;
    const current = () => getItem(item.id) === item && item.selected[hash] === torrent &&
      (readySelection(item) || canReconcileMovie(item, torrent));
    const targets = () => Object.keys(torrent.matches).flatMap((id) => {
      const entry = queue.get(id);
      return entry && item.entryIds.includes(id) && (!entry.transferHash || entry.transferHash === hash) && !uploadHash(entry) && sendPhase(entry) ? [entry] : [];
    });
    const wait = () => enqueue({
      type: 'queue.send', payload: { itemId: item.id, hash, entryIds: targets().map(({ id }) => id) },
      dedupeKey: `send-wait:${item.id}:${hash}`, runAt: Date.now() + 2_000, priority: item.priority !== null,
    });
    if (!current() || !targets().length || !currentSelection(item, torrent)) return;
    const connection = torrent.status === 'uncertain' && torrent.clientId ? clients.get(torrent.clientId) : clients.next();
    if (!connection) {
      queue.holdClient(item, true);
      wait();
      return;
    }
    queue.holdClient(item, false);
    const stopped = () => {
      if (signal.aborted || db.data.queuePaused || !current() || !currentSelection(item, torrent) || !targets().length) return true;
      if (clients.get(connection.id) === connection) return false;
      queue.holdClient(item, !clients.next());
      wait();
      return true;
    };
    const stop = (code: string, cause: string) => {
      block(targets(), code, cause);
      queue.transitionItem(item, { kind: 'blocked', at: 'fetching', problem: { code } });
    };
    const accept = async (found: Torrent) => {
      const entries = targets();
      if (!current() || !entries.length) return;
      queue.updateItem(item, { selected: { ...item.selected, [hash]: { ...torrent, status: 'accepted', clientId: connection.id, source: null } } });
      db.data.sentTorrents[hash] ??= Date.now();
      for (const entry of entries) entry.release ??= { ...torrent.release, infoHash: hash };
      adopt(entries, connection, found, false);
      if (item.state.kind === 'fetching' && Object.values(item.selected).some((source) => source.status !== 'accepted')) {
        queue.transitionItem(item, { kind: 'downloading' });
      }
      await save();
    };
    const owns = (found: Torrent) => {
      const tags = found.tags.split(',').map((tag) => tag.trim());
      if (torrent.addTag) return tags.includes(torrent.addTag);
      const sentAt = db.data.sentTorrents[hash];
      if (torrent.status === 'uncertain' && sentAt && found.category === 'ladarr' && found.addedAt >= Math.floor(sentAt / 1_000) * 1_000) return true;
      return Object.values(db.data.queueItems).some((other) => {
        const selection = other.selected[hash];
        return other.titleKey === item.titleKey && selection?.status === 'accepted' &&
          selection.clientId === connection.id && !selection.release.external &&
          (!selection.addTag || tags.includes(selection.addTag));
      });
    };
    const find = () => connection.api.find(hash);
    const claimed = () => Object.values(db.data.queueItems).some((other) => {
      const selection = other.selected[hash];
      return other.titleKey !== item.titleKey && selection?.clientId === connection.id &&
        (selection.status === 'accepted' || selection.status === 'uncertain');
    }) || Object.values(db.data.queue).some((entry) =>
      entry.titleKey !== item.titleKey && isActive(entry) &&
      (uploadHash(entry) === hash || (entry.transferHash === hash && entry.clientId === connection.id &&
        ['downloading', 'importing'].includes(phaseOfEntry(entry)))),
    ) || Object.values(db.data.files).some((file) => file.titleKey !== item.titleKey && !file.missing &&
      file.download?.hash === hash && file.download.clientId === connection.id);
    if (claimed()) return stop('torrent_in_use', 'another title uses this torrent');
    const reads = torrent.status === 'uncertain' ? 3 : 1;
    for (let i = 0; i < reads; i++) {
      if (i) await sleep(reconcileMs);
      if (stopped()) return;
      const found = await find();
      if (stopped()) return;
      if (found) {
        if (owns(found)) return accept(found);
        return stop('torrent_exists', 'torrent belongs to the user');
      }
    }
    if (claimed()) return stop('torrent_in_use', 'another title uses this torrent');

    const entries = targets();
    const saved = db.data.torrents[hash];
    const source = torrent.source && ('magnet' in torrent.source ? torrent.source : saved ? { torrent: Buffer.from(saved, 'base64') } : null);
    if (!source) return stop('invalid_torrent', 'the saved torrent cannot be read');
    let files: string[] | undefined = torrent.manifest;
    let sourceHash: string | undefined;
    try {
      if ('torrent' in source) {
        const manifest = torrentManifest(source.torrent);
        sourceHash = manifest.hash;
        files = manifest.files;
      } else sourceHash = hashOfMagnet(source.magnet);
    } catch {
      return stop('invalid_torrent', 'the saved torrent cannot be read');
    }
    if (sourceHash !== hash) return stop('invalid_torrent', 'the saved torrent does not match the selection');

    if (!files && 'magnet' in source) {
      files = await connection.api.metadataFiles(source.magnet, hash, signal);
      if (stopped()) return;
      torrent.manifest = files;
    }
    const paths = new Set(files);
    if (Object.values(torrent.matches).some((file) => file !== null && !paths.has(file))) {
      return stop('file_unmapped', 'the verified file is missing from the torrent');
    }
    const movie = legacyMovie(item, torrent);
    if (movie) {
      const path = matchMovie(files ?? []).file;
      if (!path) return stop('file_unmapped', 'the torrent does not contain one movie file');
      torrent.matches = { ...torrent.matches, [movie]: path };
    }
    if (!readySelection(item)) return;

    if (!hasFreeSlot(clients, connection.id, new Set(entries.map(({ id }) => id)))) {
      wait();
      return;
    }
    const previous = { status: torrent.status, clientId: torrent.clientId, addTag: torrent.addTag };
    const addTag = torrent.addTag ?? `ladarr-${randomUUID()}`;
    torrent.status = 'uncertain';
    torrent.clientId = connection.id;
    torrent.addTag = addTag;
    for (const entry of entries) {
      catalog.info('download_started', `Sending "${torrent.release.title}" to ${connection.config.name}`, itemFields(entry), {
        client: connection.config.name, hash, release: torrent.release.title, kind: torrent.release.kind, sizeBytes: torrent.release.sizeBytes,
      });
    }
    const reset = (state = previous) => {
      if (getItem(item.id) !== item || item.selected[hash] !== torrent) return;
      Object.assign(torrent, state);
      queue.updateItem(item, { selected: item.selected });
    };
    queue.updateItem(item, { selected: item.selected });
    try {
      await save();
    } catch (error) {
      reset();
      throw error;
    }
    if (stopped()) {
      reset();
      await save();
      return;
    }
    if (claimed()) {
      reset();
      return stop('torrent_in_use', 'another title uses this torrent');
    }
    let addError: unknown;
    try {
      await connection.api.add(source, torrent.release.seed, addTag);
    } catch (error) {
      addError = error;
    }
    for (let i = 0; i < 3; i++) {
      if (i || addError) await sleep(reconcileMs);
      if (stopped()) return;
      const added = await find().catch(() => null);
      if (stopped()) return;
      if (added && owns(added)) return accept(added);
      if (added) return stop('torrent_exists', 'torrent belongs to the user');
    }
    if (addError instanceof ClientError && addError.code === 'rejected') {
      if (previous.status === 'prepared') reset({ status: 'prepared', clientId: null, addTag: undefined });
      await save();
      throw addError;
    }
    throw new JobError('uncertain', 'The download client does not list the submitted torrent.');
  }

  async function sendUpload(entries: QueueEntry[], signal: AbortSignal) {
    entries = entries.filter((entry) => isActive(entry) && entry.state.kind !== 'blocked' && entry.state.kind !== 'paused');
    if (!entries.length) return;
    const leader = entries[0]!;
    const hash = uploadHash(leader);
    if (!hash) return;
    const ref = leader.release!;
    const current = snapshot(entries);
    const { download, handle: connection } = await findUpload(clients, hash, leader.clientId);
    signal.throwIfAborted();
    entries = current();
    if (!entries.length) return;
    if (uploadInUse(leader.titleKey, hash)) return block(entries, 'torrent_in_use', 'another title uses this torrent');
    if (download && clients.get(download.handle.id) === download.handle) {
      return adopt(entries, download.handle, download.torrent, !uploadOwner(leader.titleKey, hash, download.handle.id));
    }
    if (!connection || clients.get(connection.id) !== connection) {
      enqueue({ type: 'queue.send', payload: { entryIds: entries.map(({ id }) => id), uploadHash: hash }, dedupeKey: `send-wait:upload:${hash}` });
      return;
    }
    const saved = db.data.torrents[hash];
    if (!saved) return block(entries, 'upload_source_missing', 'torrent file is missing');
    const source = { torrent: Buffer.from(saved, 'base64') };
    const own = new Set(entries.map((entry) => entry.id));
    if (!hasFreeSlot(clients, connection.id, own)) {
      enqueue({
        type: 'queue.send',
        payload: { entryIds: entries.map((entry) => entry.id), uploadHash: hash },
        dedupeKey: `send-wait:upload:${hash}`,
        runAt: Date.now() + 2_000,
        priority: entries.some((entry) => entry.priority !== null),
      });
      return;
    }
    for (const entry of entries) {
      entry.clientId = connection.id;
      entry.transferHash = hash;
      entry.release!.uploadOwner = undefined;
      entry.release!.external = true;
      queue.enter(entry, 'sending', 'sending to the client', ref.title);
    }
    const sentCurrent = snapshot(entries);
    try {
      for (const entry of entries) {
        catalog.info('download_started', `Sending "${ref.title}" to ${connection.config.name}`, itemFields(entry), {
          client: connection.config.name,
          hash,
          release: ref.title,
          kind: ref.kind,
          sizeBytes: ref.sizeBytes,
        });
      }
      await connection.api.add(source, ref.seed);
    } catch (error) {
      entries = sentCurrent();
      if (!entries.length) return;
      if (!(error instanceof ClientError)) throw error;
      // The add may have worked even if the answer did not come. Read the client before any other try.
      for (let i = 0; i < 3; i++) {
        const current = snapshot(entries);
        await sleep(reconcileMs);
        entries = current();
        if (!entries.length) return;
        clients.invalidate(connection);
        const found = await clients.find(connection, hash).catch(() => null);
        entries = current();
        if (!entries.length) return;
        if (found) return adopt(entries, connection, found, true);
      }
      throw new JobError(error.code === 'unreachable' ? 'uncertain' : 'outage', error.message);
    }
    entries = sentCurrent();
    if (!entries.length) return;
    // The client answers the add before it lists the torrent, so the reader waits for the list.
    for (let i = 0; i < 3; i++) {
      const current = snapshot(entries);
      if (i) await sleep(reconcileMs);
      entries = current();
      if (!entries.length) return;
      clients.invalidate(connection);
      const added = await clients.find(connection, hash);
      entries = current();
      if (!entries.length) return;
      if (added) return adopt(entries, connection, added, false);
    }
    throw new JobError('uncertain', 'The client accepted the torrent but does not list it.');
  }

  return { sendUpload, submit };
}
