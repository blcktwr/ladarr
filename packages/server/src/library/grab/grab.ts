import { db } from '../../core/db.ts';
import { JobError } from '../../core/jobs.ts';
import { catalog, itemFields } from '../../core/log.ts';
import { inspectCoverage } from '../coverage.ts';
import { ClientError } from '../downloads/qbittorrent.ts';
import { addedByApp, forgetSource, isActive } from '../downloads/queue.ts';
import { hasFreeSlot } from '../downloads/slots.ts';
import { isSample, isVideoFile, parseEpisodes } from '../parse.ts';
import { NO_NUMBERING } from '../numbering.ts';
import { infoHashOf, magnetHash, torrentComment, torrentFiles } from './torrent.ts';
import { IndexerError } from './torznab.ts';
import type { ClientHandle, GrabberDeps, ParsedEpisodes, QueueEntry, Torrent } from '../../types.ts';

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

type Source = { torrent: Buffer } | { magnet: string };

// The torrent is one file, and the data file keeps text. The target keeps the source while it waits for a slot: a
// magnet stays in the target, and the file of a torrent stays once for each hash, in `Data.torrents`.
const encode = (source: Source): NonNullable<QueueEntry['source']> => ('magnet' in source ? { magnet: source.magnet } : { torrent: true });
const decode = (entry: QueueEntry): Source | null => {
  if (!entry.source) return null;
  if ('magnet' in entry.source) return { magnet: entry.source.magnet };
  const saved = entry.transferHash ? db.data.torrents[entry.transferHash] : undefined;
  return saved ? { torrent: Buffer.from(saved, 'base64') } : null;
};

