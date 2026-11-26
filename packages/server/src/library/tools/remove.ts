import { lstat, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { db } from '../../core/db.ts';
import { deleteItemLog } from '../../core/log.ts';
import { inside } from '../imports/folder-files.ts';
import { forgetUnusedSource, isActive, itemFor, itemId, ownsUpload, phaseOfEntry } from '../downloads/queue.ts';
import type { Data, Job, MediaFile, Queue, QueueEntry, Retired, Seen, Title } from '../../types.ts';

// Keep a torrent if an entry or a file outside the removal still uses it.
export function torrentsForRemoval(removed: QueueEntry[], remaining: QueueEntry[], files: MediaFile[] = [], keptFiles: MediaFile[] = [], items: Data['queueItems'] = {}) {
  const used = new Set(remaining.map((entry) => `${entry.clientId}\n${entry.transferHash}`));
  for (const file of keptFiles) if (file.download) used.add(`${file.download.clientId}\n${file.download.hash}`);
  const refs: { clientId: string; hash: string }[] = [];
  const add = (clientId: string | null, hash: string | null) => {
    if (!clientId || !hash) return;
    const id = `${clientId}\n${hash}`;
    if (used.has(id)) return;
    used.add(id);
    refs.push({ clientId, hash });
  };
  for (const entry of removed) {
    const selection = entry.transferHash && items[itemId(entry.titleKey, entry.season)]?.selected[entry.transferHash];
    if (selection && selection.status !== 'accepted') continue;
    // An upload has a hash and a client even before the client has the torrent.
    if (entry.release?.uploadPath && !ownsUpload(entry) && !['downloading', 'importing', 'available'].includes(phaseOfEntry(entry))) continue;
    add(entry.clientId, entry.transferHash);
  }
  for (const file of files) if (file.download) add(file.download.clientId, file.download.hash);
  return refs;
}

export function dropTargets(entries: QueueEntry[]) {
  const ids = new Set(entries.map((entry) => entry.id));
  const sources = new Set<string>();
  for (const item of new Set(entries.map(itemFor))) {
    if (!item) continue;
    item.entryIds = item.entryIds.filter((id) => !ids.has(id));
    for (const id of Object.keys(item.emptySearches)) if (ids.has(id)) delete item.emptySearches[id];
    for (const torrent of Object.values(item.selected)) {
      const members = Object.keys(torrent.matches);
      for (const id of members) if (ids.has(id)) delete torrent.matches[id];
      if (!item.entryIds.length || (members.length > 0 && !Object.keys(torrent.matches).length)) {
        delete item.selected[torrent.hash];
        sources.add(torrent.hash);
      }
    }
    if (!item.entryIds.length) delete db.data.queueItems[item.id];
    else item.revision = ++db.data.queueRev;
  }
  for (const entry of entries) {
    const hash = entry.transferHash ?? entry.release?.infoHash;
    if (entry.source && hash) sources.add(hash);
    delete db.data.queue[entry.id];
    deleteItemLog(entry.id);
  }
  for (const hash of sources) forgetUnusedSource(hash);
}

// Removes the title, its file records, its targets, their logs, and its jobs. The files on the disk stay where they are.
// `cancelJob` stops a job that runs now. Without it, the record goes and a running handler ends at its next check.
// The caller saves the database.
export function dropTitle(key: string, queue?: Queue, cancelJob?: (id: string) => void) {
  const entries = Object.values(db.data.queue).filter((entry) => entry.titleKey === key);
  const ids = new Set(entries.map((entry) => entry.id));
  // A search of a series holds the title key, and the jobs of one target hold its ID. The dedupe key also finds a
  // job whose target is gone already.
  const own = (job: Job) => {
    const payload = job.payload as { key?: unknown; titleKey?: unknown; entryIds?: unknown } | null;
    if (payload?.key === key || payload?.titleKey === key) return true;
    if (Array.isArray(payload?.entryIds) && payload.entryIds.some((id) => typeof id === 'string' && ids.has(id))) return true;
    const dedupe = job.dedupeKey;
    if (!dedupe) return false;
    return dedupe === `initial:${key}` || dedupe === `refresh:${key}` || dedupe === `scan:${key}` || dedupe === `grab:${key}` || dedupe.startsWith(`grab:${key}:`);
  };
  for (const job of Object.values(db.data.jobs)) {
    if (!own(job)) continue;
    if (cancelJob) cancelJob(job.id);
    else delete db.data.jobs[job.id];
  }
  delete db.data.titles[key];
  for (const [id, file] of Object.entries(db.data.files)) if (file.titleKey === key) delete db.data.files[id];
  if (queue) {
    for (const entry of entries) {
      if (entry.attempt === 0 || !isActive(entry)) continue;
      queue.endAttempt(entry, 'cancelled');
      queue.cancel(entry, 'title removed');
    }
  }
  dropTargets(entries);
  // The episodes that the files of a release held are facts of the title, so they go with it.
  for (const [id, held] of Object.entries(db.data.releaseCoverage)) if (held.titleKey === key) delete db.data.releaseCoverage[id];
  // The file of the title holds the lines of its targets, so it goes with the title.
  deleteItemLog(key);
}

export function inSeason(episode: { season: number | null; number: number | null }, season: number, points?: Set<string>) {
  return points ? points.has(`${episode.season}x${episode.number}`) : episode.season === season;
}

// Removes one season of a series, its targets, their logs, and its jobs. The title, the other seasons, and the files on
// the disk stay where they are. The caller clears the choices of the episodes and saves the database.
// `cancelJob` stops a job that runs now. Without it, the record goes and a running handler ends at its next check.
export function dropSeason(key: string, season: number, queue?: Queue, cancelJob?: (id: string) => void, points?: Set<string>) {
  const entries = Object.values(db.data.queue).filter((entry) => entry.titleKey === key && inSeason(entry, season, points));
  const ids = new Set(entries.map((entry) => entry.id));
  // A search of a season holds the title key and the season. The jobs of one target hold its ID.
  const own = (job: Job) => {
    const payload = job.payload as { titleKey?: unknown; season?: unknown; entryIds?: unknown; uploadHash?: unknown } | null;
    if (!points && job.type === 'queue.search' && payload?.titleKey === key && payload.season === season) return true;
    if (Array.isArray(payload?.entryIds) && payload.entryIds.some((id) => ids.has(id))) {
      if (!points && !(job.type === 'queue.send' && payload.uploadHash)) return true;
      const remaining = payload.entryIds.filter((id) => !ids.has(id));
      if (!remaining.length) return true;
      payload.entryIds = remaining;
    }
    return false;
  };
  for (const job of Object.values(db.data.jobs)) {
    if (!own(job)) continue;
    if (cancelJob) cancelJob(job.id);
    else delete db.data.jobs[job.id];
  }
  if (queue) {
    for (const entry of entries) {
      if (entry.attempt === 0 || !isActive(entry)) continue;
      queue.endAttempt(entry, 'cancelled');
      queue.cancel(entry, 'season removed');
    }
  }
  dropTargets(entries);
  // The episodes that the files of a release of this season held go with the season.
  for (const [id, held] of Object.entries(db.data.releaseCoverage)) {
    if (held.titleKey !== key) continue;
    if (!points) {
      if (held.season === season) delete db.data.releaseCoverage[id];
    } else {
      const remaining = held.numbers.filter((number) => !inSeason({ season: held.season, number }, season, points));
      if (remaining.length === held.numbers.length) continue;
      if (remaining.length) held.numbers = remaining;
      else delete db.data.releaseCoverage[id];
    }
  }
}

// Counts the file records that a deletion removed, for each title. A scan that began before a deletion must not record what it read.
const versions = new Map<string, number>();
export const filesVersion = (key: string) => versions.get(key) ?? 0;

// Removes a file record and every link to it. The title keeps its other files, and a present file takes the primary place.
export function forgetFile(title: Title, fileId: string) {
  versions.set(title.key, filesVersion(title.key) + 1);
  delete db.data.files[fileId];
  const present = Object.values(db.data.files).filter((file) => file.titleKey === title.key && !file.missing);
  if (title.fileId === fileId) title.fileId = present[0]?.id ?? null;
  for (const episode of title.episodes) {
    if (episode.fileId !== fileId) continue;
    const file = present.find((item) => item.episodes.some((entry) => entry.season === episode.season && entry.number === episode.number));
    episode.fileId = file?.id ?? null;
  }
}

const errno = (error: unknown) => (error as NodeJS.ErrnoException).code;

// Looks at a file without following a link. The folder of the file must stay inside the root, also after links are resolved.
// A file that is not there gives `seen: null`. A file that ladarr cannot look at gives a reason.
export async function seeFile(rootReal: string, rel: string): Promise<{ abs: string; seen: Seen } | { reason: 'outside_root' | 'not_a_file' | 'unreadable' }> {
  const wanted = join(rootReal, rel);
  if (!inside(rootReal, wanted) || wanted === rootReal) return { reason: 'outside_root' };
  let parent: string;
  try {
    parent = await realpath(dirname(wanted));
  } catch (error) {
    return errno(error) === 'ENOENT' || errno(error) === 'ENOTDIR' ? { abs: wanted, seen: null } : { reason: 'unreadable' };
  }
  if (!inside(rootReal, parent)) return { reason: 'outside_root' };
  const abs = join(parent, basename(wanted));
  try {
    const info = await lstat(abs);
    if (!info.isFile() && !info.isSymbolicLink()) return { reason: 'not_a_file' };
    return { abs, seen: { sizeBytes: info.size, mtimeMs: info.mtimeMs } };
  } catch (error) {
    return errno(error) === 'ENOENT' ? { abs, seen: null } : { reason: 'unreadable' };
  }
}

export const sameSeen = (a: Seen, b: Seen) => (a === null || b === null ? a === b : a.sizeBytes === b.sizeBytes && a.mtimeMs === b.mtimeMs);

// Deletes a file of its root. A file that changed since the preview stays where it is.
export async function retireFile(rootReal: string, rel: string, expected: Seen): Promise<Retired> {
  const found = await seeFile(rootReal, rel);
  if ('reason' in found) return { ok: false, reason: found.reason };
  if (!sameSeen(found.seen, expected)) return { ok: false, reason: 'changed' };
  if (!found.seen) return { ok: true, how: 'gone' };
  try {
    await unlink(found.abs);
  } catch (error) {
    return { ok: false, reason: (error as NodeJS.ErrnoException).code ?? 'delete_failed' };
  }
  return { ok: true, how: 'deleted' };
}

// Removes the empty folders under a title folder, and the title folder too when it is empty. Folders with a file stay.
export async function pruneEmpty(rootReal: string, folder: string) {
  const start = await realpath(join(rootReal, folder)).catch(() => undefined);
  if (!start || start === rootReal || !inside(rootReal, start)) return;
  async function prune(dir: string, depth: number) {
    if (depth < 10) {
      for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (entry.isDirectory()) await prune(join(dir, entry.name), depth + 1);
      }
    }
    // rmdir refuses a folder that has content.
    await rmdir(dir).catch(() => {});
  }
  await prune(start, 0);
}
