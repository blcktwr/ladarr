import type { Problem, WebhookTestResult } from '@ladarr/shared/types';
import { randomUUID } from 'node:crypto';
import type { MediaType } from '@ladarr/shared/enums';
import { Router } from 'express';
import type { Db } from '../core/db.ts';
import type { EnqueueInput } from '../core/jobs.ts';
import { outboundFetch } from '../core/http.ts';
import { log } from '../core/log.ts';
import { withOutboundRequests } from '../core/outbound.ts';
import type { MoveHook } from '../downloads/queue.ts';
import { reasonInfo } from '../core/reasons.ts';

// Raise this number when a receiver must change to read the body of an event.
export const EVENT_SCHEMA_VERSION = 1;

// The address is a secret, because it can hold a token. It never goes to a log or to an API answer.
// `health` holds the problems of the last check, as ID and message. It is null until the first check.
export type WebhookState = { url: string | null; health: Record<string, string> | null };

export type EventType = 'import_complete' | 'needs_attention' | 'health_restored' | 'test';

export type WebhookEvent = {
  schemaVersion: typeof EVENT_SCHEMA_VERSION;
  id: string;
  type: EventType;
  timestamp: string;
  title: { key: string; mediaType: MediaType; name: string | null; year: number | null; ids: { tmdb: number; tvdb: number | null; imdb: string | null } } | null;
  episode: { season: number; number: number; name: string | null } | null;
  reason: { code: string; message: string } | null;
  problem: { id: string; message: string } | null;
};

export const DELIVER = 'webhook.deliver';
const TIMEOUT_MS = 10_000;
// With the backoff of the job engine, ten attempts cover an outage of about 36 minutes.
export const MAX_ATTEMPTS = 10;
// A long outage must not make an unlimited backlog.
const MAX_PENDING = 1_000;
const HEALTH_EVERY_MS = 60_000;

export const newEvent = (type: EventType, now: number, fields: Partial<Pick<WebhookEvent, 'title' | 'episode' | 'reason' | 'problem'>> = {}): WebhookEvent => ({
  schemaVersion: EVENT_SCHEMA_VERSION,
  id: randomUUID(),
  type,
  timestamp: new Date(now).toISOString(),
  title: null,
  episode: null,
  reason: null,
  problem: null,
  ...fields,
});

// One try. It follows no redirect, so the body goes only to the address that the user saved.
export async function send(url: string, event: WebhookEvent, { signal, timeoutMs = TIMEOUT_MS }: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<WebhookTestResult> {
  try {
    const res = await outboundFetch('Webhook', fetch, { path: '[hidden]', query: false })(url, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/json', 'user-agent': 'ladarr', 'x-ladarr-event-id': event.id, 'x-ladarr-event-type': event.type },
      body: JSON.stringify(event),
      signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
    });
    await res.body?.cancel();
    return res.ok ? { ok: true } : { ok: false, code: 'rejected', status: res.status };
  } catch {
    // The error can hold the address, so it goes no further.
    return { ok: false, code: 'unreachable', status: null };
  }
}

type Deps = {
  db: Db;
  enqueue: (input: EnqueueInput) => unknown;
  persist: () => void;
  // The current health problems. The same list as the health page.
  problems: () => Promise<Problem[]>;
  intervalMs?: number;
  now?: () => number;
};

