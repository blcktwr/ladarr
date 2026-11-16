import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { EpisodeRef } from '@ladarr/shared/types';
import { db } from '../../core/db.ts';
import { catalog, itemFields } from '../../core/log.ts';
import { recordTorrent } from '../downloads/attach.ts';
import { addedByApp, isActive, phaseOfEntry } from '../downloads/queue.ts';
import { isVideoFile } from '../parse.ts';
import { inside } from '../roots.ts';
import { readTitleFolder } from '../scan.ts';
import type { ClientHandle, Clients, InventoryFile, LocalResult, MediaFile, ParsedEpisodes, Queue, QueueEntry, Selection, Title, Torrent } from '../../types.ts';

// A target that a local import can resolve: it is on its way to a file, and no download owns it.
const eligible = (entry: QueueEntry) =>
  isActive(entry) && entry.state.kind !== 'paused' && !entry.transferHash && ['searching', 'importing'].includes(phaseOfEntry(entry));

const present = (fileId: string | null) => Boolean(fileId && db.data.files[fileId] && !db.data.files[fileId]!.missing);

const episodeOf = (title: Title, entry: QueueEntry) => (entry.season === null ? undefined : title.episodes.find((episode) => episode.season === entry.season && episode.number === entry.number));

// The episodes of the title that a name gives. A name that gives no listed episode maps to nothing, so its file is loose.
function episodesOf(title: Title, parsed: ParsedEpisodes): EpisodeRef[] {
  return parsed.numbers.flatMap((number) => {
    const episode = title.episodes.find((item) => item.season === parsed.season && item.number === number);
    return episode ? [{ season: episode.season, number: episode.number }] : [];
  });
}

// Finds the torrent of the client that holds the files, by the identity of the data. An imported file is a hard link
// of the file of its torrent, so the device and the inode of both are the same. Returns nothing when no torrent holds
// one of the files.
async function findTorrent(clients: Clients, files: { path: string; abs: string }[]): Promise<{ handle: ClientHandle; torrent: Torrent; paths: Set<string> } | undefined> {
  const wanted = new Map<string, string>();
  for (const file of files) {
    const info = await stat(file.abs).catch(() => undefined);
    // A file with one link is not the data of another folder, so no torrent can hold it.
    if (info?.isFile() && info.nlink > 1) wanted.set(`${info.dev}:${info.ino}`, file.path);
  }
  if (!wanted.size) return undefined;
  for (const handle of clients.all()) {
    let list: Torrent[];
    try {
      list = await handle.api.list();
    } catch {
      continue;
    }
    for (const torrent of list) {
      if (!torrent.complete) continue;
      const save = await realpath(torrent.savePath).catch(() => undefined);
      if (!save) continue;
      let listed: { name: string }[];
      try {
        listed = await handle.api.files(torrent.hash);
      } catch {
        continue;
      }
      const paths = new Set<string>();
      for (const item of listed) {
        if (!isVideoFile(item.name)) continue;
        const abs = join(save, item.name);
        if (!inside(save, abs)) continue;
        const info = await stat(abs).catch(() => undefined);
        if (!info?.isFile()) continue;
        const path = wanted.get(`${info.dev}:${info.ino}`);
        if (path) paths.add(path);
      }
      if (paths.size) return { handle, torrent, paths };
    }
  }
}

