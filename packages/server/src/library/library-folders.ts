import { readdir, realpath, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { UntitledFolder } from '@ladarr/shared/types';
import { Router } from 'express';
import type { Db } from '../core/db.ts';
import type { Events } from '../core/events.ts';
import { inside, listFiles } from './folder-files.ts';
import type { EnqueueInput, Job } from '../core/jobs.ts';
import { AddError, addTitle } from './library-add.ts';
import { titleKey } from './library.ts';
import { isSample, isVideoFile } from './parse.ts';
import { checkRoot } from './roots.ts';
import { scanJob } from './scan.ts';
import type { Tmdb } from '../metadata/tmdb.ts';

type Deps = { tmdb?: Tmdb; events: Events; enqueue: (input: EnqueueInput) => Job };

// Folders that other tools make in a library folder. They are not titles.
const IGNORED = new Set(['@eaDir', '#recycle', 'lost+found']);
const MAX_FILES = 5_000;
const BLOCKING = ['not_found', 'not_directory', 'not_readable', 'mount_changed'];

// The title and year that a folder name suggests: "Name (2020)", "Name.2020.1080p", or "Name {tmdb-12}".
export function guessTitle(folder: string): { title: string; year: number | null } {
  let text = folder.replace(/[{[][^}\]]*[}\]]/g, ' ');
  let year: number | null = null;
  const bracketed = /\(((?:19|20)\d{2})\)/.exec(text);
  const loose = bracketed ? null : /^(.+?)[ ._-]+((?:19|20)\d{2})(?!\d)/.exec(text);
  if (bracketed) {
    year = Number(bracketed[1]);
    text = text.slice(0, bracketed.index);
  } else if (loose) {
    year = Number(loose[2]);
    text = loose[1]!;
  }
  // A name with dots or underscores and no space comes from a release.
  if (!text.includes(' ')) text = text.replace(/[._]+/g, ' ');
  return { title: text.replace(/\s+/g, ' ').trim() || folder, year };
}

export function libraryFoldersRouter(db: Db, { tmdb, events, enqueue }: Deps) {
  const router = Router();
  // A folder that an add is about to use. This keeps two requests from giving one folder to two titles.
  const adopting = new Set<string>();

  // The top-level folder that a title uses. A title in "Anime/Show" uses "Anime".
  const claims = (rootId: string) =>
    new Map(
      Object.values(db.data.titles)
        .filter((title) => title.rootId === rootId && title.folder)
        .map((title) => [title.folder!.split('/')[0]!, title.key] as const),
    );

  // shortcut: only the folders directly under a root are looked at. A title in a deeper folder is not found.
  router.get('/folders', async (_req, res) => {
    const folders: UntitledFolder[] = [];
    const skipped: { rootId: string; path: string }[] = [];
    for (const root of Object.values(db.data.roots)) {
      const health = await checkRoot(root.path, root.dev);
      if (health.problems.some((problem) => BLOCKING.includes(problem))) {
        skipped.push({ rootId: root.id, path: root.path });
        continue;
      }
      const used = claims(root.id);
      const entries = await readdir(root.path, { withFileTypes: true }).catch(() => undefined);
      if (!entries) {
        skipped.push({ rootId: root.id, path: root.path });
        continue;
      }
      const names = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !IGNORED.has(entry.name) && !used.has(entry.name)).map((entry) => entry.name);
      for (const folder of names) {
        const { files } = await listFiles(join(root.path, folder), MAX_FILES).catch(() => ({ files: [] }));
        const videos = files.filter((file) => isVideoFile(file.path) && !isSample(file.path));
        // A folder without a video file has nothing to add.
        if (videos.length) folders.push({ rootId: root.id, mediaType: root.mediaType, folder, videoFiles: videos.length, sizeBytes: videos.reduce((sum, file) => sum + file.sizeBytes, 0), guess: guessTitle(folder) });
      }
    }
    folders.sort((a, b) => a.folder.localeCompare(b.folder));
    res.json({ folders, skipped });
  });

  // Gives an existing folder to a title. A new title starts with the files that the folder holds.
  router.post('/folders/adopt', async (req, res) => {
    if (!tmdb) return void res.status(503).json({ error: 'metadata_unavailable' });
    const { rootId, folder, tmdbId } = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>;
    const root = typeof rootId === 'string' ? db.data.roots[rootId] : undefined;
    if (!root || typeof tmdbId !== 'number' || !Number.isInteger(tmdbId) || tmdbId < 1) return void res.status(400).json({ error: 'invalid_folder' });
    // One name, no path. The name must be a folder directly under the root.
    if (typeof folder !== 'string' || !folder || folder.length > 255 || /[/\\\0]/.test(folder) || folder.startsWith('.')) return void res.status(400).json({ error: 'invalid_folder' });

    const slot = `${root.id}/${folder}`;
    const owner = claims(root.id).get(folder);
    if (owner || adopting.has(slot)) return void res.status(409).json({ error: 'folder_in_use', key: owner ?? null });
    adopting.add(slot);
    try {
      const health = await checkRoot(root.path, root.dev);
      if (health.problems.some((problem) => BLOCKING.includes(problem))) return void res.status(409).json({ error: 'root_unusable', problems: health.problems });
      const real = await realpath(join(root.path, folder)).catch(() => undefined);
      if (!real || !(await stat(real)).isDirectory()) return void res.status(404).json({ error: 'folder_not_found' });
      // A link to another folder is not this folder.
      if (!inside(root.path, real) || relative(root.path, real) !== folder) return void res.status(400).json({ error: 'invalid_folder' });

      const key = titleKey(root.mediaType, tmdbId);
      const existing = db.data.titles[key];
      if (existing) {
        // A title in the library without a folder takes this one. A title with a folder keeps its own.
        if (existing.rootId !== root.id || existing.folder) return void res.status(409).json({ error: 'already_in_library', key });
        existing.folder = folder;
        enqueue(scanJob(key));
      } else {
        // A series starts with Future episodes. The old episodes that the folder lacks do not start downloads.
        await addTitle({ db, tmdb, enqueue }, { mediaType: root.mediaType, tmdbId, mode: root.mediaType === 'tv' ? 'future' : 'all', seriesType: 'standard', preset: null, rootId: root.id, folder });
      }
      await db.write();
      events.publish('library.changed', { key });
      res.status(existing ? 200 : 201).json({ key });
    } catch (err) {
      if (err instanceof AddError) return void res.status(409).json({ error: err.code, key: err.key });
      throw err;
    } finally {
      adopting.delete(slot);
    }
  });

  return router;
}
