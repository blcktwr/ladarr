import { stat } from 'node:fs/promises';
import type { RequestHandler } from 'express';
import type { Db } from '../../../../core/db.ts';

// The user says that the disk at this path is the right one. This stores its device number again.
export function rootsAcceptMount(db: Db): RequestHandler<{ id: string }> {
  return async (req, res) => {
    const root = db.data.roots[req.params.id];
    if (!root) return void res.status(404).json({ error: 'not_found' });
    const info = await stat(root.path).catch(() => undefined);
    if (!info?.isDirectory()) return void res.status(409).json({ error: 'root_unusable', problems: ['not_found'] });
    root.dev = info.dev;
    await db.write();
    res.json({ ok: true });
  };
}
