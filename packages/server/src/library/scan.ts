import { randomUUID } from 'node:crypto';
import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';
import { db } from '../core/db.ts';
import { filesVersion } from './tools/remove.ts';
import { folderName } from './naming.ts';
import { inspectCoverage } from './coverage.ts';
import { libraryVersion } from './mapping.ts';
import { normalizeTitle, parseRelease } from './grab/release.ts';
import { isSample, isVideoFile, releaseEpisodes } from './parse.ts';
import { checkRoot, sameIdentity } from './roots.ts';
import { createClients } from './downloads/client-api.ts';
import { torrentVideos } from './imports/importer.ts';
import type { ClientHandle, Clients, Db, FolderInventory, InventoryFile, MediaFile, QueueEntry, ScanFound, ScanResult, Title, Torrent } from '../types.ts';

export const scanJob = (key: string) => ({ type: 'library.scan', payload: { key }, dedupeKey: `scan:${key}` });

const MAX_DEPTH = 6;
// shortcut: a folder with more video files than this is cut short. Raise it if a real title needs more.
const MAX_FILES = 5_000;
// These problems mean that the root cannot be trusted now. A scan then records nothing.
const UNTRUSTED = ['not_found', 'not_directory', 'not_readable', 'mount_changed'];
const scanClients = createClients();

const empty = (status: ScanResult['status']): ScanResult => ({ status, added: 0, updated: 0, missing: 0, unmatched: [], duplicates: [], unknownEpisodes: [], extraFiles: [] });
const inventory = (status: FolderInventory['status']): FolderInventory => ({ status, rootReal: null, files: [] });
const inside = (parent: string, child: string) => {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep));
};

// Lists the video files under a folder. It does not follow a link to a folder, and it ignores a file that links outside the root.
async function findVideos(folder: string, rootReal: string): Promise<ScanFound[]> {
  const found: ScanFound[] = [];
  async function walk(dir: string, depth: number) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (found.length >= MAX_FILES) return;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH) await walk(path, depth + 1);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        if (!isVideoFile(entry.name) || isSample(relative(folder, path))) continue;
        if (entry.isSymbolicLink()) {
          const target = await realpath(path).catch(() => undefined);
          if (!target || !inside(rootReal, target)) continue;
        }
        const info = await stat(path).catch(() => undefined);
        if (info?.isFile()) found.push({ path: relative(rootReal, path).split(sep).join('/'), sizeBytes: info.size, mtimeMs: info.mtimeMs, dev: info.dev, ino: info.ino, nlink: info.nlink });
      }
    }
  }
  await walk(folder, 0);
  return found;
}

// Reads the folder of a title and parses the names of its files. It writes nothing, so a search can read the folder
// before it asks the indexers. `guessedFolder` uses the name that a new folder of the title would have, for a title
// that has none yet.
export async function readTitleFolder(title: Title, { guessedFolder = false }: { guessedFolder?: boolean } = {}): Promise<FolderInventory> {
  const root = db.data.roots[title.rootId];
  const folder = title.folder ?? (guessedFolder ? folderName(title) : null);
  if (!root || !folder) return inventory('no_folder');

  // A root that cannot be trusted says nothing about the files of the title, so nothing reads as missing.
  const health = await checkRoot(root.path, root.dev);
  if (health.problems.some((problem) => UNTRUSTED.includes(problem))) return inventory('root_unavailable');

  const rootReal = await realpath(root.path).catch(() => undefined);
  if (!rootReal) return inventory('root_unavailable');
  const path = join(rootReal, folder);
  const real = await realpath(path).catch(() => undefined);
  // The folder name is data from outside. It must stay inside the root.
  if (!inside(rootReal, path) || (real && !inside(rootReal, real))) return inventory('no_folder');

  const isDirectory = real ? (await stat(real).catch(() => undefined))?.isDirectory() : false;
  if (!isDirectory) return { ...inventory('folder_missing'), rootReal };
  const files = await findVideos(real!, rootReal);
  const ambiguous = new Set(inspectCoverage(files.map((file) => file.path), title, title.numbering).ambiguous);
  return { status: 'ok', rootReal, files: files.map((file) => ({ ...file, parsed: ambiguous.has(file.path) ? undefined : releaseEpisodes(file.path, title.episodes, title.numbering, null, title.meta.title) })) };
}

