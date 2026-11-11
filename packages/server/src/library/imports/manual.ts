import type { FolderFileStatus } from '@ladarr/shared/enums';
import type { FolderFile, FolderPlan } from '@ladarr/shared/types';
import { lstat, realpath, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, parse, sep } from 'node:path';
import { type Db, db } from '../../core/db.ts';
import { inside, listVideos, type Found, type JournalStep } from './importer.ts';
import { keyOf, PlanError, presentFile, readableRoot } from './plan.ts';
import type { Episode, Title } from '../library.ts';
import { episodePath, folderName, moviePath } from '../naming.ts';
import { parseEpisodes } from '../parse.ts';

export type { FolderFile, FolderFileStatus, FolderPlan };

const normalize = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

export type PlanInput = {
  title: Title;
  rootReal: string;
  real: string;
  videos: Found[];
  replace: boolean;
  // An import from a download folder never copies: a file on another disk can not be linked, so it is blocked.
  linkOnly?: boolean;
};

// Reads the video files of a folder that the user names. It changes nothing.
export async function readFolder(input: { path: unknown; configDir?: string }): Promise<{ real: string; videos: Found[] }> {
  if (typeof input.path !== 'string' || !isAbsolute(input.path)) throw new PlanError('path_not_absolute');
  const real = await realpath(input.path).catch(() => undefined);
  if (!real) throw new PlanError('folder_not_found');
  if (!(await stat(real)).isDirectory()) throw new PlanError('not_a_folder');
  if (real === parse(real).root) throw new PlanError('folder_too_broad');
  // The folder must not hold the library or the settings of ladarr, and it must not be a folder that ladarr keeps for itself.
  const configReal = input.configDir ? await realpath(input.configDir).catch(() => undefined) : undefined;
  if (configReal && (inside(configReal, real) || inside(real, configReal))) throw new PlanError('folder_not_allowed');
  if (real.split(sep).some((part) => part.startsWith('.ladarr-'))) throw new PlanError('folder_not_allowed');
  // A folder can be inside a library folder, but it can not hold one: an import would write the library into itself.
  if (Object.values(db.data.roots).some((root) => inside(real, root.path))) throw new PlanError('folder_has_library');

  const videos = await listVideos(real, { skipHidden: true }).catch((error: NodeJS.ErrnoException) => {
    // A folder that the user can not read is a request problem, not a crash.
    if (['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR'].includes(error.code ?? '')) throw new PlanError('folder_not_readable');
    throw error;
  });
  return { real, videos };
}

