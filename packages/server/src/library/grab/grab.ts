import { type Db, db } from '../../core/db.ts';
import { JobError } from '../../core/jobs.ts';
import { catalog, itemFields } from '../../core/log.ts';
import type { Finder } from './finder.ts';
import type { Clients } from '../downloads/client-api.ts';
import { ClientError, type Torrent } from '../downloads/qbittorrent.ts';
import { addedByApp, type Queue, type QueueEntry } from '../downloads/queue.ts';
import { isSample, isVideoFile, parseEpisodes, titleNumbers } from '../parse.ts';
import { infoHashOf, magnetHash, torrentComment, torrentFiles } from './torrent.ts';
import { IndexerError, type IndexerService } from './torznab.ts';

export type GrabberDeps = {
  queue: Queue;
  finder: Finder;
  indexers: IndexerService;
  clients: Clients;
  save: () => Promise<void>;
  // The wait between two reads of the client after an add with an unknown result.
  reconcileMs?: number;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// What the user reads when a try fails. The codes are stable. The texts are in the user interface.
export function reasonOf(error: unknown) {
  if (error instanceof ClientError) return { code: error.code === 'rejected' ? 'client_rejected' : 'client_unreachable' };
  if (error instanceof IndexerError) return { code: error.code === 'rejected' ? 'indexer_rejected' : 'indexer_unavailable' };
  return { code: 'grab_failed' };
}

// Sends the chosen release to the client. Each step can be repeated: a restart or a retry reads the client first.
export function createGrabber({ queue, finder, indexers, clients, save, reconcileMs = 1_000 }: GrabberDeps): (entries: QueueEntry[], signal: AbortSignal) => Promise<void> {
  // The entries of a pack that the file list of the torrent does not cover. The check is the same as the check of the import.
  function missingFromPack(entries: QueueEntry[], torrent: Buffer) {
    let files: ReturnType<typeof torrentFiles>;
    try {
      files = torrentFiles(torrent);
    } catch {
      // ladarr cannot read the list. The import still blocks a missing episode.
      return [];
    }
    // A torrent with one file has no list to compare.
    if (files.length < 2) return [];
    const title = db.data.titles[entries[0]!.titleKey];
    const held = files
      .filter((file) => isVideoFile(file.path) && !isSample(file.path))
      .map((file) => {
        const parsed = parseEpisodes(file.path.split('/').at(-1)!) ?? parseEpisodes(file.path);
        return parsed && { season: parsed.season, numbers: titleNumbers(parsed, title?.episodes ?? []) };
      });
    return entries.filter((entry) => !held.some((found) => found?.season === entry.season && found.numbers.includes(entry.number!)));
  }

  // The indexer of a release can be gone, for example when the user adds it again. The link is complete, so an indexer with the same host downloads it.
  function downloaderOf(link: string) {
    const list = Object.values(db.data.indexers);
    const origin = new URL(link).origin;
    return list.find((indexer) => new URL(indexer.baseUrl).origin === origin) ?? list[0];
  }

  async function grab(entries: QueueEntry[], signal: AbortSignal) {
    const leader = entries[0]!;
    const ref = leader.release!;
    // A retry goes to the client that got the first try, because the add may have worked there.
    const connection = leader.clientId ? clients.get(leader.clientId) : clients.next();
    if (!connection) {
      for (const entry of entries) {
        catalog.warn('download_no_client', `No download client is available for "${ref.title}"`, itemFields(entry), { release: ref.title });
        // The release stops before the request, so the entry keeps the stage of the fetch and its release for the retry.
        queue.move(entry, { reason: { code: 'client_missing' } }, 'no download client');
      }
      return;
    }
    const { api } = connection;
    // The client is known before the first request, so the limit of its downloads counts this target from now.
    for (const entry of entries) entry.clientId = connection.id;

    const adopt = (found: Torrent) => {
      for (const entry of entries) {
        // The user cancelled while the add was running. The torrent stays in the client, and the entry stays cancelled.
        if (entry.branch === 'cancelled') {
          queue.move(entry, {}, 'torrent added before the cancel', 'The torrent stays in the client.');
          continue;
        }
        entry.transferHash = found.hash;
        entry.clientId = connection.id;
        if (entry.release) entry.release.infoHash = found.hash;
        catalog.info('download_added', `${connection.config.name} added "${found.name}"`, itemFields(entry), { client: connection.config.name, hash: found.hash, name: found.name });
        queue.move(entry, { stage: 'downloading', branch: null, reason: null }, 'client accepted', found.name);
      }
    };
    // A torrent in the client that ladarr did not add is the user's. ladarr does not take it over.
    const owned = (found: Torrent) => addedByApp(found.hash);
    const unowned = () => {
      for (const entry of entries) {
        catalog.warn('download_exists', `The torrent is already in ${connection.config.name} and belongs to the user`, itemFields(entry), { client: connection.config.name, hash: entry.transferHash ?? ref.infoHash });
        queue.move(entry, { reason: { code: 'torrent_exists' } }, 'torrent is in the client already');
      }
    };

    // A hash from an earlier try: if the client has the torrent, the work is done.
    let hash = ref.infoHash;
    if (hash) {
      const found = await api.find(hash);
      if (found) return owned(found) ? adopt(found) : unowned();
    }

    let source: { torrent: Buffer } | { magnet: string };
    if (ref.link) {
      const indexer = db.data.indexers[ref.indexerId] ?? downloaderOf(ref.link);
      if (!indexer) {
        for (const entry of entries) queue.move(entry, { reason: { code: 'no_indexers' } }, 'no indexer for the release');
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
          const missing = missingFromPack(entries, got.torrent);
          if (missing.length) finder.fallback(missing, 'pack_missing_episodes');
          entries = entries.filter((entry) => !missing.includes(entry));
          if (!entries.length) return;
        }
      }
    } else if (ref.magnet) source = { magnet: ref.magnet };
    else return finder.fallback(entries, 'no_download_link');
    if ('magnet' in source) {
      hash = magnetHash(source.magnet) ?? null;
      if (!hash) return finder.fallback(entries, 'invalid_magnet');
    } else {
      // The comment can only come from the file of the release. A magnet has no file to read.
      const comment = torrentComment(source.torrent);
      for (const entry of entries) if (entry.release) entry.release.comment = comment;
    }

    // The hash is saved before the add. After a crash, the entry still knows which torrent to look for.
    for (const entry of entries) {
      entry.transferHash = hash;
      entry.clientId = connection.id;
      if (entry.release) entry.release.infoHash = hash;
    }
    await save();

    const existing = await api.find(hash!);
    if (existing) return owned(existing) ? adopt(existing) : unowned();

    // The request to the client is the sending step. The fetch of the release ended before this line.
    for (const entry of entries) queue.move(entry, { stage: 'sending', branch: null, reason: null }, 'sending to the client', ref.title);
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
      await api.add(source, ref.seed);
    } catch (error) {
      if (!(error instanceof ClientError)) throw error;
      // The add may have worked even if the answer did not come. Read the client before any other try.
      for (let i = 0; i < 3; i++) {
        await sleep(reconcileMs);
        const found = await api.find(hash!).catch(() => undefined);
        if (found) return owned(found) ? adopt(found) : unowned();
        if (found === null) break;
      }
      throw new JobError(error.code === 'unreachable' ? 'uncertain' : 'outage', error.message);
    }
    // The client answers the add before it lists the torrent, so the reader waits for the list.
    for (let i = 0; i < 3; i++) {
      if (i) await sleep(reconcileMs);
      const added = await api.find(hash!);
      if (added) return adopt(added);
    }
    throw new JobError('uncertain', 'The client accepted the torrent but does not list it.');
  }

  return grab;
}
