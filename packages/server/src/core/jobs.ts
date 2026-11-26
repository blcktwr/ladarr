import { randomUUID } from 'node:crypto';
import { itemId } from '@ladarr/shared/queue';
import { db } from './db.ts';
import type { EnqueueInput, ErrorKind, Job } from '../types.ts';

// "invalid_input" never retries. "outage" retries later. "uncertain" retries too, and the
// handler must check the outside system first, because the last try may have had an effect.
export class JobError extends Error {
  kind: ErrorKind;
  constructor(kind: ErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 15 * 60_000;
const KEPT_FAILED = 200;

export const backoffMs = (attempts: number) => Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_MAX_MS);

const held = (job: Job | undefined, token: string): job is Job => job?.state === 'running' && job.leaseOwner === token;

// shortcut: dedupe and claim scan every job. Fine for thousands of jobs, so index by key if it is not.
export function enqueue(input: EnqueueInput): Job {
  const { jobs } = db.data;
  const runAt = input.runAt ?? Date.now();
  if (input.dedupeKey) {
    const active = Object.values(jobs).find((job) => job.dedupeKey === input.dedupeKey && job.state !== 'failed');
    if (active) {
      // A request for earlier work must not wait for the time of a scheduled run.
      if (active.state === 'waiting' && runAt < active.runAt) active.runAt = runAt;
      if (input.priority) prioritize(active.id);
      return active;
    }
  }
  const job: Job = {
    id: randomUUID(),
    type: input.type,
    payloadVersion: input.payloadVersion ?? 1,
    payload: input.payload ?? null,
    dedupeKey: input.dedupeKey ?? null,
    state: 'waiting',
    seq: db.data.jobSeq++,
    runAt,
    attempts: 0,
    leaseOwner: null,
    leaseExpiresAt: null,
    lastError: null,
    priority: null,
  };
  jobs[job.id] = job;
  if (input.priority) prioritize(job.id);
  return job;
}

// Priority jobs start first, in the order they were marked. Then the normal jobs, by due time.
function precedes(a: Job, b: Job) {
  if (a.priority !== null || b.priority !== null) {
    if (a.priority === null) return false;
    if (b.priority === null) return true;
    return a.priority < b.priority;
  }
  return a.runAt !== b.runAt ? a.runAt < b.runAt : a.seq < b.seq;
}

// The series and the season that a search job covers. A movie, a grab, or another job has none.
export function seasonOf(job: Job): { titleKey: string; season: number } | null {
  if (job.type !== 'queue.search') return null;
  const payload = job.payload as { titleKey?: unknown; season?: unknown } | null;
  if (typeof payload?.titleKey !== 'string' || typeof payload.season !== 'number') return null;
  return { titleKey: payload.titleKey, season: payload.season };
}

function turnOf(job: Job) {
  if (job.type !== 'queue.search') return;
  const payload = job.payload as { itemId?: unknown; titleKey?: unknown; season?: unknown } | null;
  if (typeof payload?.itemId === 'string') return db.data.queueItems[payload.itemId];
  if (typeof payload?.titleKey === 'string' && (typeof payload.season === 'number' || payload.season === null)) {
    return db.data.queueItems[itemId(payload.titleKey, payload.season)];
  }
}

// The check and the change run in one synchronous step, so two callers never get the same job.
export function claim(now: number, leaseMs: number, canStart: (job: Job) => boolean = () => true) {
  const due: Job[] = [];
  let best: Job | undefined;
  for (const job of Object.values(db.data.jobs)) {
    if (job.state !== 'waiting' || job.runAt > now) continue;
    const turn = turnOf(job);
    if (turn?.nextAt != null && turn.nextAt > now) continue;
    if (!canStart(job)) continue;
    due.push(job);
    if (!best || precedes(job, best)) best = job;
  }
  if (!best) return;
  // FIFO applies only to search turns. Other job types keep their place by due time.
  let turn = turnOf(best);
  if (turn) {
    for (const job of due) {
      const other = turnOf(job);
      if (!other) continue;
      const priority = turn.priority ?? best.priority ?? Infinity;
      const otherPriority = other.priority ?? job.priority ?? Infinity;
      if (otherPriority < priority || (otherPriority === priority && other.position < turn.position)) {
        best = job;
        turn = other;
      }
    }
  }
  best.state = 'running';
  best.attempts++;
  best.leaseOwner = randomUUID();
  best.leaseExpiresAt = now + leaseMs;
  return best;
}

// Only a lease that has expired is recovered. A job that keeps losing its lease runs out of attempts.
export function recoverExpired(now: number, maxAttempts: (type: string) => number) {
  let recovered = 0;
  for (const job of Object.values(db.data.jobs)) {
    if (job.state !== 'running' || job.leaseExpiresAt! > now) continue;
    recovered++;
    job.leaseOwner = null;
    job.leaseExpiresAt = null;
    if (job.attempts >= maxAttempts(job.type)) {
      job.lastError = { kind: 'uncertain', message: 'lease expired on the last attempt' };
      job.state = 'failed';
    } else {
      job.state = 'waiting';
    }
  }
  pruneFailed();
  return recovered;
}

export function renew(id: string, token: string, now: number, leaseMs: number) {
  const job = db.data.jobs[id];
  if (!held(job, token)) return false;
  job.leaseExpiresAt = now + leaseMs;
  return true;
}

export function complete(id: string, token: string) {
  if (!held(db.data.jobs[id], token)) return false;
  delete db.data.jobs[id];
  return true;
}

// Gives the job back after a stop. The interrupted try does not count as an attempt.
export function release(id: string, token: string) {
  const job = db.data.jobs[id];
  if (!held(job, token)) return false;
  job.state = 'waiting';
  job.attempts--;
  job.leaseOwner = null;
  job.leaseExpiresAt = null;
  return true;
}

export function fail(id: string, token: string, error: unknown, now: number, maxAttempts: number) {
  const job = db.data.jobs[id];
  if (!held(job, token)) return;
  const kind = error instanceof JobError ? error.kind : 'outage';
  job.lastError = { kind, message: error instanceof Error ? error.message : String(error) };
  job.leaseOwner = null;
  job.leaseExpiresAt = null;
  if (kind === 'invalid_input' || job.attempts >= maxAttempts) {
    job.state = 'failed';
    pruneFailed();
  } else {
    job.state = 'waiting';
    job.runAt = now + backoffMs(job.attempts);
  }
  return job.state;
}

export function prioritize(id: string) {
  const job = db.data.jobs[id];
  if (job && job.priority === null) job.priority = db.data.prioritySeq++;
}

// The job goes back to its place in the normal lane, because that lane orders by due time.
export function deprioritize(id: string) {
  const job = db.data.jobs[id];
  if (job) job.priority = null;
}

function pruneFailed() {
  const failed = Object.values(db.data.jobs).filter((job) => job.state === 'failed');
  for (const job of failed.sort((a, b) => b.seq - a.seq).slice(KEPT_FAILED)) delete db.data.jobs[job.id];
}
