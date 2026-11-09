import { randomUUID } from 'node:crypto';
import type { Db } from './db.ts';

export type ErrorKind = 'invalid_input' | 'outage' | 'uncertain';

// "invalid_input" never retries. "outage" retries later. "uncertain" retries too, and the
// handler must check the outside system first, because the last try may have had an effect.
export class JobError extends Error {
  kind: ErrorKind;
  constructor(kind: ErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

export type Job = {
  id: string;
  type: string;
  payloadVersion: number;
  payload: unknown;
  dedupeKey: string | null;
  state: 'waiting' | 'running' | 'failed';
  seq: number;
  runAt: number;
  attempts: number;
  // A new token for each claim, so a stale holder cannot finish a job that was recovered.
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  lastError: { kind: ErrorKind; message: string } | null;
  priority: number | null;
};

export type EnqueueInput = {
  type: string;
  payload?: unknown;
  payloadVersion?: number;
  dedupeKey?: string;
  runAt?: number;
  priority?: boolean;
};

const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 15 * 60_000;
const KEPT_FAILED = 200;

export const backoffMs = (attempts: number) => Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_MAX_MS);

const held = (job: Job | undefined, token: string): job is Job => job?.state === 'running' && job.leaseOwner === token;

// shortcut: dedupe and claim scan every job. Fine for thousands of jobs, so index by key if it is not.
export function enqueue(db: Db, input: EnqueueInput): Job {
  const { jobs } = db.data;
  const runAt = input.runAt ?? Date.now();
  if (input.dedupeKey) {
    const active = Object.values(jobs).find((job) => job.dedupeKey === input.dedupeKey && job.state !== 'failed');
    if (active) {
      // A request for earlier work must not wait for the time of a scheduled run.
      if (active.state === 'waiting' && runAt < active.runAt) active.runAt = runAt;
      if (input.priority) prioritize(db, active.id);
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
  if (input.priority) prioritize(db, job.id);
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

// The check and the change run in one synchronous step, so two callers never get the same job.
export function claim(db: Db, now: number, leaseMs: number, canStart: (job: Job) => boolean = () => true) {
  let best: Job | undefined;
  for (const job of Object.values(db.data.jobs)) {
    if (job.state !== 'waiting' || job.runAt > now || !canStart(job)) continue;
    if (!best || precedes(job, best)) best = job;
  }
  if (!best) return;
  best.state = 'running';
  best.attempts++;
  best.leaseOwner = randomUUID();
  best.leaseExpiresAt = now + leaseMs;
  return best;
}

// Only a lease that has expired is recovered. A job that keeps losing its lease runs out of attempts.
export function recoverExpired(db: Db, now: number, maxAttempts: (type: string) => number) {
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
  pruneFailed(db);
  return recovered;
}

export function renew(db: Db, id: string, token: string, now: number, leaseMs: number) {
  const job = db.data.jobs[id];
  if (!held(job, token)) return false;
  job.leaseExpiresAt = now + leaseMs;
  return true;
}

export function complete(db: Db, id: string, token: string) {
  if (!held(db.data.jobs[id], token)) return false;
  delete db.data.jobs[id];
  return true;
}

// Gives the job back after a stop. The interrupted try does not count as an attempt.
export function release(db: Db, id: string, token: string) {
  const job = db.data.jobs[id];
  if (!held(job, token)) return false;
  job.state = 'waiting';
  job.attempts--;
  job.leaseOwner = null;
  job.leaseExpiresAt = null;
  return true;
}

export function fail(db: Db, id: string, token: string, error: unknown, now: number, maxAttempts: number) {
  const job = db.data.jobs[id];
  if (!held(job, token)) return;
  const kind = error instanceof JobError ? error.kind : 'outage';
  job.lastError = { kind, message: error instanceof Error ? error.message : String(error) };
  job.leaseOwner = null;
  job.leaseExpiresAt = null;
  if (kind === 'invalid_input' || job.attempts >= maxAttempts) {
    job.state = 'failed';
    pruneFailed(db);
  } else {
    job.state = 'waiting';
    job.runAt = now + backoffMs(job.attempts);
  }
  return job.state;
}

export function prioritize(db: Db, id: string) {
  const job = db.data.jobs[id];
  if (job && job.priority === null) job.priority = db.data.prioritySeq++;
}

// The job goes back to its place in the normal lane, because that lane orders by due time.
export function deprioritize(db: Db, id: string) {
  const job = db.data.jobs[id];
  if (job) job.priority = null;
}

function pruneFailed(db: Db) {
  const failed = Object.values(db.data.jobs).filter((job) => job.state === 'failed');
  for (const job of failed.sort((a, b) => b.seq - a.seq).slice(KEPT_FAILED)) delete db.data.jobs[job.id];
}