export async function linkedSources(clients: Clients, files: ScanFound[]) {
  const identity = (f: Pick<ScanFound, 'dev' | 'ino' | 'sizeBytes' | 'mtimeMs'>) => `${f.dev}:${f.ino}:${f.sizeBytes}:${f.mtimeMs}`;
  const linked = files.filter((file) => (file.nlink ?? 0) > 1);
  const wanted = new Set(linked.map(identity));
  const sizes = new Set(linked.map((file) => file.sizeBytes));
  type Source = { handle: ClientHandle; torrent: Torrent; download: NonNullable<MediaFile['download']> & { file: string } };
  const found = new Map<string, Source | null>();
  if (wanted.size) for (const handle of clients.all()) {
    for (const torrent of await clients.list(handle).catch(() => [])) {
      if (!torrent.complete) continue;
      for (const video of await torrentVideos(handle, torrent, sizes).catch(() => undefined) ?? []) {
        const key = identity(video);
        if (wanted.has(key)) found.set(key, found.has(key) ? null : {
          handle, torrent, download: { clientId: handle.id, hash: torrent.hash, name: torrent.name, file: video.rel, external: !db.data.sentTorrents[torrent.hash] },
        });
      }
    }
  }
  return new Map(linked.flatMap((file) => {
    const source = found.get(identity(file));
    return source ? [[file.path, source] as const] : [];
  }));
}

function recordSource(file: MediaFile, download: NonNullable<MediaFile['download']> & { file: string }) {
  if (file.download && (file.download.hash !== download.hash || file.download.clientId !== download.clientId)) return false;
  file.download = { ...download, external: file.download?.external ?? download.external };
  if (file.association) file.association.originalName = download.file;
  return true;
}

export async function recoverMappingSources(title: Title, records: MediaFile[], clients: Clients) {
  const files = [...new Set(records)].filter((file) => !file.download?.name || !file.download.file);
  const root = db.data.roots[title.rootId];
  if (!files.length || !root) return false;
  const version = libraryVersion(title.key);
  const base = await realpath(root.path).catch(() => undefined);
  if (!base || (root.dev !== undefined && (await stat(base).catch(() => undefined))?.dev !== root.dev)) return false;
  const inventory = await Promise.all(files.map(async (file) => {
    const abs = await realpath(join(base, file.path)).catch(() => undefined);
    if (!abs || !inside(base, abs)) return [];
    const info = await stat(abs).catch(() => undefined);
    if (!info?.isFile() || !sameIdentity(file.association?.identity ?? file, info)) return [];
    return [{ path: file.path, sizeBytes: info.size, mtimeMs: info.mtimeMs, dev: info.dev, ino: info.ino, nlink: info.nlink }];
  }));
  const sources = await linkedSources(clients, inventory.flat());
  if (!sources.size || db.data.titles[title.key] !== title || libraryVersion(title.key) !== version) return false;
  let changed = false;
  for (const file of files) {
    const source = sources.get(file.path);
    if (source && db.data.files[file.id] === file && recordSource(file, source.download)) changed = true;
  }
  return changed;
}

