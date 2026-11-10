import { get } from '../../../core/db.ts';
import type { RequestHandler } from 'express';

// The record goes away. The folder and its files stay where they are.
export function rootsDelete(): RequestHandler<{ id: string }> {
  const db = get();
  return async (req, res) => {
    const root = db.data.roots[req.params.id];
    if (!root) return void res.status(404).json({ error: 'not_found' });
    const titles = Object.values(db.data.titles).filter((title) => title.rootId === root.id).length;
    if (titles) return void res.status(409).json({ error: 'root_in_use', titles });
    if (db.data.settings.defaultRoots[root.mediaType] === root.id) return void res.status(409).json({ error: 'root_is_default' });
    delete db.data.roots[root.id];
    await db.write();
    res.json({ ok: true });
  };
}
