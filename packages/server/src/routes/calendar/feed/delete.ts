import type { RequestHandler } from 'express';
import type { Db } from '../../../core/db.ts';

export function calendarFeedTokenDelete(db: Db): RequestHandler {
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
