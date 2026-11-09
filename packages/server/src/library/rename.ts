import type { RenameCheck, RenameOverview, RenameRow } from '@ladarr/shared/types';
import { lstat, realpath } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { Router } from 'express';
import type { Db } from '../core/db.ts';
import type { ImportStatus } from './import-status.ts';
import { inside, type JournalStep } from './importer.ts';
import { keyOf, openJournal, PlanError, readableRoot, titleBusy } from './import-plan.ts';
import type { EnqueueInput, Job } from '../core/jobs.ts';
import { episodePath, exampleNames, folderName, moviePath, templateProblem, type NamingTemplates } from './naming.ts';

export type { RenameRow };

// Works out the name that each file of a title would have with the templates. It changes nothing.
// A rename is safe when the new name is free: no file on the disk has it, and no other record of the library has it.
export async function planRename(db: Db, titleKey: string, naming: NamingTemplates = db.data.settings.naming) {
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

const STATUS: Record<string, number> = { title_not_found: 404, root_unavailable: 409, title_busy: 409, nothing_to_rename: 409 };

type Deps = { db: Db; enqueue: (input: EnqueueInput) => Job; status: ImportStatus };

export function renameRouter({ db, enqueue, status }: Deps) {
  const router = Router();
  const fail = (res: import('express').Response, error: unknown) => {
    if (!(error instanceof PlanError)) throw error;
    res.status(STATUS[error.code] ?? 400).json({ error: error.code });
  };
  const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

  // The templates of the request, or the saved ones. A template that is not valid never reaches the plan.
  function templatesOf(body: Record<string, unknown>): NamingTemplates | { invalid: string } {
    if (body.movie === undefined && body.episode === undefined) return db.data.settings.naming;
    const next = { movie: body.movie, episode: body.episode };
    for (const kind of ['movie', 'episode'] as const) if (templateProblem(kind, next[kind])) return { invalid: kind };
    return next as NamingTemplates;
  }

  // The names of a sample movie and a sample episode, and the problem of each template.
  router.post('/examples', (req, res) => {
    const body = isObject(req.body) ? req.body : {};
    const problems = { movie: templateProblem('movie', body.movie), episode: templateProblem('episode', body.episode) };
    res.json({ problems, examples: problems.movie || problems.episode ? null : exampleNames(body as NamingTemplates) } satisfies RenameCheck);
  });

  router.post('/preview', async (req, res) => {
    const body = isObject(req.body) ? req.body : {};
    const naming = templatesOf(body);
    if ('invalid' in naming) return void res.status(400).json({ error: 'invalid_template', field: naming.invalid });
    try {
      const { rows } = await planRename(db, String(body.titleKey ?? ''), naming);
      res.json({ rows, counts: { rename: rows.filter((row) => row.status === 'rename').length, blocked: rows.filter((row) => row.status === 'blocked').length } });
    } catch (error) {
      fail(res, error);
    }
  });

  // The titles that new templates would change, with the count of files that change and the count that are blocked.
  router.post('/overview', async (req, res) => {
    const body = isObject(req.body) ? req.body : {};
    const naming = templatesOf(body);
    if ('invalid' in naming) return void res.status(400).json({ error: 'invalid_template', field: naming.invalid });
    const titles: { titleKey: string; title: string; year: number | null; rename: number; blocked: number }[] = [];
    const withFiles = new Set(Object.values(db.data.files).map((file) => file.titleKey));
    for (const title of Object.values(db.data.titles)) {
      if (!withFiles.has(title.key)) continue;
      try {
        const { rows } = await planRename(db, title.key, naming);
        const rename = rows.filter((row) => row.status === 'rename').length;
        const blocked = rows.filter((row) => row.status === 'blocked').length;
        if (rename || blocked) titles.push({ titleKey: title.key, title: title.meta.title, year: title.meta.year, rename, blocked });
      } catch (error) {
        // A root that is not available gives no answer for its titles. The other titles go on.
        if (!(error instanceof PlanError)) throw error;
      }
    }
    titles.sort((a, b) => a.title.localeCompare(b.title));
    res.json({ titles: titles.slice(0, 200), total: titles.length } satisfies RenameOverview);
  });

  // The plan is made again here, with the saved templates.
  router.post('/apply', async (req, res) => {
    try {
      const plan = await planRename(db, String(isObject(req.body) ? req.body.titleKey : ''));
      if (!plan.steps.length) throw new PlanError('nothing_to_rename');
      if (titleBusy(db, plan.title.key)) throw new PlanError('title_busy');
      const journal = await openJournal({ db, enqueue, status }, { kind: 'rename', titleKey: plan.title.key, sourceBase: plan.rootReal, steps: plan.steps });
      res.status(202).json({ id: journal.id, total: plan.steps.length });
    } catch (error) {
      fail(res, error);
    }
  });

  return router;
}
