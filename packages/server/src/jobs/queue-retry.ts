import { db } from '../core/db.ts';
import { catalog, itemFields } from '../core/log.ts';
import { withTitleLock } from '../core/title-lock.ts';
import { ClientError } from '../library/downloads/qbittorrent.ts';
import { isActive, phaseOfEntry } from '../library/downloads/queue.ts';
import { scanTitle } from '../library/scan.ts';
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
    if (!scan || !present(id)) return false;
    const file = db.data.files[id!]!;
    catalog.info('available', 'The file is in the library', itemFields(entry), { source: 'retry', path: file.path, sizeBytes: file.sizeBytes });
    queue.endAttempt(entry, 'imported', 'the file is in the library');
    queue.complete(entry, 'file is in the library', file.path);
    return true;
  }

  // True while the target is in a retry that the user asked for, so several targets that the user retried together stay
  // one group. A target that waits on its own is not part of the retry of another one.
  const retrying = (entry: QueueEntry) => {
    const attempt = entry.attempts.at(-1);
    return attempt?.outcome === 'running' && attempt.reason === 'retry';
  };

  // The active targets that the same torrent imports. A torrent covers every target that points at it, so a retry of
  // one of them resolves them together: the import reads them as one group, and a file that holds two episodes stays
  // one file. A target that the user paused, or that the user did not retry, stays out.
  const torrentTargets = (entry: QueueEntry, hash: string) =>
    Object.values(db.data.queue).filter((other) => other.titleKey === entry.titleKey && isActive(other) && other.state.kind !== 'paused' && retrying(other) && (other.transferHash === hash || other.release?.infoHash === hash));

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
    const targets = torrentTargets(entry, hash);
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
    entry.transferHash = null;
    entry.clientId = null;
    entry.source = null;
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
      const { entryIds } = job.payload as { entryIds: string[] };
      const entries = entryIds.map((id) => queue.get(id)).filter((entry): entry is QueueEntry => Boolean(entry));
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
            if (!isActive(entry) || entry.state.kind === 'paused') continue;
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
