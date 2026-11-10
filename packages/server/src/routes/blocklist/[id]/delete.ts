import { get } from '../../../core/db.ts';
import type { RequestHandler } from 'express';
import { idOf } from '../../../library/grab/blocklist.ts';

export function blocklistRemove(): RequestHandler {
  const db = get();
  return async (req, res) => {
    const key = Object.keys(db.data.blocklist).find((item) => idOf(item) === req.params.id);
    if (key === undefined) return void res.status(404).json({ error: 'not_found' });
    delete db.data.blocklist[key];
    await db.write();
    res.json({ removed: 1 });
  };
}
