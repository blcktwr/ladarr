import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/core/db.ts';
import { createWorker } from '../../src/core/worker.ts';
import { until } from '../helpers/test-pipeline.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('worker drain', () => {
  const newWorker = async (handlers: Parameters<typeof createWorker>[2], graceMs = 2_000) => {
    const db = await openDb('unused.json');
    const worker = createWorker(db, async () => {}, handlers, { tickMs: 10, graceMs });
    worker.start();
    return { db, worker };
  };

  it('starts no new job while it drains, and starts them again after the resume', async () => {
    const started: string[] = [];
    let release!: () => void;
    const { worker } = await newWorker({
      a: {
        concurrency: 2,
        run: () => {
          started.push('a');
          return started.length === 1 ? new Promise<void>((resolve) => (release = resolve)) : Promise.resolve();
        },
      },
    });
    worker.enqueue({ type: 'a' });
    await until(() => started.length === 1);

    const drained = worker.drain();
    worker.enqueue({ type: 'a', dedupeKey: 'other' });
    await sleep(60);
    expect(started).toEqual(['a']);

    release();
    await drained;
    worker.resume();
    await until(() => started.length === 2);
    await worker.stop();
  });

  it('waits for the running job and does not abort it', async () => {
    let release!: () => void;
    let aborted = false;
    const { db, worker } = await newWorker({
      a: {
        run: (_job, { signal }) => {
          signal.addEventListener('abort', () => (aborted = true));
          return new Promise<void>((resolve) => (release = resolve));
        },
      },
    });
    const job = worker.enqueue({ type: 'a' });
    await until(() => release !== undefined);

    let settled = false;
    const drained = worker.drain().then(() => (settled = true));
    await sleep(40);
    expect(settled).toBe(false);
    expect(aborted).toBe(false);

    release();
    await drained;
    expect(aborted).toBe(false);
    // The job completed as usual, so its record is gone and not waiting again.
    expect(db.data.jobs[job.id]).toBeUndefined();
    await worker.stop();
  });

  it('resolves at once when no job runs', async () => {
    const { worker } = await newWorker({});
    await expect(worker.drain()).resolves.toBeUndefined();
    await worker.stop();
  });

  it('keeps the heartbeat moving while it is drained', async () => {
    const { worker } = await newWorker({});
    await worker.drain();
    const before = worker.heartbeat;
    await sleep(40);
    expect(worker.heartbeat).toBeGreaterThan(before);
    await worker.stop();
  });

  it('waits for a job that ignores the signal past the grace time', async () => {
    let finish!: () => void;
    const { db, worker } = await newWorker({ a: { run: () => new Promise<void>((resolve) => (finish = resolve)) } }, 40);
    const job = worker.enqueue({ type: 'a' });
    await until(() => finish !== undefined);

    let settled = false;
    const drained = worker.drain().then(() => (settled = true));
    // The handler ends after the grace time, and the drain still waits.
    await sleep(80);
    expect(settled).toBe(false);
    expect(db.data.jobs[job.id]!.state).toBe('running');

    finish();
    await drained;
    expect(db.data.jobs[job.id]).toBeUndefined();
    await worker.stop();
  });
});