async function legacyImports(title: Title, folder: FolderInventory, clients: Clients) {
  const recovered = new Map<string, { episodes: MediaFile['episodes']; association: NonNullable<MediaFile['association']> }>();
  const evidenceOf = (entry: QueueEntry) => ({
    revision: entry.revision, attempt: entry.attempt, state: entry.state.kind,
    titleKey: entry.titleKey, season: entry.season, number: entry.number,
    clientId: entry.clientId, transferHash: entry.transferHash,
    release: entry.release ? { title: entry.release.title, infoHash: entry.release.infoHash } : null,
    importResult: entry.importResult,
    manualMatch: entry.manualMatch, manualMatchRevision: entry.manualMatchRevision,
    numbering: entry.numbering ?? null,
  });
  const snapshots: { entry: QueueEntry; signature: string }[] = [];
  const current = () => snapshots.every(({ entry, signature }) => db.data.queue[entry.id] === entry && JSON.stringify(evidenceOf(entry)) === signature);
  if (title.mediaType !== 'tv' || folder.status !== 'ok') return { recovered, current };
  const files = Object.values(db.data.files).filter((file) => file.titleKey === title.key && file.download && !file.association);
  if (!files.length) return { recovered, current };
  const candidates = Object.values(db.data.queue).filter((entry) =>
    entry.titleKey === title.key && entry.state.kind === 'available' && entry.season !== null && entry.number !== null &&
    entry.release && entry.clientId && entry.transferHash && (!entry.release.infoHash || entry.release.infoHash === entry.transferHash) &&
    entry.importResult?.ok && entry.importResult.method === 'hardlink' &&
    title.episodes.some((episode) => {
      if (episode.season !== entry.season || episode.number !== entry.number) return false;
      const current = episode.fileId ? db.data.files[episode.fileId] : undefined;
      return current?.association?.source !== 'manual';
    }) &&
    files.some((file) => file.path === entry.importResult!.path && file.download!.clientId === entry.clientId && file.download!.hash === entry.transferHash),
  ).map((entry) => {
    const evidence = structuredClone(evidenceOf(entry));
    snapshots.push({ entry, signature: JSON.stringify(evidence) });
    return evidence;
  });
  const groups = new Map<string, typeof candidates>();
  for (const entry of candidates) groups.set(entry.clientId!, [...(groups.get(entry.clientId!) ?? []), entry]);
  for (const [clientId, entries] of groups) {
    const handle = clients.get(clientId);
    if (!handle) continue;
    const torrents = await clients.byHashes(handle, [...new Set(entries.map((entry) => entry.transferHash!))]).catch(() => []);
    for (const torrent of torrents) {
      const videos = await torrentVideos(handle, torrent).catch(() => undefined);
      if (!videos) continue;
      const identities = await Promise.all(videos.map(async (video) => ({ video, info: await lstat(video.abs).catch(() => undefined) })));
      const coverages = new Map<string, Map<string, ReturnType<typeof inspectCoverage>>>();
      for (const entry of entries.filter((entry) => entry.transferHash === torrent.hash)) {
        const found = folder.files.find((file) => file.path === entry.importResult?.path && file.sizeBytes > 0);
        if (!found) continue;
        const file = files.find((file) => file.path === found.path && file.download!.clientId === entry.clientId && file.download!.hash === entry.transferHash);
        if (!file) continue;
        const matches = identities.filter(({ info }) => info?.isFile() && info.dev === found.dev && info.ino === found.ino && info.size === found.sizeBytes && info.mtimeMs === found.mtimeMs);
        if (matches.length !== 1) continue;
        const source = matches[0]!.video.rel;
        const covers = (episode: { season: number; number: number }) => episode.season === entry.season && episode.number === entry.number;
        if (entry.manualMatch) {
          if (entry.manualMatch.file !== source || !entry.manualMatch.covers.some(covers)) continue;
        } else {
          const seasonHint = parseRelease(entry.release!.title).season ?? parseRelease(basename(torrent.contentPath)).season;
          const key = JSON.stringify([entry.numbering, seasonHint]);
          let coverage = coverages.get(key);
          if (!coverage) {
            const ambiguous = new Set(inspectCoverage(videos.map((video) => video.rel), title, entry.numbering, seasonHint).ambiguous);
            coverage = new Map(videos.filter((video) => !ambiguous.has(video.rel)).map((video) =>
              [video.rel, inspectCoverage([video.rel], title, entry.numbering, seasonHint)],
            ));
            coverages.set(key, coverage);
          }
          const sources = [...coverage].filter(([, item]) => item.episodes.some(covers));
          if (sources.length !== 1 || sources[0]![0] !== source) continue;
        }
        const current = recovered.get(file.id);
        const episodes = current?.episodes ?? [];
        if (!episodes.some((episode) => episode.season === entry.season && episode.number === entry.number)) episodes.push({ season: entry.season!, number: entry.number! });
        recovered.set(file.id, {
          episodes,
          association: {
            source: entry.manualMatch ? 'manual' : entry.numbering?.ranges.length ? 'numbering' : 'automatic',
            originalName: matches[0]!.video.rel,
            numberingRevision: entry.numbering?.revision ?? 0,
            identity: { sizeBytes: found.sizeBytes, mtimeMs: found.mtimeMs, dev: found.dev, ino: found.ino },
          },
        });
      }
    }
  }
  return { recovered, current };
}

