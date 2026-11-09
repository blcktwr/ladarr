import { randomBytes } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { Db } from '../../../core/db.ts';

// A new token replaces the old one, so the old URL stops working.
export function calendarFeedTokenPost(db: Db): RequestHandler {
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
