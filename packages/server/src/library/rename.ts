import type { RenameRow } from '@ladarr/shared/types';
import { lstat, realpath } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { type Db, db } from '../core/db.ts';
import { inside, type JournalStep } from './imports/importer.ts';
import { keyOf, PlanError, readableRoot } from './imports/plan.ts';
import { episodePath, folderName, moviePath, type NamingTemplates } from './naming.ts';

export type { RenameRow };

// Works out the name that each file of a title would have with the templates. It changes nothing.
// A rename is safe when the new name is free: no file on the disk has it, and no other record of the library has it.
export async function planRename(titleKey: string, naming: NamingTemplates = db.data.settings.naming) {
  const title = db.data.titles[titleKey];
  if (!title) throw new PlanError('title_not_found');
  const rootReal = await readableRoot(db.data.roots[title.rootId]);
  const folder = title.folder ?? folderName(title);
  const files = Object.values(db.data.files)
    .filter((file) => file.titleKey === titleKey && !file.missing)
    .sort((a, b) => a.path.localeCompare(b.path));
  const recorded = new Set(Object.values(db.data.files).filter((file) => file.titleKey === titleKey).map((file) => file.path));

  const rows: RenameRow[] = [];
  const steps = new Map<string, JournalStep>();
  const blocked = (file: { id: string; path: string }, reason: string, to: string | null = null): RenameRow => ({ fileId: file.id, from: file.path, to, status: 'blocked', reason });

  for (const file of files) {
    const extension = extname(file.path);
    let to: string;
    if (title.mediaType === 'movie') to = moviePath(title, folder, extension, naming);
    else {
      const episodes = [...file.episodes].sort((a, b) => a.season - b.season || a.number - b.number).map((c) => title.episodes.find((e) => e.season === c.season && e.number === c.number));
      if (!episodes.length || episodes.some((episode) => !episode)) {
        rows.push(blocked(file, 'episode_unknown'));
        continue;
      }
      to = episodePath(title, folder, episodes as NonNullable<(typeof episodes)[number]>[], extension, naming);
    }
    if (to === file.path) {
      rows.push({ fileId: file.id, from: file.path, to, status: 'unchanged', reason: null });
      continue;
    }
    if (!inside(rootReal, join(rootReal, to))) {
      rows.push(blocked(file, 'destination_outside_root', to));
      continue;
    }
    const old = await lstat(join(rootReal, file.path)).catch(() => undefined);
    if (!old) {
      rows.push(blocked(file, 'file_missing', to));
      continue;
    }
    // A link, or a path that leads out of the root through a link, is not renamed.
    const real = await realpath(join(rootReal, file.path)).catch(() => undefined);
    if (!old.isFile() || !real || !inside(rootReal, real)) {
      rows.push(blocked(file, 'not_a_regular_file', to));
      continue;
    }
    const taken = recorded.has(to) || (await lstat(join(rootReal, to)).then(() => true, () => false));
    if (taken) {
      rows.push(blocked(file, 'destination_exists', to));
      continue;
    }
    rows.push({ fileId: file.id, from: file.path, to, status: 'rename', reason: null });
    steps.set(file.id, { entryIds: [], source: file.path, dest: to, replaces: file.path, state: 'planned', method: null, sizeBytes: old.size, episodes: file.episodes, validation: 'basic' });
  }

  // Two files can not get one name. Neither of them is renamed.
  const count = new Map<string, number>();
  for (const row of rows) if (row.status === 'rename') count.set(row.to!, (count.get(row.to!) ?? 0) + 1);
  for (const row of rows) {
    if (row.status === 'rename' && count.get(row.to!)! > 1) {
      Object.assign(row, { status: 'blocked', reason: 'name_collision' });
      steps.delete(row.fileId);
    }
  }
  return { title, rootReal, rows, steps: [...steps.values()] };
}