// The chosen release is fetched first, and it waits for a slot of the client after that. The fetch and the send are two
// steps: a full client must not stop the fetch, and the fetched torrent must not come from the indexer a second time.
export function createGrabber({ queue, finder, indexers, clients, save, enqueue, reconcileMs = 1_000 }: GrabberDeps) {
  // Async results belong to the acquisition that requested them, not to a later user selection.
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

  // Unknown files are not evidence of absence. Each acquisition uses its saved map for the complete source.
  function missingFrom(files: string[], entries: QueueEntry[]) {
    const title = db.data.titles[entries[0]!.titleKey];
    const videos = files.filter((file) => isVideoFile(file) && !isSample(file));
    // The numbers of the release, which the record of the pack keeps for the manual search of the other seasons.
    const readings = videos.map((file) => parseEpisodes(file)).filter((item): item is ParsedEpisodes => Boolean(item));
    const seasons = new Set(readings.map((item) => item.season));
    const manifests = new Map<string, ReturnType<typeof inspectCoverage>>();
    const status = (entry: QueueEntry) => {
      if (!title || entry.season === null || entry.number === null) return 'unknown';
      const numbering = entry.numbering === undefined ? title.numbering ?? NO_NUMBERING : entry.numbering;
      const key = JSON.stringify(numbering);
      if (!manifests.has(key)) manifests.set(key, inspectCoverage(files, title, numbering));
      return manifests.get(key)!.status({ season: entry.season, number: entry.number });
    };
    const missing = entries.filter((entry) => status(entry) === 'absent');
    const unknown = entries.filter((entry) => status(entry) === 'unknown');
    return {
      missing,
      unknown,
      identified: [...manifests.values()].flatMap((manifest) => manifest.episodes),
      releaseSeason: seasons.size === 1 ? [...seasons][0]! : null,
      numbers: [...new Set(readings.flatMap((item) => item.numbers))].sort((a, b) => a - b),
    };
  }

  function inspect(entries: QueueEntry[], files: string[], deferUnknown = false) {
    const pack = missingFrom(files, entries);
    // An opaque source can need downloaded metadata. It establishes neither episode coverage nor absence.
    if (deferUnknown && !pack.identified.length && !pack.missing.length) return entries;
    for (const entry of pack.unknown) {
      queue.endAttempt(entry, 'failed', 'file_unmapped');
      queue.block(entry, { code: 'file_unmapped' }, 'the source has an unassigned file');
    }
    const known = entries.filter((entry) => !pack.unknown.includes(entry));
    if (!pack.missing.length) return known;
    if (!pack.numbers.length) {
      for (const entry of pack.missing) queue.block(entry, { code: 'pack_partial' }, 'the manifest has no video for the target');
      return known.filter((entry) => !pack.missing.includes(entry));
    }
    return finder.partial(known, pack.missing, { files: files.length, releaseSeason: pack.releaseSeason, numbers: pack.numbers });
  }

  // The files of the .torrent, or null when ladarr cannot read the list.
  function packFiles(torrent: Buffer): string[] | null {
    try {
      return torrentFiles(torrent).map((file) => file.path);
    } catch {
      return null;
    }
  }

  function block(entries: QueueEntry[], code: string, cause: string) {
    for (const entry of entries) queue.block(entry, { code }, cause);
  }

  // The client has the torrent. The target waits for it, or goes to its import when the data is there. The torrent of
  // the user stays the user's, so a removal never deletes it.
  function adopt(entries: QueueEntry[], connection: ClientHandle, found: Torrent, external: boolean) {
    for (const entry of entries) {
      // Automatic adoption leaves stopped targets unchanged.
      if (!isActive(entry) || entry.state.kind === 'blocked' || entry.state.kind === 'paused') continue;
      entry.transferHash = found.hash;
      entry.clientId = connection.id;
      forgetSource(entry);
      if (entry.release) {
        entry.release.infoHash = found.hash;
        // A torrent that ladarr did not send stays the user's, so a removal never deletes it.
        if (external) entry.release.external = true;
      }
      if (external) catalog.warn('download_exists', `The torrent is already in ${connection.config.name} and belongs to the user`, itemFields(entry), { client: connection.config.name, hash: found.hash, name: found.name });
      else catalog.info('download_added', `${connection.config.name} added "${found.name}"`, itemFields(entry), { client: connection.config.name, hash: found.hash, name: found.name });
      queue.enter(entry, found.complete ? 'importing' : 'downloading', external ? 'torrent is in the client already' : 'client accepted', found.name);
    }
    // The download is in the client already, so the import checks it now.
    if (found.complete && entries.some((entry) => entry.state.kind === 'importing')) {
      enqueue({ type: 'import.run', payload: { hash: found.hash }, dedupeKey: `import:${found.hash}`, priority: entries.some((entry) => entry.priority !== null) });
    }
  }

  // A torrent in the client with the hash of the release is the release. A finished torrent is used as it is, also when
  // ladarr did not send it, because the user added it by hand or an older version did. A torrent that still downloads
  // is the user's, and ladarr does not take it over: the target stops with the reason that offers the attach.
  async function take(entries: QueueEntry[], connection: ClientHandle, found: Torrent) {
    entries = entries.filter((entry) => isActive(entry) && entry.state.kind !== 'blocked' && entry.state.kind !== 'paused');
    if (!entries.length) return;
    if (entries[0]!.release?.kind === 'pack') {
      const source = decode(entries[0]!);
      const saved = source && 'torrent' in source ? packFiles(source.torrent) : null;
      // The client can still lack metadata after an add. Its temporary names cannot replace the fetched manifest.
      const current = snapshot(entries);
      const files = saved ?? (await connection.api.files(found.hash)).map((file) => file.name);
      entries = current();
      if (!entries.length) return;
      for (const entry of entries) {
        if (entry.state.kind === 'blocked' || !isActive(entry)) continue;
        entry.transferHash = found.hash;
        entry.clientId = connection.id;
        if (entry.release) {
          entry.release.infoHash = found.hash;
          if (!addedByApp(found.hash)) entry.release.external = true;
        }
      }
      entries = inspect(entries.filter((entry) => entry.state.kind !== 'blocked' && isActive(entry)), files, addedByApp(found.hash));
      if (!entries.length) return;
    }
    if (addedByApp(found.hash) || found.complete) return adopt(entries, connection, found, !addedByApp(found.hash));
    for (const entry of entries) {
      catalog.warn('download_exists', `The torrent is already in ${connection.config.name} and belongs to the user`, itemFields(entry), { client: connection.config.name, hash: found.hash, name: found.name });
      queue.block(entry, { code: 'torrent_exists' }, 'torrent is in the client already');
    }
  }

  // Fetches the torrent of the release. The fetch ends when the source is saved, and the target then waits for a slot.
  async function fetch(entries: QueueEntry[], signal: AbortSignal) {
    entries = entries.filter((entry) => isActive(entry) && entry.state.kind !== 'blocked' && entry.state.kind !== 'paused');
    if (!entries.length) return;
    const leader = entries[0]!;
    const ref = leader.release!;
    // A retry goes to the client that got the first try, because the add may have worked there.
    const connection = leader.clientId ? clients.get(leader.clientId) : clients.next();
    if (!connection) {
      for (const entry of entries) {
        catalog.warn('download_no_client', `No download client is available for "${ref.title}"`, itemFields(entry), { release: ref.title });
        // The release stops before the request, so the entry keeps the phase of the fetch and its release for the retry.
        queue.block(entry, { code: 'client_missing' }, 'no download client');
      }
      return;
    }
    // The client is known before the first request, so a send goes to the same client.
    for (const entry of entries) entry.clientId = connection.id;

    // A hash from an earlier try: if the client has the torrent, the work is done.
    let hash = ref.infoHash;
    if (hash) {
      const current = snapshot(entries);
      const found = await clients.find(connection, hash);
      entries = current();
      if (!entries.length) return;
      if (found) return take(entries, connection, found);
    }

    let source = decode(entries[0]!);
    if (!source) {
      if (ref.link) {
        const indexer = db.data.indexers[ref.indexerId] ?? downloaderOf(ref.link);
        if (!indexer) {
          block(entries, 'no_indexers', 'no indexer for the release');
          return;
        }
        // An earlier try of this season took the release, so the client has the torrent. ladarr reads its files from the
        // client and never downloads the release from the indexer again: that download costs the ratio of the indexer
        // and brings nothing, because the data is in the client already.
        const seen = Object.values(db.data.queue).find(
          (entry) => entry.titleKey === leader.titleKey && entry.season === leader.season && entry.release?.indexerId === ref.indexerId && entry.release.guid === ref.guid && entry.transferHash,
        )?.transferHash;
        const heldCurrent = snapshot(entries);
        const held = seen ? await clients.find(connection, seen) : undefined;
        entries = heldCurrent();
        if (!entries.length) return;
        if (held) {
          return take(entries, connection, held);
        }
        const current = snapshot(entries);
        let got: Awaited<ReturnType<typeof indexers.download>>;
        try {
          got = await indexers.download(indexer, ref.link, { signal });
        } catch (error) {
          if (!current().length) return;
          throw error;
        }
        entries = current();
        if (!entries.length) return;
        if ('magnet' in got) source = got;
        else {
          try {
            hash = infoHashOf(got.torrent);
          } catch {
            // The indexer sent a file that is not a torrent. The release is bad, not the indexer.
            return finder.fallback(entries, 'invalid_torrent');
          }
          source = got;
        }
      } else if (ref.magnet) source = { magnet: ref.magnet };
      else return finder.fallback(entries, 'no_download_link');
    }

    if ('magnet' in source) {
      hash = magnetHash(source.magnet) ?? null;
      if (!hash) return finder.fallback(entries, 'invalid_magnet');
    } else {
      // The comment can only come from the file of the release. A magnet has no file to read.
      const comment = torrentComment(source.torrent);
      for (const entry of entries) if (entry.release) entry.release.comment = comment;
    }

    // The hash and the source are saved before the wait. After a crash, the target still knows which torrent to send,
    // and the indexer is not asked again for it. The file is one copy for the whole pack.
    const saved = encode(source);
    if ('torrent' in source && hash) db.data.torrents[hash] = source.torrent.toString('base64');
    for (const entry of entries) {
      if (entry.state.kind === 'blocked' || !isActive(entry)) continue;
      entry.transferHash = hash;
      entry.clientId = connection.id;
      entry.source = saved;
      if (entry.release) entry.release.infoHash = hash;
    }
    entries = entries.filter((entry) => entry.state.kind !== 'blocked' && isActive(entry));
    if (ref.kind === 'pack' && 'torrent' in source) {
      const files = packFiles(source.torrent);
      if (files && entries.length) entries = inspect(entries, files, true);
    }
    const savedCurrent = snapshot(entries);
    await save();
    entries = savedCurrent();
    if (!entries.length) return;

    // The torrent can appear in the client while the fetch runs, for example when another target of the pack sends it.
    clients.invalidate(connection);
    const current = snapshot(entries);
    const existing = await clients.find(connection, hash!);
    entries = current();
    if (!entries.length) return;
    if (existing) return take(entries, connection, existing);

    for (const entry of entries) queue.enter(entry, 'waiting_slot', 'torrent fetched', ref.title);
    enqueue({
      type: 'queue.send',
      payload: { entryIds: entries.map((entry) => entry.id) },
      dedupeKey: `send:${leader.id}`,
      // The oldest target of the list takes the next free slot.
      runAt: Math.min(...entries.map((entry) => entry.createdAt)),
      priority: entries.some((entry) => entry.priority !== null),
    });
  }

  // Sends the fetched torrent to the client, when the client has a free slot. The source stays with the targets until
  // the client accepts it, so a wait or a restart sends the saved source and never asks the indexer again.
  async function send(entries: QueueEntry[], signal: AbortSignal) {
    entries = entries.filter((entry) => isActive(entry) && entry.state.kind !== 'blocked' && entry.state.kind !== 'paused');
    if (!entries.length) return;
    const leader = entries[0]!;
    const ref = leader.release;
    const connection = leader.clientId ? clients.get(leader.clientId) : clients.next();
    if (!connection) {
      block(entries, 'client_missing', 'no download client');
      return;
    }
    for (const entry of entries) entry.clientId = connection.id;
    const hash = leader.transferHash ?? ref?.infoHash ?? null;
    if (!hash) {
      // Nothing to send. The release is fetched again from its link or magnet.
      for (const entry of entries) queue.enter(entry, 'fetching', 'the torrent source is gone');
      enqueue({ type: 'queue.grab', payload: { entryIds: entries.map((entry) => entry.id) }, dedupeKey: `grab:${leader.id}`, priority: entries.some((entry) => entry.priority !== null) });
      return;
    }

    // The torrent can be in the client already, for example after a manual add. No slot is used by a torrent that is
    // there already.
    clients.invalidate(connection);
    const current = snapshot(entries);
    const existing = await clients.find(connection, hash);
    entries = current();
    if (!entries.length) return;
    if (existing) return take(entries, connection, existing);
    const source = decode(entries[0]!);
    if (!source) {
      for (const entry of entries) queue.enter(entry, 'fetching', 'the torrent source is gone');
      enqueue({ type: 'queue.grab', payload: { entryIds: entries.map((entry) => entry.id) }, dedupeKey: `grab:${leader.id}`, priority: entries.some((entry) => entry.priority !== null) });
      return;
    }

    // The check and the change are one step: two sends cannot take the same free slot.
    const own = new Set(entries.map((entry) => entry.id));
    if (!hasFreeSlot(clients, connection.id, own)) {
      // A slot that another send took. The target keeps its source, and a new job asks again for a slot.
      enqueue({
        type: 'queue.send',
        payload: { entryIds: entries.map((entry) => entry.id) },
        dedupeKey: `send-wait:${leader.id}`,
        runAt: Date.now() + 2_000,
        priority: entries.some((entry) => entry.priority !== null),
      });
      return;
    }

    db.data.sentTorrents[hash] = Date.now();
    for (const entry of entries) queue.enter(entry, 'sending', 'sending to the client', ref?.title ?? hash);
    const sentCurrent = snapshot(entries);
    try {
      for (const entry of entries) {
        catalog.info('download_started', `Sending "${ref?.title ?? hash}" to ${connection.config.name}`, itemFields(entry), {
          client: connection.config.name,
          hash,
          release: ref?.title ?? hash,
          kind: ref?.kind ?? 'single',
          sizeBytes: ref?.sizeBytes ?? 0,
        });
      }
      await connection.api.add(source, ref?.seed);
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
        if (found) return take(entries, connection, found);
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
      if (added) return take(entries, connection, added);
    }
    throw new JobError('uncertain', 'The client accepted the torrent but does not list it.');
  }

  return { fetch, send };
}