// Reads the folder of a series before its targets search, and takes the files that are there as their files. A target
// whose file is in the folder never downloads again. A file that names no episode leaves the targets that it could
// cover for the user, because a download would only find the same files.
export async function importLocal({ queue, clients }: { queue: Queue; clients: Clients }, { titleKey, entryIds }: { titleKey: string; entryIds?: string[] }): Promise<LocalResult> {
  const title = db.data.titles[titleKey];
  if (!title || title.mediaType !== 'tv') return { imported: [], blocked: [] };
  const only = entryIds ? new Set(entryIds) : null;
  const entries = Object.values(db.data.queue).filter((entry) => entry.titleKey === titleKey && eligible(entry) && (!only || only.has(entry.id)));
  if (!entries.length) return { imported: [], blocked: [] };

  // The folder is read under the lock of the title, so a scan and a search do not interleave.
  const folder = await readTitleFolder(title, { guessedFolder: true });
  // The root says nothing about the files of the series. A download would put a second copy next to a file that the
  // app cannot see, so the targets wait instead.
  if (folder.status === 'root_unavailable') {
    for (const entry of entries) queue.block(entry, { code: 'root_unavailable' }, 'the root is not available');
    return { imported: [], blocked: entries.map((entry) => entry.id) };
  }
  if (folder.status !== 'ok') return { imported: [], blocked: [] };

  const done = new Set<string>();
  for (const entry of entries) if (present(episodeOf(title, entry)?.fileId ?? null)) done.add(entry.id);

  const picks: Selection[] = [];
  const taken = new Set<string>();
  const loose: InventoryFile[] = [];

  // A match that the user made comes first, also when the name of the file gives no episode.
  for (const entry of entries) {
    const manual = entry.manualMatch;
    if (!manual) continue;
    const file = folder.files.find((item) => item.path === manual.file);
    if (!file || taken.has(file.path)) continue;
    const covers = manual.covers.filter((cover) => title.episodes.some((episode) => episode.season === cover.season && episode.number === cover.number));
    const covered = entries.filter((other) => !done.has(other.id) && covers.some((cover) => cover.season === other.season && cover.number === other.number));
    const list = covered.length ? covered : [entry];
    picks.push({ file, entries: list, episodes: covers.length ? covers : list.map((item) => ({ season: item.season!, number: item.number! })) });
    for (const item of list) done.add(item.id);
    taken.add(file.path);
  }

  for (const file of [...folder.files].sort((a, b) => b.sizeBytes - a.sizeBytes)) {
    if (taken.has(file.path)) continue;
    const episodes = file.parsed ? episodesOf(title, file.parsed) : [];
    // A file that names no episode of the title can not be given to a target. It stays for the choice of the user.
    if (!episodes.length) {
      loose.push(file);
      continue;
    }
    const covered = entries.filter((entry) => !done.has(entry.id) && episodes.some((episode) => episode.season === entry.season && episode.number === entry.number));
    if (!covered.length) continue;
    picks.push({ file, entries: covered, episodes });
    for (const entry of covered) done.add(entry.id);
    taken.add(file.path);
  }

  const left = entries.filter((entry) => !done.has(entry.id));

  // A file that a torrent of the client already holds keeps that torrent as the one of the target.
  const torrent = await findTorrent(clients, picks.map(({ file }) => ({ path: file.path, abs: join(folder.rootReal!, file.path) })));
  // The user can remove the title while the folder and the client are read. A file record must not outlive its title.
  if (db.data.titles[titleKey] !== title) return { imported: [], blocked: [] };
  const associated = new Set(torrent ? picks.filter(({ file }) => torrent.paths.has(file.path)).map(({ file }) => file.path) : []);
  const associatedEntries = picks.filter(({ file }) => associated.has(file.path)).flatMap(({ entries }) => entries).length;
  const external = torrent ? !addedByApp(torrent.torrent.hash) : false;
  const now = Date.now();

  for (const selection of picks) {
    const existing = Object.values(db.data.files).find((file) => file.titleKey === title.key && file.path === selection.file.path);
    const file: MediaFile = existing ?? { id: randomUUID(), titleKey: title.key, path: selection.file.path, sizeBytes: 0, mtimeMs: 0, episodes: [], missing: false, addedAt: now };
    Object.assign(file, { sizeBytes: selection.file.sizeBytes, mtimeMs: selection.file.mtimeMs, episodes: selection.episodes, missing: false });
    db.data.files[file.id] = file;
    title.folder ??= selection.file.path.split('/')[0]!;
    for (const entry of selection.entries) {
      const episode = episodeOf(title, entry);
      if (episode) episode.fileId = file.id;
      if (associated.has(file.path) && torrent) {
        recordTorrent(entry, { handle: torrent.handle, torrent: torrent.torrent, kind: associatedEntries > 1 ? 'pack' : 'single', external });
        file.download = { clientId: torrent.handle.id, hash: torrent.torrent.hash, external };
      }
      if (entry.attempts.at(-1)?.outcome !== 'running') queue.startAttempt(entry, 'imported from the title folder');
      if (phaseOfEntry(entry) !== 'importing') queue.enter(entry, 'importing', 'imported from the title folder');
      entry.importResult = { at: now, ok: true, method: null, path: file.path, validation: 'basic' };
      catalog.info('import_completed', `Import completed: ${file.path}`, itemFields(entry), { path: file.path, method: null, validation: 'basic' });
      queue.endAttempt(entry, 'imported');
      queue.complete(entry, 'imported from the title folder');
    }
  }

  const blocked: string[] = [];
  if (left.length && loose.length) {
    for (const entry of left) {
      catalog.warn('import_blocked', 'Import blocked: file_unmapped', itemFields(entry), { code: 'file_unmapped', files: loose.map((file) => file.path) });
      // The import is the step that found the file, so the target waits there for the user.
      if (phaseOfEntry(entry) !== 'importing') queue.enter(entry, 'importing', 'import blocked');
      queue.endAttempt(entry, 'failed', 'file_unmapped');
      queue.block(entry, { code: 'file_unmapped' }, 'import blocked', 'file_unmapped');
      blocked.push(entry.id);
    }
  }
  return { imported: picks.flatMap(({ entries }) => entries.map((entry) => entry.id)), blocked };
}

// The video files of the folder of a title, in the shape of the choice of a file. The paths are the paths of the
// library records, relative to the root.
export async function titleFiles(title: Title): Promise<{ status: 'ok' | 'root_unavailable' | 'none'; files: { rel: string; sizeBytes: number }[] }> {
  const folder = await readTitleFolder(title, { guessedFolder: true });
  if (folder.status === 'root_unavailable') return { status: 'root_unavailable', files: [] };
  if (folder.status !== 'ok') return { status: 'none', files: [] };
  return { status: 'ok', files: folder.files.map((file) => ({ rel: file.path, sizeBytes: file.sizeBytes })) };
}
