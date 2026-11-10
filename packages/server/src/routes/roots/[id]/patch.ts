import { get } from '../../../core/db.ts';
import type { RequestHandler } from 'express';
import { inside, refusal, validateNewRoot } from '../../../library/roots.ts';

// A saved folder changes its path. The record keeps its id, so the defaults and the settings that name it stay valid.
export function rootsUpdate({ configDir }: { configDir?: string } = {}): RequestHandler<{ id: string }> {
  const db = get();
  return async (req, res) => {
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
  };
}
