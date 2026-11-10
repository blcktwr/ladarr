import { get } from '../../../core/db.ts';
import { randomBytes } from 'node:crypto';
import type { RequestHandler } from 'express';

// A new token replaces the old one, so the old URL stops working.
export function calendarFeedTokenPost(): RequestHandler {
  const db = get();
  return async (_req, res) => {
    const previous = db.data.calendarFeedToken;
    db.data.calendarFeedToken = randomBytes(32).toString('base64url');
    try {
      await db.write();
    } catch (err) {
      db.data.calendarFeedToken = previous;
      throw err;
    }
    res.json({ token: db.data.calendarFeedToken });
  };
}
