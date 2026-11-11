import { type Db, db, profilesInOrder } from '../../../core/db.ts';
import type { RequestHandler } from 'express';

// The order of the chain, the best profile first.
export function qualityOrderPut(): RequestHandler {
  return async (req, res) => {
    const ids = (req.body as { ids?: unknown } | null)?.ids;
    const known = Object.keys(db.data.profiles);
    const valid = Array.isArray(ids) && ids.length === known.length && ids.every((id) => typeof id === 'string' && Object.hasOwn(db.data.profiles, id)) && new Set(ids).size === ids.length;
    if (!valid) return void res.status(400).json({ error: 'invalid_order' });
    db.data.profileOrder = ids as string[];
    await db.write();
    res.json({ profiles: profilesInOrder(db.data) });
  };
}
