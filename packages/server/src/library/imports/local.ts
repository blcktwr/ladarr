import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { EpisodeRef } from '@ladarr/shared/types';
import { db } from '../../core/db.ts';
import { catalog, itemFields } from '../../core/log.ts';
import { attachTorrent, recordTorrent } from '../downloads/attach.ts';
import { ClientError } from '../downloads/qbittorrent.ts';
import { addedByApp, isActive, phaseOfEntry } from '../downloads/queue.ts';
import { parseRelease, normalizeTitle } from '../grab/release.ts';
import { isVideoFile, releaseEpisodes } from '../parse.ts';
import { inside } from '../roots.ts';
import { readTitleFolder } from '../scan.ts';
import type { ClientHandle, Clients, InventoryFile, LocalResult, MediaFile, ParsedEpisodes, Queue, QueueEntry, Selection, Title, Torrent } from '../../types.ts';

// A target that a local import can resolve: it is on its way to a file, and no download owns it.
const eligible = (entry: QueueEntry) =>
  isActive(entry) && entry.state.kind !== 'paused' && !entry.transferHash && ['searching', 'importing'].includes(phaseOfEntry(entry));

const present = (fileId: string | null) => Boolean(fileId && db.data.files[fileId] && !db.data.files[fileId]!.missing);

const episodeOf = (title: Title, entry: QueueEntry) => (entry.season === null ? undefined : title.episodes.find((episode) => episode.season === entry.season && episode.number === entry.number));