// Makes the events and puts each one in a durable delivery job. Nothing here waits for the network.
export function createWebhooks({ db, enqueue, persist, problems, intervalMs = HEALTH_EVERY_MS, now = Date.now }: Deps) {
  function emit(type: EventType, fields: Parameters<typeof newEvent>[2]) {
    if (!db.data.webhook.url) return;
    // shortcut: this counts all jobs for each event. Fine for thousands of jobs, so keep a counter if it is not.
    const pending = Object.values(db.data.jobs).filter((job) => job.type === DELIVER && job.state !== 'failed').length;
    if (pending >= MAX_PENDING) return void log.warn('webhook backlog is full, so an event is dropped', { eventType: type });
    enqueue({ type: DELIVER, payload: newEvent(type, now(), fields) });
  }

  // The hook of the queue. An error here must never reach the import.
  const onMove: MoveHook = (entry, before) => {
    try {
      const imported = entry.stage === 'available' && before.stage !== 'available';
      const blocked = entry.branch === null && entry.reason !== null && before.reason === null;
      if (!imported && !blocked) return;
      const title = db.data.titles[entry.titleKey];
      const [mediaType, tmdbId] = entry.titleKey.split(':') as [MediaType, string];
      const fields = {
        title: { key: entry.titleKey, mediaType, name: title?.meta.title ?? null, year: title?.meta.year ?? null, ids: { tmdb: Number(tmdbId), tvdb: title?.meta.tvdbId ?? null, imdb: title?.meta.imdbId ?? null } },
        episode: entry.season === null || entry.number === null ? null : { season: entry.season, number: entry.number, name: title?.episodes.find((e) => e.season === entry.season && e.number === entry.number)?.name ?? null },
      };
      if (imported) emit('import_complete', fields);
      else {
        const code = entry.reason?.code ?? 'unknown';
        emit('needs_attention', { ...fields, reason: { code, message: reasonInfo(code).message } });
      }
    } catch (error) {
      log.error('could not make a webhook event', { error });
    }
  };

  let checking = false;
  // The first check sets the baseline. A later check sends one event for each problem that is gone.
  async function checkHealth() {
    if (checking || !db.data.webhook.url) return;
    checking = true;
    try {
      // The webhook schema holds plain text, so the template of the problem is filled here.
      const text = (problem: Problem) =>
        problem.message.replace(/\{(\w+)\}/g, (_, name: string) => String(problem.params?.[name] ?? `{${name}}`));
      const found = Object.fromEntries((await problems()).map((problem) => [problem.id, text(problem)]));
      const state = db.data.webhook;
      if (!state.url) return;
      const previous = state.health;
      if (previous && JSON.stringify(Object.keys(previous)) === JSON.stringify(Object.keys(found))) return;
      state.health = found;
      persist();
      for (const [id, message] of Object.entries(previous ?? {})) if (!(id in found)) emit('health_restored', { problem: { id, message } });
    } catch (error) {
      log.warn('could not check the health for webhook events', { error });
    } finally {
      checking = false;
    }
  }

  let timer: NodeJS.Timeout | undefined;
  return {
    onMove,
    checkHealth,
    start() {
      timer = setInterval(() => void withOutboundRequests(checkHealth), intervalMs);
      timer.unref();
    },
    stop() {
      clearInterval(timer);
    },
  };
}

// The address must be http or https, and it must have no user name or password. Returns it, or nothing.
function parseUrl(value: unknown) {
  if (typeof value !== 'string' || value.length > 2_000) return;
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;
    return url.href;
  } catch {}
}

// The user sees the host of the destination. The rest of the address can hold a token.
const view = (url: string | null) => (url ? { host: new URL(url).host } : null);

export function webhookRouter(db: Db, { timeoutMs }: { timeoutMs?: number } = {}) {
  const router = Router();

  router.get('/', (_req, res) => void res.json({ webhook: view(db.data.webhook.url) }));

  router.put('/', async (req, res) => {
    const url = parseUrl(req.body?.url);
    if (!url) return void res.status(400).json({ error: 'invalid_setting', field: 'url' });
    db.data.webhook = { url, health: null };
    await db.write();
    res.json({ webhook: view(url) });
  });

  // The events that wait go with the destination. A new destination must not get them.
  router.delete('/', async (_req, res) => {
    db.data.webhook = { url: null, health: null };
    for (const job of Object.values(db.data.jobs)) if (job.type === DELIVER) delete db.data.jobs[job.id];
    await db.write();
    res.json({ webhook: null });
  });

  // Sends a test event to the address in the body, or to the saved address. It saves nothing.
  router.post('/test', async (req, res) => {
    const given = req.body?.url;
    const url = given === undefined ? db.data.webhook.url : parseUrl(given);
    if (given !== undefined && !url) return void res.status(400).json({ error: 'invalid_setting', field: 'url' });
    if (!url) return void res.status(409).json({ error: 'webhook_missing' });
    const result = await send(url, newEvent('test', Date.now()), { timeoutMs });
    res.json(result);
  });

  return router;
}
