import { get } from '../../../core/db.ts';
import type { RequestHandler } from 'express';
import { newToken } from '../../../core/auth.ts';

export function authApiKey(): RequestHandler {
  const db = get();
  return async (_req, res) => {
    if (!db.data.apiKey) {
      // The owner was made before keys existed.
      db.data.apiKey = newToken();
      await db.write();
    }
    res.json({ apiKey: db.data.apiKey });
  };
}
