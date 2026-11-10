import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSaver, emptyData, open, set, type Data } from '../../src/core/db.ts';
import { backoffMs, claim, complete, deprioritize, enqueue, fail, JobError, prioritize, recoverExpired } from '../../src/core/jobs.ts';
import { createWorker } from '../../src/core/worker.ts';

const LEASE = 60_000;
// The tests pass their own clock to the job functions, so jobs are due at time 0 unless a test says else.
const add = (input: Parameters<typeof enqueue>[0]) => enqueue({ runAt: 0, ...input });
const newDb = () => open('unused.json');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await sleep(10);
  expect(check()).toBe(true);
};

describe('claim', () => {
  it('gives one job to only one of two claims', async () => {
    const db = await newDb();
    add({ type: 'a' });
    const claims = [claim(Date.now(), LEASE), claim(Date.now(), LEASE)];
    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it('does not claim a job before its time', async () => {
    const db = await newDb();
    add({ type: 'a', runAt: 5_000 });
    expect(claim(4_999, LEASE)).toBeUndefined();
    expect(claim(5_000, LEASE)).toBeDefined();
  });

  it('coalesces jobs with the same key and keeps the earlier time', async () => {
    const db = await newDb();
    const first = add({ type: 'a', dedupeKey: 'a:1', runAt: 9_000 });
    expect(add({ type: 'a', dedupeKey: 'a:1', runAt: 1_000 }).id).toBe(first.id);
    expect(Object.keys(db.data.jobs)).toHaveLength(1);
    expect(first.runAt).toBe(1_000);
  });
});

describe('leases', () => {
  it('recovers an expired lease and leaves a valid one', async () => {
    const db = await newDb();
    const expired = add({ type: 'a' });
    const valid = add({ type: 'a' });
    claim(0, 1_000);
    claim(900, LEASE);
    expect(recoverExpired(1_000, () => 5)).toBe(1);
    expect(db.data.jobs[expired.id]!.state).toBe('waiting');
    expect(db.data.jobs[valid.id]!.state).toBe('running');
  });

  it('fails a job whose lease keeps expiring', async () => {
    const db = await newDb();
    const job = add({ type: 'a' });
    claim(0, 1_000);
    recoverExpired(1_000, () => 1);
    expect(db.data.jobs[job.id]!.state).toBe('failed');
  });

  it('ignores a result from a holder that lost the lease', async () => {
    const db = await newDb();
    const job = add({ type: 'a' });
    const stale = claim(0, 1_000)!.leaseOwner!;
    recoverExpired(1_000, () => 5);
    claim(1_000, LEASE);
    expect(complete(job.id, stale)).toBe(false);
    expect(db.data.jobs[job.id]!.state).toBe('running');
  });
});

describe('failures', () => {
  it('retries an outage with backoff and stops at the attempt limit', async () => {
    const db = await newDb();
    const job = add({ type: 'a' });
    const token = claim(0, LEASE)!.leaseOwner!;
    expect(fail(job.id, token, new Error('down'), 0, 2)).toBe('waiting');
    expect(db.data.jobs[job.id]!.runAt).toBe(backoffMs(1));
    expect(claim(backoffMs(1) - 1, LEASE)).toBeUndefined();
    const second = claim(backoffMs(1), LEASE)!.leaseOwner!;
    expect(fail(job.id, second, new Error('down'), 0, 2)).toBe('failed');
  });

  it('does not retry invalid input', async () => {
    const db = await newDb();
    const job = add({ type: 'a' });
    const token = claim(0, LEASE)!.leaseOwner!;
    expect(fail(job.id, token, new JobError('invalid_input', 'bad'), 0, 5)).toBe('failed');
    expect(db.data.jobs[job.id]!.lastError).toEqual({ kind: 'invalid_input', message: 'bad' });
  });
});

describe('priority', () => {
  it('starts marked jobs first, in mark order, before older normal jobs', async () => {
    const db = await newDb();
    const normal = add({ type: 'a', runAt: 1 });
    const [a, b, c] = ['A', 'B', 'C'].map((name) => add({ type: 'a', payload: name, runAt: 2 }));
    prioritize(c!.id);
    prioritize(a!.id);
    prioritize(b!.id);
    const order = [1, 2, 3, 4].map(() => claim(10, LEASE)!.id);
    expect(order).toEqual([c!.id, a!.id, b!.id, normal.id]);
  });

  it('returns a job to its place in the normal lane', async () => {
    const db = await newDb();
    const first = add({ type: 'a', runAt: 1 });
    const second = add({ type: 'a', runAt: 2 });
    prioritize(second.id);
    deprioritize(second.id);
    expect(claim(10, LEASE)!.id).toBe(first.id);
  });

  it('keeps jobs and lane order after a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ladarr-'));
    try {
      const file = join(dir, 'db.json');
      const before = new Low<Data>(new JSONFile(file), emptyData());
      set(before);
      const [x, y] = ['x', 'y'].map((name) => add({ type: 'a', payload: name }));
      add({ type: 'a', runAt: 0 });
      prioritize(y!.id);
      prioritize(x!.id);
      await before.write();

      const after = new Low<Data>(new JSONFile(file), emptyData());
      await after.read();
      set(after);
      expect([claim(10, LEASE)!.id, claim(10, LEASE)!.id]).toEqual([y!.id, x!.id]);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe('saver', () => {
  it('writes the file once for many changes in the same tick', async () => {
    const db = await newDb();
    const write = vi.spyOn(db, 'write');
    const save = createSaver();
    await Promise.all(Array.from({ length: 100 }, () => save()));
    expect(write).toHaveBeenCalledTimes(1);
  });
});

describe('worker heartbeat', () => {
  it('moves with each tick', async () => {
    const db = await newDb();
    const worker = createWorker(createSaver(), {}, { tickMs: 10 });
    const first = worker.heartbeat;
    worker.start();
    await sleep(40);
    const second = worker.heartbeat;
    await worker.stop();
    expect(second).toBeGreaterThan(first);
  });
});

describe('worker', () => {
  let stop: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await stop?.();
    stop = undefined;
  });

  it('runs a job once and removes it', async () => {
    const db = await newDb();
    const run = vi.fn(async () => {});
    const worker = createWorker(createSaver(), { a: { run } }, { tickMs: 10 });
    stop = worker.stop;
    worker.start();
    worker.enqueue({ type: 'a', payload: { n: 1 } });
    await until(() => run.mock.calls.length > 0 && Object.keys(db.data.jobs).length === 0);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('limits the jobs of one type that run at the same time', async () => {
    const db = await newDb();
    let active = 0;
    let peak = 0;
    let finished = 0;
    const run = async () => {
      peak = Math.max(peak, ++active);
      await sleep(30);
      active--;
      finished++;
    };
    const worker = createWorker(createSaver(), { a: { run, concurrency: 2 } }, { tickMs: 10 });
    stop = worker.stop;
    worker.start();
    for (let i = 0; i < 6; i++) worker.enqueue({ type: 'a', dedupeKey: `a:${i}` });
    await until(() => finished === 6);
    expect(peak).toBe(2);
  });

  it('schedules a recurring job again after each run, but only one at a time', async () => {
    const db = await newDb();
    const run = vi.fn(async () => {});
    const worker = createWorker(createSaver(), { poll: { run, every: 20 } }, { tickMs: 10 });
    stop = worker.stop;
    worker.start();
    await until(() => run.mock.calls.length >= 3);
    expect(Object.keys(db.data.jobs).length).toBeLessThanOrEqual(1);
  });

  it('gives an interrupted job back without counting the attempt', async () => {
    const db = await newDb();
    let started = false;
    const run = (_job: unknown, { signal }: { signal: AbortSignal }) =>
      new Promise<void>((_, reject) => {
        started = true;
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const worker = createWorker(createSaver(), { a: { run } }, { tickMs: 10 });
    worker.start();
    worker.enqueue({ type: 'a' });
    await until(() => started);
    await worker.stop();
    const [job] = Object.values(db.data.jobs);
    expect(job).toMatchObject({ state: 'waiting', attempts: 0, leaseOwner: null });
  });

  it('cancels one job and leaves the others', async () => {
    const db = await newDb();
    let started = false;
    let aborted = false;
    const slow = (_job: unknown, { signal }: { signal: AbortSignal }) =>
      new Promise<void>((_, reject) => {
        started = true;
        signal.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted'));
        });
      });
    const other = vi.fn(async () => {});
    const worker = createWorker(createSaver(), { a: { run: slow, concurrency: 2 }, b: { run: other } }, { tickMs: 10 });
    stop = worker.stop;
    worker.start();
    const job = worker.enqueue({ type: 'a' });
    worker.enqueue({ type: 'b' });
    await until(() => started && other.mock.calls.length === 1);

    expect(worker.cancel(job.id)).toBe(true);
    await until(() => aborted);
    expect(db.data.jobs[job.id]).toBeUndefined();
    expect(db.data.jobs).toEqual({});
  });

  it('retries a failing job later and keeps its payload', async () => {
    const db = await newDb();
    const run = vi.fn(async () => {
      throw new JobError('outage', 'provider down');
    });
    const worker = createWorker(createSaver(), { a: { run } }, { tickMs: 10 });
    stop = worker.stop;
    worker.start();
    worker.enqueue({ type: 'a', payload: { id: 7 } });
    await until(() => run.mock.calls.length === 1 && Object.values(db.data.jobs)[0]?.state === 'waiting');
    const [job] = Object.values(db.data.jobs);
    expect(job).toMatchObject({ payload: { id: 7 }, attempts: 1, lastError: { kind: 'outage' } });
    expect(job!.runAt).toBeGreaterThan(Date.now());
  });

  it('holds the queue work while the user paused the queue, and starts it again', async () => {
    const db = await newDb();
    const queueRun = vi.fn(async () => {});
    const backupRun = vi.fn(async () => {});
    const worker = createWorker(createSaver(), { 'queue.search': { run: queueRun }, 'backup.auto': { run: backupRun } }, { tickMs: 10 });
    stop = worker.stop;
    db.data.queuePaused = true;
    worker.start();
    worker.enqueue({ type: 'queue.search', dedupeKey: 'search' });
    worker.enqueue({ type: 'backup.auto', dedupeKey: 'backup' });
    // The backup still runs, and the queue waits.
    await until(() => backupRun.mock.calls.length === 1);
    expect(queueRun).not.toHaveBeenCalled();
    // The queue starts when the person starts it again.
    db.data.queuePaused = false;
    await until(() => queueRun.mock.calls.length === 1);
  });
});
