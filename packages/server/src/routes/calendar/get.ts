import type { CalendarResponse } from '@ladarr/shared/types';
import type { RequestHandler } from 'express';
import { addDays, calendarEvents, dayOf, isDay } from '../../library/calendar/calendar.ts';

// The most days that one request can ask for.
const MAX_DAYS = 100;

const monthStart = (day: string) => `${day.slice(0, 8)}01`;
const monthEnd = (day: string) => addDays(addDays(monthStart(day), 31).slice(0, 8) + '01', -1);

export function calendarGet(): RequestHandler {
  return (req, res) => {
    const today = dayOf(Date.now());
    const from = req.query.from ?? monthStart(today);
    const to = req.query.to ?? monthEnd(today);
    if (!isDay(from) || !isDay(to) || from > to || addDays(from, MAX_DAYS - 1) < to) return void res.status(400).json({ error: 'invalid_range' });
    const type = req.query.type === 'movie' || req.query.type === 'tv' ? req.query.type : undefined;
    const body: CalendarResponse = { from, to, today, ...calendarEvents({ from, to, type, monitored: req.query.monitored !== '0' }) };
    res.json(body);
  };
}