// Looks at the folder of a title and updates the file records. It reads the disk and the client inventory.
// It never deletes a file, a title or an episode. A file that is gone is marked missing, and only when the root is healthy.
export async function scanTitle(key: string, clients: Clients = scanClients): Promise<ScanResult> {
  const title = db.data.titles[key];
  const root = title && db.data.roots[title.rootId];
  if (!title || !root || !title.folder) return empty('no_folder');
  const version = filesVersion(key);
  const associations = libraryVersion(key);

  const folder = await readTitleFolder(title);
  if (folder.status === 'root_unavailable') return empty('root_unavailable');
  if (folder.status === 'no_folder') return empty('no_folder');
  const legacyImportsResult = await legacyImports(title, folder, clients);
  const { recovered } = legacyImportsResult;
  const known = new Set(Object.values(db.data.files).filter((file) => file.titleKey === key && file.download?.name && file.download.file).map((file) => file.path));
  const sources = await linkedSources(clients, folder.files.filter((file) => !known.has(file.path)));

  // The user can remove the title while the scan reads the disk. A file record must not outlive its title.
  if (db.data.titles[key] !== title) return empty('no_folder');
  // A deletion of files during the read makes the list of files old. The scan must run again.
  if (filesVersion(key) !== version || libraryVersion(key) !== associations || !legacyImportsResult.current()) return empty('changed');

  // No await from here on, so the changes land in one step.
  const result = empty(folder.status === 'ok' ? 'ok' : 'folder_missing');
  const videos = folder.files.filter((file) => file.sizeBytes > 0);
  const mine = Object.values(db.data.files).filter((file) => file.titleKey === key);
  const byPath = new Map(mine.map((file) => [file.path, file]));
  // A recorded file that is still on the disk is not missing, also when its name gives no episode. A name that the
  // user matched to an episode must not take the file from it.
  const seen = new Set<string>(videos.map((found) => found.path));
  const now = Date.now();

  const sameIdentity = (file: MediaFile, found: InventoryFile) => {
    const identity = file.association?.identity;
    return Boolean(identity && identity.sizeBytes === found.sizeBytes && identity.mtimeMs === found.mtimeMs && (identity.dev === undefined || identity.dev === found.dev) && (identity.ino === undefined || identity.ino === found.ino));
  };
  const ownOf = (found: InventoryFile) =>
    byPath.get(found.path) ?? mine.find((file) => !seen.has(file.path) && file.association?.identity.dev !== undefined && file.association.identity.ino !== undefined && sameIdentity(file, found));
  const record = (found: InventoryFile, episodes: MediaFile['episodes']): MediaFile => {
    let file = ownOf(found);
    const preserve = file && sameIdentity(file, found);
    if (file) {
      byPath.delete(file.path);
      file.path = found.path;
      file.sizeBytes = found.sizeBytes;
      file.mtimeMs = found.mtimeMs;
      file.missing = false;
      file.episodes = episodes.map((episode) => ({ ...episode }));
      result.updated++;
    } else {
      file = { id: randomUUID(), titleKey: key, path: found.path, sizeBytes: found.sizeBytes, mtimeMs: found.mtimeMs, episodes, missing: false, addedAt: now };
      db.data.files[file.id] = file;
      result.added++;
    }
    byPath.set(file.path, file);
    if (!preserve) file.association = {
      source: title.numbering?.ranges.length ? 'numbering' : 'automatic',
      originalName: found.path,
      numberingRevision: title.numbering?.revision ?? 0,
      identity: { sizeBytes: found.sizeBytes, mtimeMs: found.mtimeMs, dev: found.dev, ino: found.ino },
    };
    const source = sources.get(found.path);
    if (source && (episodes.length || title.mediaType === 'movie')) recordSource(file, source.download);
    return file;
  };

  if (title.mediaType === 'movie') {
    const current = title.fileId ? db.data.files[title.fileId] : undefined;
    const currentMissing = current?.missing ?? false;
    const sorted = [...videos].sort((a, b) => a.path.localeCompare(b.path));
    // The file that the library has stays, while it is on the disk. A bigger file does not replace it.
    const keep = current && sorted.find((found) => ownOf(found)?.id === current.id && sameIdentity(current, found));
    const names = new Set([title.meta.title, title.meta.originalTitle, ...title.meta.aliases, parseRelease(basename(title.folder)).title].map(normalizeTitle));
    const named = sorted.filter((found) => {
      const parsed = parseRelease(basename(found.path));
      return names.has(normalizeTitle(parsed.title)) && (parsed.year === null || title.meta.year === null || parsed.year === title.meta.year);
    });
    const chosen = keep ?? (named.length === 1 ? named[0] : sorted.length === 1 ? sorted[0] : undefined);
    if (chosen) {
      const file = record(chosen, []);
      // A missing file gives its place to the new file, so its record goes.
      if (current && currentMissing && file.id !== current.id) delete db.data.files[current.id];
      title.fileId = file.id;
    } else if (current && !current.missing && sorted.some((found) => found.path === current.path)) {
      current.missing = true;
      result.missing++;
    }
    // A recorded version that is on the disk stays as another version.
    for (const found of sorted) {
      const own = ownOf(found);
      if (found !== chosen && own && sameIdentity(own, found)) record(found, []);
    }
    result.extraFiles = sorted.filter((found) => found !== chosen && !byPath.has(found.path)).map((found) => found.path);
  } else {
    for (const found of videos) {
      const own = ownOf(found);
      const legacy = own && !own.association ? recovered.get(own.id) : undefined;
      if (legacy) own!.association = legacy.association;
      if (own && sameIdentity(own, found)) {
        const file = record(found, legacy?.episodes ?? own.episodes);
        for (const episode of title.episodes) {
          if (!file.episodes.some((item) => item.season === episode.season && item.number === episode.number)) continue;
          const current = episode.fileId ? db.data.files[episode.fileId] : undefined;
          if (!current || current.missing || current.id === file.id) episode.fileId = file.id;
        }
        continue;
      }
      // An import-generated name cannot identify replacement data or approve a legacy import.
      if (own && (own.download || own.source !== undefined || (own.association && (own.association.source === 'manual' || own.association.originalName !== own.path)))) {
        const association = own.association;
        const file = record(found, []);
        file.association = association;
        result.unmatched.push(found.path);
        continue;
      }
      const parsed = found.parsed;
      if (!parsed) {
        result.unmatched.push(found.path);
        if (own) record(found, []);
        continue;
      }
      const listed = parsed.numbers.flatMap((number) => {
        const episode = title.episodes.find((e) => e.season === parsed.season && e.number === number);
        return episode ? [episode] : [];
      });
      if (!listed.length || listed.length < parsed.numbers.length) result.unknownEpisodes.push(found.path);
      if (!listed.length) {
        if (own) record(found, []);
        continue;
      }
      // An episode keeps the file that it has, while that file is on the disk. A second file is reported.
      const taken = listed.some((episode) => {
        const other = episode.fileId ? db.data.files[episode.fileId] : undefined;
        return other && other.id !== own?.id && !other.missing && seen.has(other.path) && other.episodes.some((item) => item.season === episode.season && item.number === episode.number);
      });
      // A recorded version stays, also when another file is the one of the episode.
      if (taken && !own) {
        result.duplicates.push(found.path);
        continue;
      }
      const file = record(found, listed.map((episode) => ({ season: episode.season, number: episode.number })));
      // A recorded version becomes the file of an episode only when the file of that episode is gone.
      for (const episode of listed) {
        const current = episode.fileId ? db.data.files[episode.fileId] : undefined;
        if (!current || current.missing || !current.episodes.some((item) => item.season === episode.season && item.number === episode.number)) episode.fileId = file.id;
      }
    }
  }

  // A file that was here before and is not here now. The root is healthy, so the file is gone.
  for (const file of mine) {
    if (!seen.has(file.path) && db.data.files[file.id] && !file.missing) {
      file.missing = true;
      result.missing++;
    }
  }
  // A pointer to a file that does not cover the episode is stale. It would show the episode as available while the
  // file holds other content. A file that is gone keeps its pointer, so the episode shows as missing.
  if (title.mediaType !== 'movie') {
    for (const episode of title.episodes) {
      const file = episode.fileId ? db.data.files[episode.fileId] : undefined;
      if (file && !file.missing && !file.episodes.some((item) => item.season === episode.season && item.number === episode.number)) episode.fileId = null;
    }
  }
  return result;
}
