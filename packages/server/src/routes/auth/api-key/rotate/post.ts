import type { RequestHandler } from 'express';
import { newToken } from '../../../../core/auth.ts';
import type { Db } from '../../../../core/db.ts';

export function authRotateApiKey(db: Db): RequestHandler {
  return async (_req, res) => {
    const previous = db.data.apiKey;
    db.data.apiKey = newToken();
    try {
      await db.write();
    } catch (err) {
      db.data.apiKey = previous;
      throw err;
    }
    res.json({ apiKey: db.data.apiKey });
  };
}
