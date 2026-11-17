import { db } from '../core/db.ts';
import { catalog, itemFields } from '../core/log.ts';
import { withTitleLock } from '../core/title-lock.ts';
import { ClientError } from '../library/downloads/qbittorrent.ts';
import { forgetSource, isActive, phaseOfEntry } from '../library/downloads/queue.ts';
import { readTitleFolder, scanTitle } from '../library/scan.ts';
import type { Handler, QueueEntry, QueueRetryDeps, Title } from '../types.ts';

const present = (fileId: string | null) => Boolean(fileId && db.data.files[fileId] && !db.data.files[fileId]!.missing);

// The file of a target in the library, when the library has one.
const fileOf = (title: Title, entry: QueueEntry) =>
  title.mediaType === 'movie' ? title.fileId : (title.episodes.find((episode) => episode.season === entry.season && episode.number === entry.number)?.fileId ?? null);

// A retry of a target that stopped. The phases of the journey run again in order, and each one checks what it needs
// before the target moves: the file in the library, the torrent in the client, the release that the target kept, and
// the search. The target stops at the first phase that resolves it, so a file that is on the disk, or a torrent that
// the client has, is never downloaded again.
export function queueRetryHandler({ queue, finder, clients, enqueue, events }: QueueRetryDeps): Handler {
  // The file that the library holds for the target. The folder of the title is read from the disk, so a file that is
  // there counts also when no scan recorded it yet. A retry that replaces a file is not a retry of the library.
  async function fromLibrary(entry: QueueEntry, title: Title, scan: boolean) {
    if (entry.replaceDestination) return false;
    const id = fileOf(title, entry);
    if (!scan) return false;
    if (!present(id)) {
      const folder = await readTitleFolder(title, { guessedFolder: true });
      if (entry.state.kind === 'blocked' || entry.state.kind === 'paused' || !isActive(entry)) return true;
      const empty = folder.files.some((file) => file.sizeBytes === 0 && (title.mediaType === 'movie' || (file.parsed?.season === entry.season && file.parsed.numbers.includes(entry.number!))));
      if (!empty) return false;
      queue.enter(entry, 'importing', 'retry: validate the library file');
      queue.block(entry, { code: 'file_unreadable', detail: 'empty' }, 'import blocked');
      return true;
    }
    const file = db.data.files[id!]!;
    queue.enter(entry, 'importing', 'retry: validate the library file');
    if (file.titleKey !== title.key) {
      queue.block(entry, { code: 'file_unmapped' }, 'import blocked');
      return true;
    }
    if (file.sizeBytes <= 0) {
      queue.block(entry, { code: 'file_unreadable', detail: 'empty' }, 'import blocked');
      return true;
    }
    if (entry.season !== null && !file.episodes.some((episode) => episode.season === entry.season && episode.number === entry.number)) {
      queue.block(entry, { code: 'file_unmapped' }, 'import blocked');
      return true;
    }
    catalog.info('available', 'The file is in the library', itemFields(entry), { source: 'retry', path: file.path, sizeBytes: file.sizeBytes });
    queue.endAttempt(entry, 'imported', 'the file is in the library');
    queue.complete(entry, 'file is in the library', file.path);
    return true;
  }

  // The torrent that the target points at. The client that has it is read first, so a finished torrent goes to its
  // import and a torrent that still downloads is waited for. The release is never fetched again in this case.
  async function fromClient(entry: QueueEntry) {
    const hash = entry.transferHash ?? entry.release?.infoHash ?? null;
    if (!hash) return false;
    const handle = clients.get(entry.clientId) ?? clients.next();
    if (!handle) return false;
    let torrent;
    try {
      torrent = await handle.api.find(hash);
    } catch (error) {
      // A client that does not answer is a problem of the next phase too, and it is not a torrent that is gone.
      if (error instanceof ClientError) return false;
      throw error;
    }
    if (!torrent) return false;
    const fields = { client: handle.config.name, hash, name: torrent.name, complete: torrent.complete, progress: torrent.progress };
    const targets = [entry];
    for (const target of targets) {
      target.transferHash = hash;
      target.clientId = handle.id;
      if (target.release) target.release.infoHash = hash;
      if (torrent.complete) {
        catalog.info('download_found', `The download client has "${torrent.name}". The import runs again.`, itemFields(target), fields);
        queue.enter(target, 'importing', 'retry: the client has the torrent', torrent.name);
      } else {
        catalog.info('download_found', `The download client has "${torrent.name}" and it is not complete. The target waits for it.`, itemFields(target), fields);
        queue.enter(target, 'downloading', 'retry: the client has the torrent', torrent.name);
      }
    }
    if (targets.length && torrent.complete) {
      enqueue({ type: 'import.run', payload: { hash, manual: true }, dedupeKey: `import:${hash}`, priority: entry.priority !== null });
    } else if (targets.length && torrent.status === 'paused') {
      // A torrent that the client stopped does not download. The retry resumes it, as the attach does.
      await handle.api.setPaused(hash, false).catch(() => {});
    }
    return true;
  }

  async function checkDownload(entry: QueueEntry, revision: number) {
    if (entry.state.kind !== 'blocked' || entry.state.at !== 'downloading' || entry.revision !== revision) return;
    const current = () => db.data.queue[entry.id] === entry && entry.state.kind === 'blocked' && entry.revision === revision;
    const hash = entry.transferHash ?? entry.release?.infoHash;
    const handle = clients.get(entry.clientId) ?? clients.next();
    if (!handle || !hash) {
      queue.block(entry, { code: !handle ? 'client_missing' : 'torrent_missing' }, 'download check');
      return;
    }
    let torrent;
    try {
      torrent = await handle.api.find(hash);
    } catch (error) {
      if (!(error instanceof ClientError)) throw error;
      if (current()) queue.block(entry, { code: error.code === 'rejected' ? 'client_rejected' : 'client_unreachable' }, 'download check');
      return;
    }
    if (!current()) return;
    if (!torrent || torrent.status === 'error') {
      queue.block(entry, { code: torrent ? 'client_error' : 'torrent_missing' }, 'download check');
      return;
    }
    queue.retryAttempt(entry, 'retry');
    entry.transferHash = hash;
    entry.clientId = handle.id;
    queue.resolve(entry, torrent.complete ? 'importing' : 'downloading', 'download checked');
    if (torrent.complete) enqueue({ type: 'import.run', payload: { hash, manual: true }, dedupeKey: `import:${hash}`, priority: entry.priority !== null });
    else if (torrent.status === 'paused') await handle.api.setPaused(hash, false).catch(() => {});
  }

  // The release that the target kept. The grab reads the client first, so a torrent that it has is used as it is. A
  // fetched torrent stays in the target, so it goes to the wait for a slot without a second request to the indexer.
  function fromRelease(entry: QueueEntry) {
    const release = entry.release;
    if (!release || (!release.link && !release.magnet)) return false;
    if (entry.source) {
      catalog.info('release_kept', `The fetched torrent of "${release.title}" stays with the target. It waits for a slot.`, itemFields(entry), { release: release.title, indexer: release.indexerName, kind: release.kind });
      queue.enter(entry, 'waiting_slot', 'retry: the target has its torrent', release.title);
      enqueue({ type: 'queue.send', payload: { entryIds: [entry.id] }, dedupeKey: `send:${entry.id}`, runAt: entry.createdAt, priority: entry.priority !== null });
      return true;
    }
    catalog.info('release_kept', `The release "${release.title}" stays with the target. It goes to the client again.`, itemFields(entry), { release: release.title, indexer: release.indexerName, kind: release.kind });
    queue.enter(entry, 'fetching', 'retry: the target has its release', release.title);
    enqueue({ type: 'queue.grab', payload: { entryIds: [entry.id] }, dedupeKey: `grab:${entry.id}`, runAt: entry.createdAt, priority: entry.priority !== null });
    return true;
  }

  // No phase resolved the target, so it searches. Nothing is kept: the release that failed is gone, and the target
  // starts again from the top of the journey.
  function fromSearch(entry: QueueEntry) {
    entry.release = null;
    // The copy of the torrent goes with the hash that it belongs to.
    forgetSource(entry);
    entry.transferHash = null;
    entry.clientId = null;
    entry.importTries = 0;
    entry.search = null;
    queue.enter(entry, 'queued', 'retry');
    finder.enqueueSearch({ titleKey: entry.titleKey, season: entry.season, entryIds: [entry.id], fresh: true, ...(entry.season === null ? {} : { manual: true }) });
  }

  return {
    // A retry answers a click: it reads the folder and the client, and it ends at the first phase that resolves the
    // target. It runs beside the long work of another title, and it takes no slot of the shared limit, so the retry
    // of one series never waits for the search of another.
    concurrency: 8,
    separate: true,
    maxAttempts: 3,
    run: async (job, { signal }) => {
      const { entryIds, checkDownload: check, revisions } = job.payload as { entryIds: string[]; checkDownload?: boolean; revisions?: Record<string, number> };
      const entries = entryIds.map((id) => queue.get(id)).filter((entry): entry is QueueEntry => Boolean(entry));
      if (check) {
        for (const entry of entries) {
          signal.throwIfAborted();
          if (revisions?.[entry.id] !== undefined) await checkDownload(entry, revisions[entry.id]!);
        }
        return;
      }
      const byTitle = new Map<string, QueueEntry[]>();
      for (const entry of entries) byTitle.set(entry.titleKey, [...(byTitle.get(entry.titleKey) ?? []), entry]);
      for (const [key, group] of byTitle) {
        const title = db.data.titles[key];
        if (!title) continue;
        // The folder is read once for the title, and the search and the scan share the lock of the title.
        await withTitleLock(key, async () => {
          const scan = await scanTitle(key);
          if (scan.added || scan.updated || scan.missing) events.publish('library.changed', { key });
          const fresh = scan.status === 'ok' || scan.status === 'folder_missing';
          for (const entry of group) {
            signal.throwIfAborted();
            // The user can pause or cancel the target while the retry waits for its title.
            if (!isActive(entry) || entry.state.kind === 'paused' || entry.state.kind === 'blocked') continue;
            // A target of an import runs its import checks. Its own job does that, with no limit.
            if (phaseOfEntry(entry) === 'importing') continue;
            if (await fromLibrary(entry, title, fresh)) continue;
            if (await fromClient(entry)) continue;
            if (fromRelease(entry)) continue;
            fromSearch(entry);
          }
        });
      }
    },
  };
}
