import { db } from '../../core/db.ts';
import { JobError } from '../../core/jobs.ts';
import { catalog, itemFields } from '../../core/log.ts';
import { ClientError } from '../downloads/qbittorrent.ts';
import { addedByApp, isActive } from '../downloads/queue.ts';
import { hasFreeSlot } from '../downloads/slots.ts';
import { isSample, isVideoFile, parseEpisodes, releaseEpisodes } from '../parse.ts';
import { splitOf } from '../split.ts';
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

// The torrent is one file, and the data file keeps text. The target keeps the source while it waits for a slot.
const encode = (source: Source) => ('magnet' in source ? { magnet: source.magnet } : { torrent: source.torrent.toString('base64') });
const decode = (entry: QueueEntry): Source | null =>
  !entry.source ? null : 'magnet' in entry.source ? { magnet: entry.source.magnet } : { torrent: Buffer.from(entry.source.torrent, 'base64') };

// The chosen release is fetched first, and it waits for a slot of the client after that. The fetch and the send are two
// steps: a full client must not stop the fetch, and the fetched torrent must not come from the indexer a second time.
export function createGrabber({ queue, finder, indexers, clients, save, enqueue, reconcileMs = 1_000 }: GrabberDeps) {
  // The entries of a pack that its files do not cover, and the number of files that name an episode. The check is the
  // same as the check of the import. The names come from the torrent file, before the client has the release, or from
  // the client, when it has the release already.
  function missingFrom(files: string[], entries: QueueEntry[]) {
    // A torrent with one file has no list to compare.
    if (files.length < 2) return { missing: [] as QueueEntry[], releaseSeason: null as number | null, numbers: [] as number[] };
    const title = db.data.titles[entries[0]!.titleKey];
    const continuation = entries.find((entry) => entry.continuation)?.continuation ?? null;
    const videos = files.filter((file) => isVideoFile(file) && !isSample(file));
    // The numbers of the release, which the record of the pack keeps for the manual search of the other seasons.
    const readings = videos.map((file) => parseEpisodes(file)).filter((item): item is ParsedEpisodes => Boolean(item));
    const seasons = new Set(readings.map((item) => item.season));
    const held = videos.map((file) => releaseEpisodes(file, title?.episodes ?? [], continuation, null, title?.meta.title ?? null));
    return {
      missing: entries.filter((entry) => !held.some((found) => found?.season === entry.season && found.numbers.includes(entry.number!))),
      releaseSeason: seasons.size === 1 ? [...seasons][0]! : null,
      numbers: [...new Set(readings.flatMap((item) => item.numbers))].sort((a, b) => a - b),
    };
  }

  // The mapping that the files of a pack establish, when the release numbers its seasons in another way than the title.
  // The files are the evidence: a release that names its season 2 for the last episodes of season 1 of the title makes
  // those files the episodes from `from` up. A pack of the season of the title keeps the numbering of the title. False
  // stops the pack: its files give no mapping, and its targets stay stuck with the reason of the partial pack.
  function applyMapping(entries: QueueEntry[], files: string[]): boolean {
    const title = db.data.titles[entries[0]!.titleKey];
    const season = entries[0]!.season;
    if (!title || season === null || files.length < 2) return true;
    const readings = files.filter((file) => isVideoFile(file) && !isSample(file)).map((file) => parseEpisodes(file)).filter((item): item is ParsedEpisodes => Boolean(item));
    if (!readings.length) return true;
    const seasons = new Set(readings.map((item) => item.season));
    if (seasons.size !== 1) return true;
    const releaseSeason = [...seasons][0]!;
    if (releaseSeason === season) return true;
    const numbers = [...new Set(readings.flatMap((item) => item.numbers))];
    const total = title.episodes.filter((episode) => episode.season === season).length;
    const missing = entries.flatMap((entry) => (entry.number === null ? [] : [entry.number]));
    const split = splitOf({ season, total, numbers, missing });
    if (!split) return false;
    for (const entry of entries) entry.continuation = { releaseSeason, season, from: split.from };
    return true;
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
      // The user cancelled while the fetch ran. The torrent stays in the client, and the entry stays cancelled.
      if (entry.state.kind === 'cancelled') {
        queue.observe(entry, 'torrent added before the cancel', 'The torrent stays in the client.');
        continue;
      }
      entry.transferHash = found.hash;
      entry.clientId = connection.id;
      entry.source = null;
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
  function take(entries: QueueEntry[], connection: ClientHandle, found: Torrent) {
    if (addedByApp(found.hash) || found.complete) return adopt(entries, connection, found, !addedByApp(found.hash));
    for (const entry of entries) {
      catalog.warn('download_exists', `The torrent is already in ${connection.config.name} and belongs to the user`, itemFields(entry), { client: connection.config.name, hash: found.hash, name: found.name });
      queue.block(entry, { code: 'torrent_exists' }, 'torrent is in the client already');
    }
  }

  // Fetches the torrent of the release. The fetch ends when the source is saved, and the target then waits for a slot.
  async function fetch(entries: QueueEntry[], signal: AbortSignal) {
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
    const { api } = connection;
    // The client is known before the first request, so a send goes to the same client.
    for (const entry of entries) entry.clientId = connection.id;

    // A hash from an earlier try: if the client has the torrent, the work is done.
    let hash = ref.infoHash;
    if (hash) {
      const found = await clients.find(connection, hash);
      if (found) return take(entries, connection, found);
    }

    let source = decode(leader);
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
        const held = seen ? await clients.find(connection, seen) : undefined;
        if (held) {
          const files = ref.kind === 'pack' ? (await api.files(held.hash)).map((file) => file.name) : [];
          if (ref.kind === 'pack' && !applyMapping(entries, files)) return finder.refusePack(entries, 'pack_mapping_unknown');
          const pack = missingFrom(files, entries);
          if (pack.missing.length) entries = finder.partial(entries, pack.missing, { files: files.length, releaseSeason: pack.releaseSeason, numbers: pack.numbers });
          if (entries.length) take(entries, connection, held);
          return;
        }
        const got = await indexers.download(indexer, ref.link, { signal });
        if ('magnet' in got) source = got;
        else {
          try {
            hash = infoHashOf(got.torrent);
          } catch {
            // The indexer sent a file that is not a torrent. The release is bad, not the indexer.
            return finder.fallback(entries, 'invalid_torrent');
          }
          source = got;
          // A pack must hold the episodes that it covers. The torrent file lists its files before the client has any data.
          if (ref.kind === 'pack') {
            const files = packFiles(got.torrent);
            // A list that ladarr cannot read gives no mapping. The import still blocks a missing episode.
            if (files) {
              if (!applyMapping(entries, files)) return finder.refusePack(entries, 'pack_mapping_unknown');
              const pack = missingFrom(files, entries);
              if (pack.missing.length) entries = finder.partial(entries, pack.missing, { files: files.length, releaseSeason: pack.releaseSeason, numbers: pack.numbers });
              if (!entries.length) return;
            }
          }
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
    // and the indexer is not asked again for it.
    const saved = encode(source);
    for (const entry of entries) {
      entry.transferHash = hash;
      entry.clientId = connection.id;
      entry.source = saved;
      if (entry.release) entry.release.infoHash = hash;
    }
    await save();

    // The torrent can appear in the client while the fetch runs, for example when another target of the pack sends it.
    clients.invalidate(connection);
    const existing = await clients.find(connection, hash!);
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
    const existing = await clients.find(connection, hash);
    if (existing) return take(entries, connection, existing);
    const source = decode(leader);
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
      if (!(error instanceof ClientError)) throw error;
      // The add may have worked even if the answer did not come. Read the client before any other try.
      for (let i = 0; i < 3; i++) {
        await sleep(reconcileMs);
        clients.invalidate(connection);
        const found = await clients.find(connection, hash).catch(() => null);
        if (found) return take(entries, connection, found);
      }
      throw new JobError(error.code === 'unreachable' ? 'uncertain' : 'outage', error.message);
    }
    // The client answers the add before it lists the torrent, so the reader waits for the list.
    for (let i = 0; i < 3; i++) {
      if (i) await sleep(reconcileMs);
      clients.invalidate(connection);
      const added = await clients.find(connection, hash);
      if (added) return take(entries, connection, added);
    }
    throw new JobError('uncertain', 'The client accepted the torrent but does not list it.');
  }

  return { fetch, send };
}
