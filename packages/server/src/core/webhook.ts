import type { WebhookTestResult } from '@ladarr/shared/types';
import { randomUUID } from 'node:crypto';
import type { MediaType, WebhookEventType } from '@ladarr/shared/enums';
import { db } from './db.ts';
import { outboundFetch } from './http.ts';
import { log } from './log.ts';
import type { QueueState } from '@ladarr/shared/queue';
import { reasonInfo } from './reasons.ts';
import type { DeliveryPayload, EventType, StateHook, WebhookDeps, WebhookEvent } from '../types.ts';

// Raise this number when a receiver must change to read the body of an event.
export const EVENT_SCHEMA_VERSION = 1;

export const DELIVER = 'webhook.deliver';
const TIMEOUT_MS = 10_000;
// With the backoff of the job engine, ten attempts cover an outage of about 36 minutes.
export const MAX_ATTEMPTS = 10;
// A long outage must not make an unlimited backlog.
const MAX_PENDING = 1_000;

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

// Makes the events and puts each one in a durable delivery job for each webhook of its type.
// Nothing here waits for the network.
export function createWebhooks({ enqueue, now = Date.now }: WebhookDeps) {
  function emit(type: WebhookEventType, fields: Parameters<typeof newEvent>[2]) {
    const targets = db.data.webhooks.filter((webhook) => webhook.type === type);
    if (!targets.length) return;
    // shortcut: this counts all jobs for each event. Fine for thousands of jobs, so keep a counter if it is not.
    let pending = Object.values(db.data.jobs).filter((job) => job.type === DELIVER && job.state !== 'failed').length;
    const event = newEvent(type, now(), fields);
    for (const target of targets) {
      if (pending >= MAX_PENDING) return void log.warn('webhook backlog is full, so an event is dropped', { eventType: type });
      enqueue({ type: DELIVER, payload: { webhookId: target.id, event } satisfies DeliveryPayload });
      pending++;
    }
  }

  // The hook of the queue. An error here must never reach the import.
  const onState: StateHook = (entry, before) => {
    try {
      const imported = entry.state.kind === 'available' && before.kind !== 'available';
      // A pause and a resume around the same problem is one blocking episode. A change of the problem text is not a
      // second one either.
      const blocked = entry.state.kind === 'blocked' && before.kind !== 'blocked' && before.kind !== 'paused';
      if (!imported && !blocked) return;
      const title = db.data.titles[entry.titleKey];
      const [mediaType, tmdbId] = entry.titleKey.split(':') as [MediaType, string];
      const fields = {
        title: { key: entry.titleKey, mediaType, name: title?.meta.title ?? null, year: title?.meta.year ?? null, ids: { tmdb: Number(tmdbId), tvdb: title?.meta.tvdbId ?? null, imdb: title?.meta.imdbId ?? null } },
        episode: entry.season === null || entry.number === null ? null : { season: entry.season, number: entry.number, name: title?.episodes.find((e) => e.season === entry.season && e.number === entry.number)?.name ?? null },
      };
      if (imported) emit('available', fields);
      else {
        const code = (entry.state as Extract<QueueState, { kind: 'blocked' }>).problem.code;
        emit('stuck', { ...fields, reason: { code, message: reasonInfo(code, fields.episode ? 'episode' : 'movie').message } });
      }
    } catch (error) {
      log.error('could not make a webhook event', { error });
    }
  };

  return { onState };
}
