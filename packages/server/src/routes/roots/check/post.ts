import { get } from '../../../core/db.ts';
import type { RequestHandler } from 'express';
import { refusal, validateNewRoot } from '../../../library/roots.ts';

// Shows what adding the folder would do, and saves nothing.
export function rootsCheck({ configDir }: { configDir?: string } = {}): RequestHandler {
  const db = get();
  return async (req, res) => {
    const path = typeof req.body?.path === 'string' ? req.body.path : '';
    if (!path) return void res.status(400).json({ error: 'invalid_path' });
    const result = await validateNewRoot(db, path, configDir);
    if (refusal(result)) return void res.status(400).json(result);
    res.json({ path: result.path, check: result.check });
  };
}
