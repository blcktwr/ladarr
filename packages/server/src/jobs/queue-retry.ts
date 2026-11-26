import { db } from '../core/db.ts';
import { catalog, itemFields } from '../core/log.ts';
import { withTitleLock } from '../core/title-lock.ts';
import { inspectCoverage } from '../library/coverage.ts';
import { ClientError } from '../library/downloads/qbittorrent.ts';
import { forgetSource, isActive, phaseOfEntry } from '../library/downloads/queue.ts';
import { enqueueUpload, findUpload, uploadHash, uploadOwner } from '../library/downloads/upload.ts';
import { readTitleFolder, scanTitle } from '../library/scan.ts';
import type { ClientHandle, Handler, QueueEntry, QueueRetryDeps, Title } from '../types.ts';

const present = (fileId: string | null) => Boolean(fileId && db.data.files[fileId] && !db.data.files[fileId]!.missing);

// The file of a target in the library, when the library has one.
const fileOf = (title: Title, entry: QueueEntry) =>
  title.mediaType === 'movie' ? title.fileId : (title.episodes.find((episode) => episode.season === entry.season && episode.number === entry.number)?.fileId ?? null);

// A retry of a target that stopped. The phases of the journey run again in order, and each one checks what it needs
// before the target moves: the file in the library, the torrent in the client, the release that the target kept, and
// the search. The target stops at the first phase that resolves it, so a file that is on the disk, or a torrent that
// the client has, is never downloaded again.
export function queueRetryHandler({ queue, finder, clients, enqueue, events }: QueueRetryDeps): Handler {
  async function canResume(entry: QueueEntry, handle: ClientHandle, hash: string) {
    if (entry.number === null || entry.season === null) return true;
    const revision = entry.revision;
    const title = db.data.titles[entry.titleKey];
    if (!title) return false;
    const files = (await handle.api.files(hash)).map((file) => file.name);
    if (queue.get(entry.id) !== entry || entry.revision !== revision || title !== db.data.titles[entry.titleKey]) return false;
    const selected = entry.manualMatch?.file ?? entry.release?.uploadPath;
    const status = selected
      ? files.some((file) => file === selected || file.endsWith(`/${selected}`)) ? 'identified' : 'absent'
      : inspectCoverage(files, title, entry.numbering).status({ season: entry.season, number: entry.number });
    if (status === 'identified') return true;
    queue.block(entry, { code: status === 'absent' ? 'pack_partial' : 'file_unmapped' }, 'the torrent has no matching episode file');
    return false;
  }
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

  async function checkDownload(entry: QueueEntry, revision: number) {
    if (entry.state.kind !== 'blocked' || entry.state.at !== 'downloading' || entry.revision !== revision) return;
    const current = () => db.data.queue[entry.id] === entry && entry.state.kind === 'blocked' && entry.revision === revision;
    const hash = entry.transferHash ?? entry.release?.infoHash;
    const handle = entry.clientId ? clients.get(entry.clientId) : clients.next();
    const wait = () => enqueue({ type: 'queue.retry', payload: { entryIds: [entry.id], checkDownload: true, revisions: { [entry.id]: revision } }, dedupeKey: `check-wait:${entry.id}`, priority: entry.priority !== null });
    if (!hash) return queue.block(entry, { code: 'torrent_missing' }, 'download check');
    if (!handle) {
      wait();
      return;
    }
    let torrent;
    try {
      torrent = await handle.api.find(hash);
    } catch (error) {
      if (!(error instanceof ClientError)) throw error;
      if (current() && clients.get(handle.id) !== handle) wait();
      else if (current()) queue.block(entry, { code: error.code === 'rejected' ? 'client_rejected' : 'client_unreachable' }, 'download check');
      return;
    }
    if (!current()) return;
    if (clients.get(handle.id) !== handle) {
      wait();
      return;
    }
    if (!torrent || torrent.status === 'error') {
      queue.block(entry, { code: torrent ? 'client_error' : 'torrent_missing' }, 'download check');
      return;
    }
    if (!torrent.complete && !(await canResume(entry, handle, hash))) return;
    queue.retryAttempt(entry, 'retry');
    entry.transferHash = hash;
    entry.clientId = handle.id;
    queue.resolve(entry, torrent.complete ? 'importing' : 'downloading', 'download checked');
    if (torrent.complete) enqueue({ type: 'import.run', payload: { hash, manual: true }, dedupeKey: `import:${hash}`, priority: entry.priority !== null });
    else if (torrent.status === 'paused') await handle.api.setPaused(hash, false).catch(() => {});
  }

  function fromRelease(entry: QueueEntry) {
    const release = entry.release;
    if (!release || (!release.link && !release.magnet)) return false;
    const item = queue.itemFor(entry);
    if (item?.state.kind === 'blocked') queue.transitionItem(item, { kind: 'fetching' });
    else if (item?.state.kind === 'queued') {
      queue.transitionItem(item, { kind: 'searching' });
      queue.transitionItem(item, { kind: 'fetching' });
    }
    queue.enter(entry, 'fetching', 'retry: the target has its release', release.title);
    enqueue({ type: 'queue.grab', payload: { entryIds: [entry.id] }, dedupeKey: `grab:${item?.id ?? entry.id}`, runAt: entry.createdAt, priority: entry.priority !== null });
    return true;
  }

  async function fromUpload(entry: QueueEntry, hash: string) {
    if (entry.state.kind !== 'queued') return;
    const release = entry.release!;
    const attempt = entry.attempt;
    const current = () => queue.get(entry.id) === entry && entry.release === release && entry.attempt === attempt && entry.state.kind === 'queued';
    let found;
    try {
      found = await findUpload(clients, hash, entry.clientId);
    } catch (error) {
      if (!(error instanceof ClientError)) throw error;
      if (current()) queue.block(entry, { code: error.code === 'rejected' ? 'client_rejected' : 'client_unreachable' }, 'download check');
      return;
    }
    if (!current()) return;
    const { download, handle } = found;
    if (!handle) return queue.block(entry, { code: 'client_missing' }, 'no download client');
    entry.transferHash = hash;
    entry.clientId = handle.id;
    if (download) {
      const { torrent } = download;
      if (torrent.status === 'error') return queue.block(entry, { code: 'client_error' }, 'download check');
      if (!torrent.complete && !(await canResume(entry, handle, hash))) return;
      release.uploadOwner = uploadOwner(entry.titleKey, hash, handle.id);
      release.external = !release.uploadOwner;
      queue.enter(entry, torrent.complete ? 'importing' : 'downloading', 'retry: the client has the torrent', torrent.name);
      if (torrent.complete) {
        const job = enqueue({ type: 'import.run', payload: { hash, manual: true }, dedupeKey: `import:${hash}`, priority: entry.priority !== null });
        if (job.state === 'waiting') job.payload = { hash, manual: true };
      } else if (torrent.status === 'paused' && !release.external) await handle.api.setPaused(hash, false).catch(() => {});
      return;
    }
    release.uploadOwner = undefined;
    release.external = true;
    if (!db.data.torrents[hash]) return queue.block(entry, { code: 'upload_source_missing' }, 'torrent file is missing');
    entry.source = { torrent: true };
    queue.enter(entry, 'waiting_slot', 'retry: the target has its torrent', release.title);
    enqueueUpload(enqueue, [entry], hash);
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
    const item = queue.itemFor(entry);
    if (item?.state.kind === 'blocked') queue.transitionItem(item, { kind: 'queued' });
    finder.enqueueSearch({ titleKey: entry.titleKey, season: entry.season, entryIds: [entry.id], fresh: true, ...(entry.season === null ? {} : { manual: true }) });
  }

  return {
    // A retry answers a click: it reads the folder and the client, and it ends at the first phase that resolves the
    // target. It runs beside the long work of another title, and it takes no slot of the shared limit, so the retry
    // of one series never waits for the search of another.
    concurrency: 8,
    separate: true,
    maxAttempts: 3,
    canStart: (job) => {
      const { entryIds, checkDownload, revisions } = job.payload as { entryIds: string[]; checkDownload?: boolean; revisions?: Record<string, number> };
      if (!checkDownload) return true;
      return entryIds.every((id) => {
        const entry = queue.get(id);
        if (!entry || entry.state.kind !== 'blocked' || entry.state.at !== 'downloading' || entry.revision !== revisions?.[id]) return true;
        return !(entry.transferHash ?? entry.release?.infoHash) || Boolean(entry.clientId ? clients.get(entry.clientId) : clients.next());
      });
    },
    run: async (job, { signal }) => {
      const { entryIds, checkDownload: check, revisions, uploadHash: expectedHash, uploadAttempt } = job.payload as { entryIds: string[]; checkDownload?: boolean; revisions?: Record<string, number>; uploadHash?: string; uploadAttempt?: number };
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
          if (expectedHash) {
            for (const entry of group) {
              signal.throwIfAborted();
              if (queue.get(entry.id) === entry && uploadHash(entry) === expectedHash && entry.state.kind === 'queued' && entry.attempt === uploadAttempt) {
                if (!(await fromLibrary(entry, title, present(fileOf(title, entry))))) await fromUpload(entry, expectedHash);
              }
            }
            return;
          }
          const scan = await scanTitle(key, clients);
          if (scan.added || scan.updated || scan.missing) events.publish('library.changed', { key });
          const fresh = scan.status === 'ok' || scan.status === 'folder_missing';
          for (const entry of group) {
            signal.throwIfAborted();
            // The user can pause or cancel the target while the retry waits for its title.
            if (!isActive(entry) || entry.state.kind === 'paused' || entry.state.kind === 'blocked') continue;
            if (uploadHash(entry)) continue;
            // A target of an import runs its import checks. Its own job does that, with no limit.
            if (phaseOfEntry(entry) === 'importing') continue;
            if (await fromLibrary(entry, title, fresh)) continue;
            if (fromRelease(entry)) continue;
            fromSearch(entry);
          }
        });
      }
    },
  };
}
