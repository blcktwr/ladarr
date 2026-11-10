import { get } from '../../../core/db.ts';
import type { RequestHandler } from 'express';

export function calendarFeedTokenDelete(): RequestHandler {
  const db = get();
  return async (_req, res) => {
    const previous = db.data.calendarFeedToken;
    db.data.calendarFeedToken = null;
    try {
      await db.write();
    } catch (err) {
      db.data.calendarFeedToken = previous;
      throw err;
    }
    res.json({ token: null });
  };
}
