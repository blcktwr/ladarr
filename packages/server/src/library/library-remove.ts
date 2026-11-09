import { lstat, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { Db } from '../core/db.ts';
import type { Job } from '../core/jobs.ts';
import { deleteItemLog } from '../core/log.ts';
import { clearBlocklist } from '../acquisition/blocklist.ts';
import { inside } from './folder-files.ts';
import type { Title } from './library.ts';
import { isActive, type Queue } from '../downloads/queue.ts';

// Removes the title, its file records, its targets, their logs, and its jobs. The files on the disk stay where they are.
// `cancelJob` stops a job that runs now. Without it, the record goes and a running handler ends at its next check.
// The caller saves the database.
export function dropTitle(db: Db, key: string, queue?: Queue, cancelJob?: (id: string) => void) {
  clearBlocklist(db, key);
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
      queue.move(entry, { branch: 'cancelled', reason: null }, 'title removed');
    }
  }
  for (const entry of entries) {
    deleteItemLog(entry.id);
    delete db.data.queue[entry.id];
  }
  // The file of the title holds the lines of its targets, so it goes with the title.
  deleteItemLog(key);
}

// Removes one season of a series, its targets, their logs, and its jobs. The title, the other seasons, and the files on
// the disk stay where they are. The caller clears the choices of the episodes and saves the database.
// `cancelJob` stops a job that runs now. Without it, the record goes and a running handler ends at its next check.
export function dropSeason(db: Db, key: string, season: number, queue?: Queue, cancelJob?: (id: string) => void) {
  clearBlocklist(db, key, season);
  const entries = Object.values(db.data.queue).filter((entry) => entry.titleKey === key && entry.season === season);
  const ids = new Set(entries.map((entry) => entry.id));
  // A search of a season holds the title key and the season. The jobs of one target hold its ID.
  const own = (job: Job) => {
    const payload = job.payload as { titleKey?: unknown; season?: unknown; entryIds?: unknown } | null;
    if (job.type === 'queue.search' && payload?.titleKey === key && payload.season === season) return true;
    if (Array.isArray(payload?.entryIds) && payload.entryIds.some((id) => typeof id === 'string' && ids.has(id))) return true;
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
      queue.move(entry, { branch: 'cancelled', reason: null }, 'season removed');
    }
  }
  for (const entry of entries) {
    deleteItemLog(entry.id);
    delete db.data.queue[entry.id];
  }
}

// Counts the file records that a deletion removed, for each title. A scan that began before a deletion must not record what it read.
const versions = new Map<string, number>();
export const filesVersion = (key: string) => versions.get(key) ?? 0;

// Removes a file record and every link to it. The title keeps its other files.
export function forgetFile(db: Db, title: Title, fileId: string) {
  versions.set(title.key, filesVersion(title.key) + 1);
  delete db.data.files[fileId];
  if (title.fileId === fileId) title.fileId = null;
  for (const episode of title.episodes) if (episode.fileId === fileId) episode.fileId = null;
}

// What the preview saw on the disk. Null: the file was not there.
export type Seen = { sizeBytes: number; mtimeMs: number } | null;

export type Retired = { ok: true; how: 'deleted' | 'gone' } | { ok: false; reason: string };

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
