import type { LogEntry } from '@ladarr/shared/types';
import { appendFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import pino from 'pino';
import { createStream, type RotatingFileStream } from 'rotating-file-stream';
import { get, type Db } from './db.ts';
import { outboundRequests } from './outbound.ts';

const SECRET_KEY = /pass|secret|token|api[-_]?key|authorization|cookie/i;
// Fields that can hold a credential in a body: a magnet link, a tracker, or a download link.
const SECRET_FIELD = /^(magnet_uri|magneturl|trackers?|link|guid)$/i;
const SECRET_PAIR = /\b(passkey|torrent[-_]?pass|rsskey|authkey|api[-_]?key|token|password|secret)\s*(?:=|%3D)[^&\s"'<>]+/gi;
// The same fields when they come inside the text of a body, in JSON or in XML.
const SECRET_JSON = /("(?:magnet_uri|magneturl|trackers?|link|guid)"\s*:\s*)"(?:[^"\\]|\\.)*"/gi;
const SECRET_XML_TAG = /<(link|guid)\b[^>]*>[\s\S]*?<\/\1>/gi;
const SECRET_XML_ATTR = /<(?:[\w.-]+:)?attr\b[^>]*\bname="magneturl"[^>]*>/gi;
// A feed body carries a secret in any address, also in its path.
const FEED = /<(?:rss|channel|item)\b/i;
const FEED_URL = /\b(?:https?|ftp):\/\/[^\s"'<>]+/gi;
const FEED_MAGNET = /\bmagnet:\?[^\s"'<>]+/gi;
const MAX_DEPTH = 6;
const MAX_TEXT = 2_000;

// qBittorrent lists a tracker as an object with the address in `url`, and no other secret key.
const trackerEntry = (value: object) =>
  'url' in value && ('tier' in value || 'num_peers' in value || 'num_seeds' in value || 'num_leeches' in value);

function redactText(text: string) {
  const out = text
    .replace(SECRET_JSON, '$1"[redacted]"')
    .replace(SECRET_XML_TAG, (match: string, tag: string) => `<${tag}>[redacted]</${tag}>`)
    .replace(SECRET_XML_ATTR, (tag: string) => tag.replace(/\bvalue="[^"]*"/i, 'value="[redacted]"'))
    .replace(SECRET_PAIR, '$1=[redacted]');
  if (!FEED.test(out)) return out;
  return out.replace(FEED_URL, '[redacted]').replace(FEED_MAGNET, '[redacted]');
}

// A long text makes the file big, and its start is enough to find the cause.
function truncate(value: unknown): unknown {
  if (typeof value === 'string') return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)} [truncated]` : value;
  if (Array.isArray(value)) return value.map(truncate);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, truncate(item)]));
}

export function redact(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    // A body of JSON shows as JSON, so the fields of the body follow the same rules.
    const trimmed = value.trim();
    if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && trimmed.length > 1) {
      try {
        return redact(JSON.parse(trimmed), depth);
      } catch {
        /* The text is not JSON. */
      }
    }
    return redactText(value);
  }
  if (value instanceof Error) return redact({ name: value.name, message: value.message, stack: value.stack }, depth);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[deep]';
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, SECRET_KEY.test(key) || SECRET_FIELD.test(key) || (key === 'url' && trackerEntry(value)) ? '[redacted]' : redact(item, depth + 1)]),
  );
}

// The log goes to a file only. pino writes the entries, and rotating-file-stream rotates the file.
// The app entries and the requests have a file each: a request carries a body, and a few of them would push the entries
// of the app out of the file.
// Each log keeps the current file and one older file. Each file passes maxBytes by one entry at most.
// A target in the queue has a file of its own, so the rotation of the app log does not cut the history of the target.
const silent = () => pino({ level: 'silent' });
let logger = silent();
let trafficLogger = silent();
let streams: RotatingFileStream[] = [];
let files = { logs: '', requests: '' };

// The folder of the files of the targets, the setting that turns them on, and the queue that says which targets are in it.
let itemsDir = '';
let itemsOn = false;
let inQueue: (itemId: string) => boolean = () => false;
// The moment when the current record of an item began. A line before it belongs to an older record of the same ID.
let startedAt: (itemId: string) => number = () => 0;
// A title is not a target of the queue, so its own lines stay in the app log until a target of the title enters the
// queue. From then on, its file joins the lines of the title and of its targets.
let isTitleKey: (itemId: string) => boolean = () => false;

// A target file holds the same line as the app log. The path is the ID of the target with a safe name.
const itemFile = (itemId: string) => join(itemsDir, `${itemId.replace(/[^A-Za-z0-9]+/g, '_')}.log`);

// Takes the line from the app log and writes it to the file of its target when the target is in the queue. A line of a
// target also goes to the file of its title, so the page reads the whole log of a series in one place.
const keepItemLine = (line: string) => {
  if (!itemsOn || !itemsDir || !line.includes('"type":"catalog"')) return;
  let entry: { type?: unknown; itemId?: unknown; titleKey?: unknown };
  try {
    entry = JSON.parse(line) as { type?: unknown; itemId?: unknown; titleKey?: unknown };
  } catch {
    return;
  }
  if (entry.type !== 'catalog' || typeof entry.itemId !== 'string' || !inQueue(entry.itemId)) return;
  const append = (id: string) => {
    try {
      mkdirSync(itemsDir, { recursive: true });
      appendFileSync(itemFile(id), line);
    } catch {
      /* The app log still has the line. */
    }
  };
  append(entry.itemId);
  if (typeof entry.titleKey === 'string' && entry.titleKey !== entry.itemId) append(entry.titleKey);
};

// A request has no level: it is written to the same file, and the code of the answer says how it went.
// pino always writes the level, so the stream of the requests drops it before the line reaches the file.
const dropLevel = (stream: { write: (line: string) => void }) => ({
  write(line: string) {
    let text = line;
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      delete entry.level;
      text = `${JSON.stringify(entry)}\n`;
    } catch {
      /* A line that is not JSON goes as it came. */
    }
    stream.write(text);
  },
});

const makeLogger = (stream: { write: (line: string) => void }) =>
  pino(
    {
      level: 'info',
      messageKey: 'message',
      // The time is text, the level is its name, and the entry has no process ID or host name.
      timestamp: pino.stdTimeFunctions.isoTime,
      base: null,
      formatters: { level: (label) => ({ level: label }) },
    },
    stream,
  );

export function logToFile(file: string, maxBytes = 1_000_000) {
  mkdirSync(dirname(file), { recursive: true });
  files = { logs: file, requests: join(dirname(file), 'requests.log') };
  itemsDir = join(dirname(file), 'items');
  // The caller turns the files of the targets on with configureItemLogs().
  itemsOn = false;
  inQueue = () => false;
  startedAt = () => 0;
  isTitleKey = () => false;
  const open = (name: string) => createStream(basename(name), { path: dirname(name), size: `${maxBytes}B`, rotate: 1 });
  streams = [open(files.logs), open(files.requests)];
  const app = streams[0]!;
  logger = makeLogger({
    write(line: string) {
      app.write(line);
      keepItemLine(line);
    },
  });
  trafficLogger = makeLogger(dropLevel(streams[1]!));
}

// The setting says whether a target in the queue keeps its whole log in a file of its own. The queue says which targets
// are in it: a target that is available left the queue, so its file goes.
export function configureItemLogs() {
  const db = get();
  itemsOn = db.data.settings.keepQueueLogs !== false;
  inQueue = (itemId) => {
    const entry = db.data.queue[itemId];
    if (entry) return entry.stage !== 'available';
    // A title is not a target, but the targets of the title keep its file, with their lines and the lines of the title.
    return Object.values(db.data.queue).some((other) => other.titleKey === itemId && other.stage !== 'available');
  };
  // A target begins when its entry enters the queue. A title begins when the person adds it.
  startedAt = (itemId) => db.data.queue[itemId]?.createdAt ?? db.data.titles[itemId]?.addedAt ?? 0;
  isTitleKey = (itemId) => Object.hasOwn(db.data.titles, itemId);
  if (!itemsOn) forgetItemLogs();
  else forgetItemLogsOutsideQueue(db);
}

// Removes the file of one target. A target that left the queue has no log any more.
export function deleteItemLog(itemId: string) {
  if (!itemsDir) return;
  try {
    rmSync(itemFile(itemId), { force: true });
  } catch {
    /* A file that cannot be removed stays for the next try. */
  }
}

function forgetItemLogs() {
  if (!itemsDir) return;
  try {
    rmSync(itemsDir, { recursive: true, force: true });
  } catch {
    /* A folder that cannot be removed stays for the next try. */
  }
}

// Removes the files that no target in the queue owns. A deletion removes its files at once, and this sweep clears what
// an older version left behind.
function forgetItemLogsOutsideQueue(db: Db) {
  if (!itemsDir) return;
  // The keys are the targets in the queue and the titles of those targets. A title file holds the lines of its targets.
  const ids = new Set([...Object.keys(db.data.queue), ...Object.values(db.data.queue).map((entry) => entry.titleKey)]);
  const keep = new Set([...ids].filter((id) => inQueue(id)).map((id) => basename(itemFile(id))));
  try {
    for (const name of readdirSync(itemsDir)) if (!keep.has(name)) rmSync(join(itemsDir, name), { force: true });
  } catch {
    /* A folder that cannot be read stays for the next try. */
  }
}

// Writes what is waiting and closes the files. Call it before the process exits.
export function closeLog(): Promise<void> {
  const open = streams;
  streams = [];
  trafficLogger = silent();
  logger = silent();
  return Promise.all(open.map((stream) => new Promise<void>((resolve) => stream.end(resolve)))).then(() => undefined);
}

type Level = 'info' | 'warn' | 'error';

// A line of a piece of work links the requests that the work sent. A line that already holds its own requests keeps
// only them, so it does not grow with the requests of the earlier lines of the same work.
function linkedRequests(fields: Record<string, unknown>) {
  if (Array.isArray(fields.requests)) return {};
  const made = outboundRequests();
  return made.length ? { requests: made } : {};
}

function write(level: Level, message: string, fields: Record<string, unknown> = {}, target: 'logs' | 'requests' = 'logs') {
  // The fields are redacted first: a cut JSON body would not parse, and its keys would leak.
  const loggerOf = target === 'requests' ? trafficLogger : logger;
  const entry = target === 'logs' ? { type: 'system', ...fields, ...linkedRequests(fields) } : fields;
  loggerOf[level](truncate(redact(entry)) as object, redact(message) as string);
}

export const log = {
  info: (message: string, fields?: Record<string, unknown>) => write('info', message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => write('warn', message, fields),
  error: (message: string, fields?: Record<string, unknown>) => write('error', message, fields),
};

// A catalog log follows a title or one of its targets. A system log is about the server. The two kinds share a file,
// and the type tells them apart.
export type LogType = 'system' | 'catalog';

export type ItemFields = {
  itemId: string;
  itemType: string;
  titleKey: string;
  title: string;
  // The part of the title that the log follows: "Movie", "Series", or "S01E02".
  target: string;
  episode?: string;
  // The attempt of the target, when it has one.
  attempt?: number;
  // Milliseconds since the target was created, so a reader sees the order and the wait of each step.
  sinceCreatedMs?: number;
  // The stage or the branch of the item, when the log is an update of it.
  status?: string;
};

const pad = (value: number) => String(value).padStart(2, '0');

type QueueItem = { id: string; titleKey: string; season: number | null; number: number | null; attempt: number; createdAt: number };

// The fields that name the title or the target of a catalog log.
export function itemFields(db: Db, entry: QueueItem): ItemFields {
  const title = db.data.titles[entry.titleKey];
  const episode = entry.season === null || entry.number === null ? undefined : title?.episodes.find((item) => item.season === entry.season && item.number === entry.number);
  return {
    itemId: entry.id,
    itemType: entry.titleKey.split(':')[0] ?? 'unknown',
    titleKey: entry.titleKey,
    title: title?.meta.title ?? entry.titleKey,
    target: entry.season === null || entry.number === null ? 'Movie' : `S${pad(entry.season)}E${pad(entry.number)}`,
    ...(episode?.name ? { episode: episode.name } : {}),
    attempt: entry.attempt,
    sinceCreatedMs: Date.now() - entry.createdAt,
  };
}

// The fields of a log about the title itself, before any target exists.
export function titleFields(title: { key: string; mediaType: string; meta: { title: string } }): ItemFields {
  return {
    itemId: title.key,
    itemType: title.mediaType,
    titleKey: title.key,
    title: title.meta.title,
    target: title.mediaType === 'movie' ? 'Movie' : 'Series',
  };
}

// Writes a catalog log. `event` is stable, so a person reads the process of one item in one pass, and a search on the
// event finds every step of a kind. `fields` holds the detail of that step, next to the item fields.
export const catalog = {
  info: (event: string, message: string, item: ItemFields, fields?: Record<string, unknown>) => write('info', message, { type: 'catalog', event, ...fields, ...item }),
  warn: (event: string, message: string, item: ItemFields, fields?: Record<string, unknown>) => write('warn', message, { type: 'catalog', event, ...fields, ...item }),
  error: (event: string, message: string, item: ItemFields, fields?: Record<string, unknown>) => write('error', message, { type: 'catalog', event, ...fields, ...item }),
};

// The requests to the server and from the server. They go in their own file, so the app log stays readable.
export const traffic = {
  info: (message: string, fields?: Record<string, unknown>) => write('info', message, fields, 'requests'),
  warn: (message: string, fields?: Record<string, unknown>) => write('warn', message, fields, 'requests'),
};

export type LogFilter = { itemId?: string; itemType?: string; titleKey?: string; kind?: 'logs' | 'requests'; type?: LogType; requestId?: string };

const matches = (entry: LogEntry, filter: LogFilter) =>
  (!filter.type || (entry.type ?? 'system') === filter.type) &&
  (!filter.itemId || entry.itemId === filter.itemId) &&
  (!filter.titleKey || entry.titleKey === filter.titleKey) &&
  (!filter.itemType || entry.itemType === filter.itemType) &&
  (!filter.requestId || entry.requestId === filter.requestId);

const parseLines = (text: string): LogEntry[] =>
  text
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as LogEntry];
      } catch {
        return [];
      }
    });

// The file of a target holds its whole log, so the limit does not cut it. Null means that the target has no file, and
// the app log answers for it.
async function readItemFile(itemId: string): Promise<LogEntry[] | null> {
  if (!itemsDir) return null;
  const text = await readFile(itemFile(itemId), 'utf8').catch(() => null);
  return text === null ? null : parseLines(text);
}

async function readItemLog(itemId: string, filter: LogFilter): Promise<LogEntry[] | null> {
  const entries = await readItemFile(itemId);
  if (entries === null) return null;
  const since = startedAt(itemId);
  return entries.filter((entry) => matches(entry, filter) && (!since || Date.parse(entry.time) >= since));
}

async function readAppLog(limit: number, filter: LogFilter, since: number): Promise<LogEntry[]> {
  const file = files[filter.kind ?? 'logs'];
  if (!file) return [];
  const entries: LogEntry[] = [];
  for (const name of [`${file}.1`, file]) {
    const text = await readFile(name, 'utf8').catch(() => '');
    entries.push(...parseLines(text));
  }
  return entries.filter((entry) => matches(entry, filter) && (!since || Date.parse(entry.time) >= since)).slice(-limit);
}

// The key of a line, so a line that the app log and a file hold both shows once.
const lineKey = (entry: LogEntry) => `${entry.time}|${entry.level}|${entry.event ?? ''}|${entry.itemId ?? ''}|${entry.message}`;

// The log of a title joins its file, which holds the lines of the title and of its targets, with the older lines of the
// app log, which hold the waits before the first target of the title existed.
async function readTitleLog(limit: number, filter: LogFilter): Promise<LogEntry[]> {
  const titleKey = filter.itemId!;
  const since = startedAt(titleKey);
  const app = await readAppLog(limit, { ...filter, itemId: undefined, titleKey }, since);
  const file = (await readItemFile(titleKey))?.filter((entry) => matches(entry, { ...filter, itemId: undefined }) && (!since || Date.parse(entry.time) >= since)) ?? [];
  const seen = new Set<string>();
  const entries: LogEntry[] = [];
  for (const entry of [...app, ...file]) {
    const key = lineKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(entry);
  }
  return entries.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
}

export async function recentLogs(limit: number, filter: LogFilter = {}): Promise<LogEntry[]> {
  if (filter.itemId && (filter.kind ?? 'logs') === 'logs') {
    if (isTitleKey(filter.itemId)) return readTitleLog(limit, filter);
    const own = await readItemLog(filter.itemId, filter);
    if (own) return own;
  }
  const since = filter.itemId ? startedAt(filter.itemId) : 0;
  return readAppLog(limit, filter, since);
}