// Decides what an import would do with each video of the folder. It changes nothing.
export async function planFiles(input: PlanInput): Promise<FolderPlan & { steps: JournalStep[] }> {
  const { title, rootReal, real } = input;
  const rootDev = input.linkOnly ? (await stat(rootReal)).dev : undefined;
  const videos = [...input.videos].sort((a, b) => b.sizeBytes - a.sizeBytes || a.rel.localeCompare(b.rel));
  const movie = title.mediaType === 'movie';
  const folder = title.folder ?? folderName(title);
  const rows: FolderFile[] = [];
  const steps: JournalStep[] = [];
  const takenEpisodes = new Set<string>();
  const takenNames = new Set<string>();
  let movieChosen = false;

  const row = (file: { rel: string; sizeBytes: number }, status: FolderFileStatus, extra: Partial<FolderFile> = {}): FolderFile => ({ rel: file.rel, sizeBytes: file.sizeBytes, status, reason: null, episodes: [], dest: null, replaces: null, ...extra });

  // Decides on a file that has a target: where it goes, and if it replaces a file of the library.
  async function evaluate(file: { abs: string; rel: string; sizeBytes: number }, episodes: Episode[]): Promise<FolderFile> {
    const named = episodes.map(({ season, number, name }) => ({ season, number, name }));
    const dest = movie ? moviePath(title, folder, extname(file.abs).toLowerCase(), db.data.settings.naming) : episodePath(title, folder, episodes, extname(file.abs).toLowerCase(), db.data.settings.naming);
    const found = { dest, episodes: named };
    if (!inside(rootReal, join(rootReal, dest))) return row(file, 'blocked', { ...found, reason: 'destination_outside_root' });

    const target = await lstat(join(rootReal, dest)).catch(() => undefined);
    const source = await stat(file.abs);
    // The source and the destination are one file, for example after an earlier import with a hard link.
    const sameFile = Boolean(target && target.ino === source.ino && target.dev === source.dev);
    const recorded = Object.values(db.data.files).some((record) => record.titleKey === title.key && record.path === dest && !record.missing);
    if (sameFile && recorded) return row(file, 'in_place', found);
    const old = new Set((movie ? [title.fileId] : episodes.map((episode) => episode.fileId)).filter((id): id is string => Boolean(presentFile(id))));
    if (old.size && !input.replace) return row(file, 'exists', { ...found, replaces: presentFile([...old][0]!)!.path });
    let replaces: string | null = null;
    if (old.size) {
      const previous = presentFile([...old][0]!)!;
      const covered = new Set(episodes.map(keyOf));
      // The old file must belong to this file only. Else an episode would lose its file.
      if (old.size > 1 || !previous.episodes.every((episode) => covered.has(keyOf(episode)))) return row(file, 'blocked', { ...found, reason: 'partial_overlap' });
      replaces = previous.path;
      // The source is the library file under another name. Replacing it would delete the source itself.
      if (join(rootReal, previous.path) === file.abs) return row(file, 'blocked', { ...found, reason: 'source_is_library_file' });
    }
    // A file at the destination is safe to replace only when it is the file that the library has for this target.
    if ((target && !sameFile && replaces !== dest) || takenNames.has(dest)) return row(file, 'blocked', { ...found, reason: 'destination_exists' });
    // A file that is already the destination needs no link. Any other file would be hard linked.
    if (!sameFile && rootDev !== undefined && source.dev !== rootDev) return row(file, 'blocked', { ...found, reason: 'hard_link_unavailable' });
    takenNames.add(dest);
    steps.push({ entryIds: [], source: file.rel, dest, replaces, state: 'planned', method: null, sizeBytes: file.sizeBytes, episodes: named.map(({ season, number }) => ({ season, number })), validation: 'basic' });
    return row(file, replaces ? 'replace' : sameFile ? 'register' : 'new', { ...found, replaces });
  }

  for (const file of videos) {
    if (movie) {
      // A movie has one managed file. The biggest video is the movie, and the other videos are extra files.
      rows.push(movieChosen ? row(file, 'extra') : await evaluate(file, []));
      movieChosen = true;
      continue;
    }
    const parsed = parseEpisodes(basename(file.rel)) ?? parseEpisodes(file.rel);
    if (!parsed) {
      rows.push(row(file, 'unmatched'));
      continue;
    }
    const listed = parsed.numbers.map((number) => title.episodes.find((episode) => episode.season === parsed.season && episode.number === number));
    const known = listed.filter((episode): episode is Episode => Boolean(episode));
    if (known.length < listed.length) {
      rows.push(row(file, 'unknown_episode', { episodes: known.map(({ season, number, name }) => ({ season, number, name })) }));
      continue;
    }
    // The biggest file for an episode wins. The others are duplicates.
    if (known.some((episode) => takenEpisodes.has(keyOf(episode)))) {
      rows.push(row(file, 'duplicate', { episodes: known.map(({ season, number, name }) => ({ season, number, name })) }));
      continue;
    }
    for (const episode of known) takenEpisodes.add(keyOf(episode));
    rows.push(await evaluate(file, known));
  }
  // A plain comparison, so the order does not depend on the language of the server.
  rows.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

  const imported = new Set(rows.filter((item) => item.status === 'new' || item.status === 'replace' || item.status === 'register').flatMap((item) => item.episodes.map(keyOf)));
  const seasons = new Set(rows.flatMap((item) => item.episodes.map((episode) => episode.season)));
  const coverage = [...seasons]
    .sort((a, b) => a - b)
    .map((season) => {
      const all = title.episodes.filter((episode) => episode.season === season);
      return {
        season,
        total: all.length,
        covered: all.filter((episode) => imported.has(keyOf(episode))).length,
        missing: all.filter((episode) => !imported.has(keyOf(episode)) && !presentFile(episode.fileId)).map((episode) => episode.number),
      };
    });

  const wanted = normalize(title.meta.title);
  const names = [basename(real), ...videos.slice(0, 20).map((file) => basename(file.rel))];
  return {
    titleKey: title.key,
    path: real,
    nameMatch: wanted ? names.some((name) => normalize(name).includes(wanted)) : null,
    files: rows,
    coverage,
    importable: steps.length,
    truncated: videos.length >= 5_000,
    steps,
  };
}

// Reads the folder of a title in the catalog and decides what an import would do with each file. It changes nothing.
export async function planFolder(input: { titleKey: string; path: unknown; replace: boolean; configDir?: string }): Promise<FolderPlan & { steps: JournalStep[]; real: string }> {
  const title = db.data.titles[input.titleKey];
  if (!title) throw new PlanError('title_not_found');
  const rootReal = await readableRoot(db.data.roots[title.rootId]);

  const { real, videos } = await readFolder(input);
  const plan = await planFiles({ title, rootReal, real, videos, replace: input.replace });
  return { ...plan, real };
}

