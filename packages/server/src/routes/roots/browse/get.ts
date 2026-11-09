import { readdir, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { FolderListing } from '@ladarr/shared/types';
import type { RequestHandler } from 'express';

// The folders inside a folder of the disk, for the picker of the settings. Dot folders stay out.
export function rootsBrowse(): RequestHandler {
  return async (req, res) => {
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
  };
}
