import { realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { db } from '../../core/db.ts';
import { inside, sameIdentity } from '../roots.ts';
import type { MediaFile, Queue, QueueEntry } from '../../types.ts';

export function pendingFile(entry: QueueEntry) {
  if (entry.state.kind !== 'queued' && entry.state.kind !== 'waiting' && entry.state.kind !== 'searching') return;
  if (entry.season === null || entry.replaceDestination || entry.attempts.at(-1)?.reason === 'upgrade search') return;
  const title = db.data.titles[entry.titleKey];
  const episode = title?.episodes.find((one) => one.season === entry.season && one.number === entry.number);
  const file = episode?.fileId ? db.data.files[episode.fileId] : undefined;
  if (!file || file.missing || file.sizeBytes <= 0 || file.titleKey !== entry.titleKey) return;
  const covers = (one: MediaFile['episodes'][number]) => one.season === entry.season && one.number === entry.number;
  if (!file.episodes.some(covers)) return;
  if (entry.manualMatch && (file.association?.originalName !== entry.manualMatch.file || !entry.manualMatch.covers.some(covers))) return;
  // A different release can replace the file. Its target stays in the queue.
  if ((entry.release || entry.transferHash) && (!file.download || file.download.hash !== (entry.transferHash ?? entry.release?.infoHash)
    || (entry.clientId && file.download.clientId !== entry.clientId))) return;
  return file;
}

async function unchanged(file: MediaFile) {
  const rootOf = () => db.data.roots[db.data.titles[file.titleKey]?.rootId ?? ''];
  const root = rootOf();
  const path = file.path;
  const identity = file.association?.identity;
  if (!root || !identity) return false;
  const { path: rootPath, dev } = root;
  const base = await realpath(rootPath).catch(() => undefined);
  if (!base || (await stat(base).catch(() => undefined))?.dev !== dev) return false;
  const target = await realpath(join(base, path)).catch(() => undefined);
  if (!target || !inside(base, target)) return false;
  const info = await stat(target).catch(() => undefined);
  return info?.isFile() && info.size > 0 && sameIdentity(identity, info) && file.association?.identity === identity
    && file.path === path && rootOf()?.path === rootPath && rootOf()?.dev === dev;
}

// A successful scan supplies current file records. The periodic sweep reads each candidate file from disk.
export async function reconcile(queue: Queue, scannedKey?: string) {
  const groups = new Map<MediaFile, QueueEntry[]>();
  for (const entry of Object.values(db.data.queue)) {
    if (scannedKey !== undefined && entry.titleKey !== scannedKey) continue;
    const file = pendingFile(entry);
    if (!file?.association) continue;
    const entries = groups.get(file);
    if (entries) entries.push(entry);
    else groups.set(file, [entry]);
  }
  for (const [file, entries] of groups) {
    if (scannedKey === undefined && !(await unchanged(file))) continue;
    if (Object.values(db.data.imports).some((journal) => journal.titleKey === file.titleKey && journal.steps.some((step) => step.dest === file.path))) continue;
    for (const entry of entries) {
      if (queue.get(entry.id) !== entry || pendingFile(entry) !== file) continue;
      queue.endAttempt(entry, 'imported', 'the file is in the library');
      queue.complete(entry, 'file is in the library', file.path);
    }
  }
}
