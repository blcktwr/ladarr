import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, realpath, stat, statfs, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { RootProblem } from '@ladarr/shared/enums';
import type { RootCheck } from '@ladarr/shared/types';
import { type Db, type Root, db } from '../core/db.ts';


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

export const inside = (parent: string, child: string) => {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
};

type Refusal = { error: string; problems?: RootProblem[] };

// Decides if a folder can become a root. Returns the resolved path, or the reason it cannot.
// A saved root leaves itself out of the overlap check when its path changes.
export async function validateNewRoot(input: string, configDir?: string, exceptId?: string): Promise<{ path: string; dev: number; check: RootCheck } | Refusal> {
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

export const refusal = (result: object): result is Refusal => 'error' in result;

