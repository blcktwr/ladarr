import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, readdir, realpath, stat, statfs, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Router } from 'express';
import type { MediaType, RootProblem } from '@ladarr/shared/enums';
import type { FolderListing, RootCheck } from '@ladarr/shared/types';
import type { Db, Root } from '../core/db.ts';


// shortcut: one fixed limit for every root. Make it a setting if people ask.
const LOW_SPACE_BYTES = 5 * 1024 ** 3;
// These problems stop the user from adding a folder. The others are warnings.
const BLOCKING: RootProblem[] = ['not_found', 'not_directory', 'not_readable', 'not_writable'];

// Looks at the folder as it is now. It changes nothing in the folder, and it never deletes a record.
export async function checkRoot(path: string, knownDev?: number): Promise<RootCheck> {
  const problems: RootProblem[] = [];
  const info = await stat(path).catch(() => undefined);
  if (!info) return { problems: ['not_found'], freeBytes: null };
  if (!info.isDirectory()) return { problems: ['not_directory'], freeBytes: null };
  if (knownDev !== undefined && info.dev !== knownDev) problems.push('mount_changed');

  if (await access(path, constants.R_OK | constants.X_OK).then(() => false, () => true)) problems.push('not_readable');
  // The permission bits can say yes where a read-only mount says no, so the check writes a small file.
  const probe = join(path, `.ladarr-probe-${randomUUID()}`);
  const writable = await writeFile(probe, '').then(() => unlink(probe).then(() => true, () => true), () => false);
  if (!writable) problems.push('not_writable');

  const space = await statfs(path).catch(() => undefined);
  const freeBytes = space ? Number(space.bavail) * Number(space.bsize) : null;
  if (freeBytes !== null && freeBytes < LOW_SPACE_BYTES) problems.push('low_space');
  return { problems, freeBytes };
}

const inside = (parent: string, child: string) => {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
};

type Refusal = { error: string; problems?: RootProblem[] };

// Decides if a folder can become a root. Returns the resolved path, or the reason it cannot.
// A saved root leaves itself out of the overlap check when its path changes.
export async function validateNewRoot(db: Db, input: string, configDir?: string, exceptId?: string): Promise<{ path: string; dev: number; check: RootCheck } | Refusal> {
  if (!isAbsolute(input)) return { error: 'path_not_absolute' };
  const path = await realpath(resolve(input)).catch(() => undefined);
  if (!path) return { error: 'root_unusable', problems: ['not_found'] };
  // A root at the top of the disk would let the library reach every file.
  if (path === resolve('/')) return { error: 'root_too_broad' };
  if (configDir && (inside(path, configDir) || inside(configDir, path))) return { error: 'root_overlaps_config' };
  const overlaps = (otherId: string, other: Root) => otherId !== exceptId && (inside(other.path, path) || inside(path, other.path));
  if (Object.entries(db.data.roots).some(([id, root]) => overlaps(id, root))) return { error: 'root_overlaps_root' };

  const check = await checkRoot(path);
  const blocking = check.problems.filter((problem) => BLOCKING.includes(problem));
  if (blocking.length) return { error: 'root_unusable', problems: blocking };
  return { path, dev: (await stat(path)).dev, check };
}

const refusal = (result: object): result is Refusal => 'error' in result;

