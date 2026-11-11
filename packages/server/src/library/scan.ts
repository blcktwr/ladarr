import { randomUUID } from 'node:crypto';
import { readdir, realpath, stat } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';
import { type Db, type MediaFile, db } from '../core/db.ts';
import { filesVersion } from './tools/remove.ts';
import { isSample, isVideoFile, parseEpisodes } from './parse.ts';
import { checkRoot } from './roots.ts';

export type ScanResult = {
  status: 'ok' | 'no_folder' | 'root_unavailable' | 'folder_missing' | 'changed';
  added: number;
  updated: number;
  // Files that were on the disk before and are gone now. They stay in the library, marked as missing.
  missing: number;
  // Video files of a series whose name gives no episode.
  unmatched: string[];
  // Files for an episode that has another file already.
  duplicates: string[];
  // Files for an episode that TMDB does not list.
  unknownEpisodes: string[];
  // The other video files of a movie. A movie has one managed file.
  extraFiles: string[];
};

export const scanJob = (key: string) => ({ type: 'library.scan', payload: { key }, dedupeKey: `scan:${key}` });

const MAX_DEPTH = 6;
// shortcut: a folder with more video files than this is cut short. Raise it if a real title needs more.
const MAX_FILES = 5_000;
// These problems mean that the root cannot be trusted now. A scan then records nothing.
const UNTRUSTED = ['not_found', 'not_directory', 'not_readable', 'mount_changed'];

const empty = (status: ScanResult['status']): ScanResult => ({ status, added: 0, updated: 0, missing: 0, unmatched: [], duplicates: [], unknownEpisodes: [], extraFiles: [] });
const inside = (parent: string, child: string) => {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep));
};

type Found = { path: string; sizeBytes: number; mtimeMs: number };

// Lists the video files under a folder. It does not follow a link to a folder, and it ignores a file that links outside the root.
async function findVideos(folder: string, rootReal: string): Promise<Found[]> {
  const found: Found[] = [];
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
        if (info?.isFile()) found.push({ path: relative(rootReal, path).split(sep).join('/'), sizeBytes: info.size, mtimeMs: info.mtimeMs });
      }
    }
  }
  await walk(folder, 0);
  return found;
}

// Looks at the folder of a title and updates the file records. It only reads the disk.
// It never deletes a file, a title or an episode. A file that is gone is marked missing, and only when the root is healthy.
export async function scanTitle(key: string): Promise<ScanResult> {
  const title = db.data.titles[key];
  const root = title && db.data.roots[title.rootId];
  if (!title || !root || !title.folder) return empty('no_folder');
  const version = filesVersion(key);

  const health = await checkRoot(root.path, root.dev);
  if (health.problems.some((problem) => UNTRUSTED.includes(problem))) return empty('root_unavailable');

  const rootReal = await realpath(root.path);
  const folder = join(rootReal, title.folder);
  const folderReal = await realpath(folder).catch(() => undefined);
  // The folder name is data from outside. It must stay inside the root.
  if (!inside(rootReal, folder) || (folderReal && !inside(rootReal, folderReal))) return empty('no_folder');

  const isDirectory = folderReal ? (await stat(folderReal).catch(() => undefined))?.isDirectory() : false;
  const videos = isDirectory ? await findVideos(folderReal!, rootReal) : [];

  // The user can remove the title while the scan reads the disk. A file record must not outlive its title.
  if (db.data.titles[key] !== title) return empty('no_folder');
  // A deletion of files during the read makes the list of files old. The scan must run again.
  if (filesVersion(key) !== version) return empty('changed');

  // No await from here on, so the changes land in one step.
  const result = empty(isDirectory ? 'ok' : 'folder_missing');
  const mine = Object.values(db.data.files).filter((file) => file.titleKey === key);
  const byPath = new Map(mine.map((file) => [file.path, file]));
  const seen = new Set<string>();
  const now = Date.now();

  const record = (found: Found, episodes: MediaFile['episodes']): MediaFile => {
    let file = byPath.get(found.path);
    if (file) {
      file.sizeBytes = found.sizeBytes;
      file.mtimeMs = found.mtimeMs;
      file.missing = false;
      file.episodes = episodes;
      result.updated++;
    } else {
      file = { id: randomUUID(), titleKey: key, path: found.path, sizeBytes: found.sizeBytes, mtimeMs: found.mtimeMs, episodes, missing: false, addedAt: now };
      db.data.files[file.id] = file;
      byPath.set(file.path, file);
      result.added++;
    }
    seen.add(file.path);
    return file;
  };

  if (title.mediaType === 'movie') {
    const current = title.fileId ? db.data.files[title.fileId] : undefined;
    const sorted = [...videos].sort((a, b) => b.sizeBytes - a.sizeBytes);
    // The file that the library has stays, while it is on the disk. A bigger file does not replace it.
    const keep = current && sorted.find((found) => found.path === current.path);
    const chosen = keep ?? sorted[0];
    if (chosen) {
      const file = record(chosen, []);
      if (title.fileId !== file.id && current) delete db.data.files[current.id];
      title.fileId = file.id;
      result.extraFiles = sorted.filter((found) => found !== chosen).map((found) => found.path);
    }
  } else {
    for (const found of videos) {
      const parsed = parseEpisodes(basename(found.path));
      if (!parsed) {
        result.unmatched.push(found.path);
        continue;
      }
      const listed = parsed.numbers.flatMap((number) => {
        const episode = title.episodes.find((e) => e.season === parsed.season && e.number === number);
        return episode ? [episode] : [];
      });
      if (listed.length < parsed.numbers.length) result.unknownEpisodes.push(found.path);
      if (!listed.length) continue;
      const own = byPath.get(found.path);
      // An episode keeps the file that it has, while that file is on the disk. A second file is reported.
      const taken = listed.some((episode) => {
        const other = episode.fileId ? db.data.files[episode.fileId] : undefined;
        return other && other.id !== own?.id && !other.missing;
      });
      if (taken) {
        result.duplicates.push(found.path);
        continue;
      }
      const file = record(found, listed.map((episode) => ({ season: episode.season, number: episode.number })));
      for (const episode of listed) episode.fileId = file.id;
    }
  }

  // A file that was here before and is not here now. The root is healthy, so the file is gone.
  for (const file of mine) {
    if (!seen.has(file.path) && db.data.files[file.id] && !file.missing) {
      file.missing = true;
      result.missing++;
    }
  }
  return result;
}

