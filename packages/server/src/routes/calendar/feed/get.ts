import { get } from '../../../core/db.ts';
import type { RequestHandler } from 'express';

export function calendarFeedTokenGet(): RequestHandler {
  const db = get();
  return (_req, res) => void res.json({ token: db.data.calendarFeedToken });
}
