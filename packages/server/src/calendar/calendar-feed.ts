import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { CalendarEvent } from '@ladarr/shared/types';
import { Router, type RequestHandler } from 'express';
import { requireAuth } from '../core/auth.ts';
import { addDays, calendarEvents, dayOf } from './calendar.ts';
import type { Db } from '../core/db.ts';

// The feed starts a month back and ends a year ahead.
const PAST_DAYS = 30;
const FUTURE_DAYS = 365;

const digest = (value: string) => createHash('sha256').update(value).digest();
const pad = (n: number | null) => String(n).padStart(2, '0');
const escapeText = (text: string) => text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const compactDay = (day: string) => day.replace(/-/g, '');
const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]|\.\d{3}/g, '');

// A line has at most 75 octets. The rest goes on the next line, which starts with a space.
function fold(line: string) {
  const parts: string[] = [];
  let current = '';
  let octets = 0;
  for (const char of line) {
    const size = Buffer.byteLength(char);
    if (octets + size > (parts.length ? 74 : 75)) {
      parts.push(current);
      current = '';
      octets = 0;
    }
    current += char;
    octets += size;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

const summary = (event: CalendarEvent) =>
  event.season === null ? event.title : `${event.title} S${pad(event.season)}E${pad(event.number)}${event.episodeName ? ` - ${event.episodeName}` : ''}`;

// A date without a time is an all-day event. A date with a time is a point in time, so the clients show it in their own zone.
export function buildIcal(events: CalendarEvent[], now: number) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ladarr//calendar//EN', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:ladarr'];
  for (const event of events) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${event.id}@ladarr`,
      `DTSTAMP:${stamp(now)}`,
      ...(event.at === null ? [`DTSTART;VALUE=DATE:${compactDay(event.day)}`, `DTEND;VALUE=DATE:${compactDay(addDays(event.day, 1))}`] : [`DTSTART:${stamp(event.at)}`]),
      `SUMMARY:${escapeText(summary(event))}`,
      // The events do not make the user busy.
      'TRANSP:TRANSPARENT',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

// The feed has no session. The token in the query is the only credential, and the request log leaves the query out.
// A wrong token and a feed that is off both answer 404, so a caller cannot tell them apart.
export function icalHandler(db: Db): RequestHandler {
  return (req, res) => {
    const token = req.query.token;
    const expected = db.data.calendarFeedToken;
    if (!expected || typeof token !== 'string' || !timingSafeEqual(digest(token), digest(expected))) return void res.status(404).json({ error: 'not_found' });
    const now = Date.now();
    const today = dayOf(now, db.data.settings.timeZone);
    const { events } = calendarEvents(db, { from: addDays(today, -PAST_DAYS), to: addDays(today, FUTURE_DAYS), monitored: true, limit: Infinity }, now);
    res.type('text/calendar; charset=utf-8').send(buildIcal(events, now));
  };
}

// Only the owner session manages the token. The API key cannot.
export function feedTokenRouter(db: Db) {
  const router = Router();
  router.use(requireAuth(db, { allowApiKey: false }));

  router.get('/', (_req, res) => void res.json({ token: db.data.calendarFeedToken }));

  // A new token replaces the old one, so the old URL stops working.
  router.post('/', async (_req, res) => {
    const previous = db.data.calendarFeedToken;
    db.data.calendarFeedToken = randomBytes(32).toString('base64url');
    try {
      await db.write();
    } catch (err) {
      db.data.calendarFeedToken = previous;
      throw err;
    }
    res.json({ token: db.data.calendarFeedToken });
  });

  router.delete('/', async (_req, res) => {
    const previous = db.data.calendarFeedToken;
    db.data.calendarFeedToken = null;
    try {
      await db.write();
    } catch (err) {
      db.data.calendarFeedToken = previous;
      throw err;
    }
    res.json({ token: null });
  });

  return router;
}
