import type { RequestHandler } from 'express';
import { cookiePath, SESSION_COOKIE } from '../../../core/auth.ts';
import { RestoreError } from '../../../system/restore.ts';
import type { Restorer } from '../../../types.ts';

export function systemReset(restorer: Restorer, reset: () => Promise<void>): RequestHandler {
  return async (req, res) => {
    if (req.body?.confirm !== true) return void res.status(400).json({ error: 'confirmation_required' });
    try {
      await restorer.reset(reset, res);
    } catch (error) {
      if (error instanceof RestoreError) return void res.status(409).json({ error: error.code });
      throw error;
    }
    res.clearCookie(SESSION_COOKIE, { path: cookiePath(req) });
    res.json({ ok: true });
  };
}
