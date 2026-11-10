import { db } from '../../../../core/db.ts';
import type { RequestHandler } from 'express';
import { newToken } from '../../../../core/auth.ts';

export function authRotateApiKey(): RequestHandler {
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
