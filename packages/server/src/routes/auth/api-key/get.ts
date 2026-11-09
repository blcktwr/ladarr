import type { RequestHandler } from 'express';
import { newToken } from '../../../core/auth.ts';
import type { Db } from '../../../core/db.ts';

export function authApiKey(db: Db): RequestHandler {
  return async (_req, res) => {
    if (!db.data.apiKey) {
      // The owner was made before keys existed.
      db.data.apiKey = newToken();
      await db.write();
    }
    res.json({ apiKey: db.data.apiKey });
  };
}
