import type { RequestHandler } from 'express';
import type { Db } from '../../../core/db.ts';

export function calendarFeedTokenGet(db: Db): RequestHandler {
  return (_req, res) => void res.json({ token: db.data.calendarFeedToken });
}
