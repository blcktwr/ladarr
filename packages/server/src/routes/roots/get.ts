import { get } from '../../core/db.ts';
import type { RequestHandler } from 'express';
import { checkRoot } from '../../library/roots.ts';

export function rootsGet(): RequestHandler {
  const db = get();
  return async (_req, res) => {
    const roots = await Promise.all(Object.values(db.data.roots).map(async (root) => ({ ...root, check: await checkRoot(root.path, root.dev) })));
    res.json({ roots });
  };
}