export function rootsRouter(db: Db, { configDir }: { configDir?: string } = {}) {
  const router = Router();

  router.get('/', async (_req, res) => {
    const roots = await Promise.all(Object.values(db.data.roots).map(async (root) => ({ ...root, check: await checkRoot(root.path, root.dev) })));
    res.json({ roots });
  });

  // The folders inside a folder of the disk, for the picker of the settings. Dot folders stay out.
  router.get('/browse', async (req, res) => {
    const input = typeof req.query.path === 'string' ? req.query.path : '';
    if (!isAbsolute(input)) return void res.status(400).json({ error: 'path_not_absolute' });
    const path = await realpath(resolve(input)).catch(() => undefined);
    if (!path) return void res.status(400).json({ error: 'root_unusable', problems: ['not_found'] });
    const info = await stat(path).catch(() => undefined);
    if (!info?.isDirectory()) return void res.status(400).json({ error: 'root_unusable', problems: ['not_directory'] });
    const entries = await readdir(path, { withFileTypes: true }).catch(() => undefined);
    if (!entries) return void res.status(400).json({ error: 'root_unusable', problems: ['not_readable'] });
    const folders = entries.filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && !entry.name.startsWith('.')).map((entry) => entry.name).sort();
    res.json({ path, parent: path === resolve('/') ? null : dirname(path), folders } satisfies FolderListing);
  });

  // Shows what adding the folder would do, and saves nothing.
  router.post('/check', async (req, res) => {
    const path = typeof req.body?.path === 'string' ? req.body.path : '';
    if (!path) return void res.status(400).json({ error: 'invalid_path' });
    const result = await validateNewRoot(db, path, configDir);
    if (refusal(result)) return void res.status(400).json(result);
    res.json({ path: result.path, check: result.check });
  });

  router.post('/', async (req, res) => {
    const { path, mediaType } = (req.body ?? {}) as { path?: unknown; mediaType?: MediaType };
    if (typeof path !== 'string' || !path || (mediaType !== 'movie' && mediaType !== 'tv')) {
      return void res.status(400).json({ error: 'invalid_root' });
    }
    const result = await validateNewRoot(db, path, configDir);
    if (refusal(result)) return void res.status(400).json(result);
    // The check awaited, so another request may have added an overlapping folder. Check again before the save.
    if (Object.values(db.data.roots).some((root) => inside(root.path, result.path) || inside(result.path, root.path))) {
      return void res.status(400).json({ error: 'root_overlaps_root' });
    }
    const root: Root = { id: randomUUID(), path: result.path, mediaType, dev: result.dev };
    db.data.roots[root.id] = root;
    // The first root of a media type becomes its default.
    const defaults = db.data.settings.defaultRoots;
    defaults[mediaType] ??= root.id;
    await db.write();
    res.status(201).json({ ...root, check: result.check });
  });

  // A saved folder changes its path. The record keeps its id, so the defaults and the settings that name it stay valid.
  router.patch('/:id', async (req, res) => {
    const root = db.data.roots[req.params.id];
    if (!root) return void res.status(404).json({ error: 'not_found' });
    const path = typeof req.body?.path === 'string' ? req.body.path : '';
    if (!path) return void res.status(400).json({ error: 'invalid_path' });
    const titles = Object.values(db.data.titles).filter((title) => title.rootId === root.id).length;
    if (titles) return void res.status(409).json({ error: 'root_in_use', titles });
    const result = await validateNewRoot(db, path, configDir, root.id);
    if (refusal(result)) return void res.status(400).json(result);
    // The check awaited, so another request may have added an overlapping folder. Check again before the save.
    if (Object.entries(db.data.roots).some(([id, other]) => id !== root.id && (inside(other.path, result.path) || inside(result.path, other.path)))) {
      return void res.status(400).json({ error: 'root_overlaps_root' });
    }
    root.path = result.path;
    root.dev = result.dev;
    await db.write();
    res.json({ ...root, check: result.check });
  });

  // The user says that the disk at this path is the right one. This stores its device number again.
  router.post('/:id/accept-mount', async (req, res) => {
    const root = db.data.roots[req.params.id];
    if (!root) return void res.status(404).json({ error: 'not_found' });
    const info = await stat(root.path).catch(() => undefined);
    if (!info?.isDirectory()) return void res.status(409).json({ error: 'root_unusable', problems: ['not_found'] });
    root.dev = info.dev;
    await db.write();
    res.json({ ok: true });
  });

  // The record goes away. The folder and its files stay where they are.
  router.delete('/:id', async (req, res) => {
    const root = db.data.roots[req.params.id];
    if (!root) return void res.status(404).json({ error: 'not_found' });
    const titles = Object.values(db.data.titles).filter((title) => title.rootId === root.id).length;
    if (titles) return void res.status(409).json({ error: 'root_in_use', titles });
    if (db.data.settings.defaultRoots[root.mediaType] === root.id) return void res.status(409).json({ error: 'root_is_default' });
    delete db.data.roots[root.id];
    await db.write();
    res.json({ ok: true });
  });

  return router;
}
