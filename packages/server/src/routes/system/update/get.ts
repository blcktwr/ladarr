import type { RequestHandler } from 'express';
import { log } from '../../../core/log.ts';
import { checkForUpdate } from '../../../system/version.ts';

export function systemUpdateGet(): RequestHandler {
  return async (_req, res) => {
    try {
      res.json(await checkForUpdate());
    } catch (error) {
      log.warn('update check failed', { error });
      res.status(502).json({ error: 'update_unavailable' });
    }
  };
}