const fileOf = (title: Title, entry: QueueEntry) => (title.mediaType === 'movie' ? title.fileId : (episodeOf(title, entry)?.fileId ?? null));

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
async function findTorrent({ clients }: { clients: Clients }, files: { path: string; abs: string }[]): Promise<{ handle: ClientHandle; torrent: Torrent; paths: Set<string> } | undefined> {
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
      list = await clients.list(handle);
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

// The names that a release of this title can use.
const namesOf = (title: Title) => [title.meta.title, title.meta.originalTitle, ...title.meta.aliases].map((name) => normalizeTitle(name)).filter((name) => name.length >= 3);

// True when the name of the torrent is a release of the target. A movie needs its year when both names have one. A
// series needs the season and the episode of the target, and a pack of its season covers every episode of that season.
function matches(title: Title, entry: QueueEntry, torrent: Torrent) {
  const parsed = parseRelease(torrent.name);
  if (!namesOf(title).includes(normalizeTitle(parsed.title))) return false;
  if (title.mediaType === 'movie') return parsed.year === null || title.meta.year === null || parsed.year === title.meta.year;
  if (parsed.pack && !parsed.part && !parsed.multiSeason && parsed.season === entry.season) return true;
  const found = releaseEpisodes(torrent.name, title.episodes, null, entry.season, title.meta.title);
  return Boolean(found && found.season === entry.season && found.numbers.includes(entry.number!));
}

// A torrent that the client has already and that no target owns. The download stays with the target, also when a
// restart or a lost association left it alone. The client is read once for every target of the title.
async function attachDownloads({ queue, clients }: { queue: Queue; clients: Clients }, title: Title, entries: QueueEntry[]): Promise<{ attached: string[]; blocked: string[] }> {
  const open = entries.filter((entry) => !entry.transferHash);
  if (!open.length) return { attached: [], blocked: [] };
  // A torrent that another target owns stays with that target.
  const claimed = new Set(Object.values(db.data.queue).flatMap((entry) => (entry.transferHash ? [entry.transferHash] : [])));
  const found = new Map<string, { handle: ClientHandle; torrent: Torrent; targets: QueueEntry[] }>();
  for (const handle of clients.all()) {
    let list: Torrent[];
    try {
      list = await clients.list(handle);
    } catch (error) {
      if (!(error instanceof ClientError)) throw error;
      // A client that does not answer is not a client without the download. The search waits instead of a second copy.
      for (const entry of open) queue.block(entry, { code: 'client_unreachable' }, 'the download client did not answer');
      return { attached: [], blocked: open.map((entry) => entry.id) };
    }
    for (const torrent of list) {
      if (claimed.has(torrent.hash)) continue;
      const targets = open.filter((entry) => matches(title, entry, torrent));
      if (!targets.length) continue;
      const item = found.get(torrent.hash) ?? { handle, torrent, targets: [] };
      for (const target of targets) if (!item.targets.includes(target)) item.targets.push(target);
      found.set(torrent.hash, item);
    }
  }
  // One torrent for each target: a complete torrent first, then the one that is further along.
  const chosen = new Map<string, { handle: ClientHandle; torrent: Torrent; targets: QueueEntry[] }>();
  const ordered = [...found.values()].sort((a, b) => Number(b.torrent.complete) - Number(a.torrent.complete) || b.torrent.progress - a.torrent.progress);
  for (const item of ordered) {
    const targets = item.targets.filter((target) => ![...chosen.values()].some((other) => other.targets.includes(target)));
    if (targets.length) chosen.set(item.torrent.hash, { ...item, targets });
  }
  for (const item of chosen.values()) await attachTorrent({ queue }, { handle: item.handle, torrent: item.torrent, targets: item.targets, cause: 'download found in the client' });
  return { attached: [...chosen.values()].flatMap((item) => item.targets.map((target) => target.id)), blocked: [] };
}

// Reads the folder of a title before its targets search, and takes the files that are there as their files. A target
// whose file is in the folder never downloads again. Then a download that the client has already becomes the download
// of its target, so a lost association does not cause a second copy. A file that names no episode leaves the targets
// that it could cover for the user, because a download would only find the same files.
export async function importLocal({ queue, clients }: { queue: Queue; clients: Clients }, { titleKey, entryIds }: { titleKey: string; entryIds?: string[] }): Promise<LocalResult> {
  const title = db.data.titles[titleKey];
  if (!title) return { imported: [], blocked: [] };
  const only = entryIds ? new Set(entryIds) : null;
  const entries = Object.values(db.data.queue).filter((entry) => entry.titleKey === titleKey && eligible(entry) && (!only || only.has(entry.id)));
  if (!entries.length) return { imported: [], blocked: [] };

  const imported: string[] = [];
  const done = new Set<string>();

  // A file that the library records already is the file of the target. The target is done.
  for (const entry of entries) {
    const fileId = fileOf(title, entry);
    if (!present(fileId)) continue;
    const file = db.data.files[fileId!]!;
    done.add(entry.id);
    imported.push(entry.id);
    catalog.info('available', 'The file is in the library', itemFields(entry), { source: 'local', path: file.path, sizeBytes: file.sizeBytes });
    queue.endAttempt(entry, 'imported', 'the file is in the library');
    queue.complete(entry, 'file is in the library', file.path);
  }

  // The folder is read under the lock of the title, so a scan and a search do not interleave.
  const folder = await readTitleFolder(title, { guessedFolder: true });
  // The root says nothing about the files of the series. A download would put a second copy next to a file that the
  // app cannot see, so the targets wait instead.
  if (folder.status === 'root_unavailable') {
    const left = entries.filter((entry) => !done.has(entry.id));
    for (const entry of left) queue.block(entry, { code: 'root_unavailable' }, 'the root is not available');
    return { imported, blocked: left.map((entry) => entry.id) };
  }

  const picks: Selection[] = [];
  const taken = new Set<string>();
  const loose: InventoryFile[] = [];
  const open = entries.filter((entry) => !done.has(entry.id));

  if (folder.status === 'ok') {
    if (title.mediaType === 'movie') {
      // A movie has one file, so the largest video of its folder is its file. A choice of the user comes first.
      for (const entry of open) {
        const manual = entry.manualMatch ? folder.files.find((item) => item.path === entry.manualMatch!.file) : undefined;
        const file = manual ?? [...folder.files].sort((a, b) => b.sizeBytes - a.sizeBytes)[0];
        if (!file) continue;
        picks.push({ file, entries: [entry], episodes: [] });
        taken.add(file.path);
      }
    } else {
      // A match that the user made comes first, also when the name of the file gives no episode.
      for (const entry of open) {
        const manual = entry.manualMatch;
        if (!manual) continue;
        const file = folder.files.find((item) => item.path === manual.file);
        if (!file || taken.has(file.path)) continue;
        const covers = manual.covers.filter((cover) => title.episodes.some((episode) => episode.season === cover.season && episode.number === cover.number));
        const covered = open.filter((other) => !done.has(other.id) && covers.some((cover) => cover.season === other.season && cover.number === other.number));
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
        const covered = open.filter((entry) => !done.has(entry.id) && episodes.some((episode) => episode.season === entry.season && episode.number === entry.number));
        if (!covered.length) continue;
        picks.push({ file, entries: covered, episodes });
        for (const entry of covered) done.add(entry.id);
        taken.add(file.path);
      }
    }
  }

  // A file that a torrent of the client already holds keeps that torrent as the one of the target.
  const torrent = folder.status === 'ok' ? await findTorrent({ clients }, picks.map(({ file }) => ({ path: file.path, abs: join(folder.rootReal!, file.path) }))) : undefined;
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
      if (title.mediaType === 'movie') title.fileId = file.id;
      else {
        const episode = episodeOf(title, entry);
        if (episode) episode.fileId = file.id;
      }
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
      imported.push(entry.id);
    }
  }

  // The client can have the download of a target that the folder does not cover.
  const left = open.filter((entry) => !done.has(entry.id) && !picks.some((selection) => selection.entries.includes(entry)));
  const downloads = await attachDownloads({ queue, clients }, title, left);

  // A file that names no episode of a series leaves its targets for the user. The download of the same files would find
  // the same problem, so the target waits in the import instead of downloading a second copy.
  const blocked: string[] = [...downloads.blocked];
  const waiting = left.filter((entry) => !downloads.attached.includes(entry.id));
  if (title.mediaType === 'tv' && waiting.length && loose.length) {
    for (const entry of waiting) {
      catalog.warn('import_blocked', 'Import blocked: file_unmapped', itemFields(entry), { code: 'file_unmapped', files: loose.map((file) => file.path) });
      // The import is the step that found the file, so the target waits there for the user.
      if (phaseOfEntry(entry) !== 'importing') queue.enter(entry, 'importing', 'import blocked');
      queue.endAttempt(entry, 'failed', 'file_unmapped');
      queue.block(entry, { code: 'file_unmapped' }, 'import blocked', 'file_unmapped');
      blocked.push(entry.id);
    }
  }
  return { imported: [...imported, ...downloads.attached], blocked };
}

// The video files of the folder of a title, in the shape of the choice of a file. The paths are the paths of the
// library records, relative to the root.
export async function titleFiles(title: Title): Promise<{ status: 'ok' | 'root_unavailable' | 'none'; files: { rel: string; sizeBytes: number }[] }> {
  const folder = await readTitleFolder(title, { guessedFolder: true });
  if (folder.status === 'root_unavailable') return { status: 'root_unavailable', files: [] };
  if (folder.status !== 'ok') return { status: 'none', files: [] };
  return { status: 'ok', files: folder.files.map((file) => ({ rel: file.path, sizeBytes: file.sizeBytes })) };
}
