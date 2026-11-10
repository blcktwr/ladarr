import { db } from '../../../core/db.ts';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { addDays, calendarEvents, dayOf } from '../../../library/calendar/calendar.ts';
import { buildIcal } from '../../../library/calendar/calendar-feed.ts';

// The feed starts a month back and ends a year ahead.
const PAST_DAYS = 30;
const FUTURE_DAYS = 365;

const digest = (value: string) => createHash('sha256').update(value).digest();

// The feed has no session. The token in the query is the only credential, and the request log leaves the query out.
// A wrong token and a feed that is off both answer 404, so a caller cannot tell them apart.
export function calendarFeed(): RequestHandler {
  return (req, res) => {
    const token = req.query.token;
    const expected = db.data.calendarFeedToken;
    if (!expected || typeof token !== 'string' || !timingSafeEqual(digest(token), digest(expected))) return void res.status(404).json({ error: 'not_found' });
    const now = Date.now();
    const today = dayOf(now, db.data.settings.timeZone);
    const { events } = calendarEvents({ from: addDays(today, -PAST_DAYS), to: addDays(today, FUTURE_DAYS), monitored: true, limit: Infinity }, now);
    res.type('text/calendar; charset=utf-8').send(buildIcal(events, now));
  };
}
