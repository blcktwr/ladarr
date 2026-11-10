import { get } from '../../core/db.ts';
import type { RequestHandler } from 'express';
import { ownerOf } from '../../library/grab/blocklist.ts';

export function blocklistClear(): RequestHandler {
  const db = get();
  return async (req, res) => {
    const titleKey = typeof req.query.titleKey === 'string' ? req.query.titleKey : null;
    if (titleKey === null) {
      const removed = Object.keys(db.data.blocklist).length;
      db.data.blocklist = {};
      await db.write();
      return void res.json({ removed });
    }
    const keys = Object.keys(db.data.blocklist).filter((key) => ownerOf(db.data.blocklist[key]!, db.data.titles) === titleKey);
    for (const key of keys) delete db.data.blocklist[key];
    await db.write();
    res.json({ removed: keys.length });
  };
}
