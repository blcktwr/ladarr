import type { CalendarEvent } from '@ladarr/shared/types';
import { addDays } from './calendar.ts';

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
