import { claim, complete, enqueue, fail, recoverExpired, release, renew, type EnqueueInput, type Job } from './jobs.ts';
import { db } from './db.ts';
import { log } from './log.ts';
import { withOutboundRequests } from './outbound.ts';

export type Handler = {
  run: (job: Job, ctx: { signal: AbortSignal }) => Promise<void>;
  // Most jobs of this type that run at the same time.
  concurrency?: number;
  // Does not take a slot of the shared limit, so a slow job of this type never makes other work wait.
  separate?: boolean;
  // A job of this type waits while the handler says no. The worker asks again at each start of work.
  canStart?: (job: Job) => boolean;
  maxAttempts?: number;
  // Run again this many ms after each final result. A job still waiting or running holds the next run back.
  every?: number;
};

type Options = { tickMs?: number; leaseMs?: number; concurrency?: number; graceMs?: number };

// The queue stops while the user pauses it. A backup, a scan or a metadata refresh still runs.
// The first job of a title is not held, because it only adds the entries and the search jobs to the queue, with no request to an indexer. It gives the queue rows before the resume.
const queueWork = (type: string) => (type.startsWith('queue.') && type !== 'queue.initial') || type === 'import.run';

export function createWorker(
  save: () => Promise<void>,
  handlers: Record<string, Handler>,
  { tickMs = 1_000, leaseMs = 60_000, concurrency = 4, graceMs = 10_000 }: Options = {},
) {
  const inflight = new Map<string, { job: Job; token: string; controller: AbortController; done: Promise<void> }>();
  let stopping = false;
  let paused = false;
  let lastTick = Date.now();
  let tickTimer: NodeJS.Timeout | undefined;
  let leaseTimer: NodeJS.Timeout | undefined;

  const maxAttempts = (type: string) => handlers[type]?.maxAttempts ?? 5;
  const persist = () => void save().catch((err) => log.error('could not save the database', { error: err }));
  const running = (type: string) => [...inflight.values()].filter((entry) => entry.job.type === type).length;

  function finish(job: Job, token: string, controller: AbortController, outcome: { error: unknown } | null) {
    const now = Date.now();
    let final = true;
    if (!outcome) complete(job.id, token);
    else if (controller.signal.aborted) {
      release(job.id, token);
      final = false;
    } else {
      final = fail(job.id, token, outcome.error, now, maxAttempts(job.type)) === 'failed';
    }
    const every = handlers[job.type]?.every;
    if (final && every && !stopping) enqueue({ type: job.type, dedupeKey: job.type, runAt: now + every });
  }

  function start(job: Job) {
    const token = job.leaseOwner!;
    const controller = new AbortController();
    const done = (async () => {
      let outcome: { error: unknown } | null = null;
      try {
        await withOutboundRequests(() => handlers[job.type]!.run(structuredClone(job), { signal: controller.signal }));
      } catch (error) {
        outcome = { error };
      }
      inflight.delete(job.id);
      finish(job, token, controller, outcome);
      persist();
      if (!stopping) setImmediate(tick);
    })();
    inflight.set(job.id, { job, token, controller, done });
  }

  function tick() {
    if (stopping) return;
    lastTick = Date.now();
    if (paused) return;
    const now = Date.now();
    let changed = recoverExpired(now, maxAttempts) > 0;
    const shared = () => [...inflight.values()].filter((entry) => !handlers[entry.job.type]?.separate).length;
    const canStart = (job: Job) => {
      const handler = handlers[job.type];
      return Boolean(handler) && running(job.type) < (handler!.concurrency ?? 1) && (handler!.canStart?.(job) ?? true) && (handler!.separate || shared() < concurrency) && (!db.data.queuePaused || !queueWork(job.type));
    };
    // Each claim fills a slot, so the loop ends.
    for (let job = claim(now, leaseMs, canStart); job; job = claim(now, leaseMs, canStart)) {
      start(job);
      changed = true;
    }
    if (changed) persist();
  }

  // A job of each periodic type must wait in the data. A start or a resume makes sure of that.
  function schedulePeriodic() {
    for (const [type, handler] of Object.entries(handlers)) {
      if (handler.every) enqueue({ type, dedupeKey: type });
    }
    persist();
  }

  return {
    // Time of the last tick. A tick that does not come means the event loop is blocked or the timer stopped.
    get heartbeat() {
      return lastTick;
    },

    start() {
      schedulePeriodic();
      tick();
      tickTimer = setInterval(tick, tickMs);
      leaseTimer = setInterval(() => {
        for (const { job, token } of inflight.values()) renew(job.id, token, Date.now(), leaseMs);
      }, leaseMs / 3);
    },

    enqueue(input: EnqueueInput) {
      const job = enqueue(input);
      persist();
      setImmediate(tick);
      return job;
    },

    // Stops a job of a title that left the library. A running handler ends at its next check, and the job record
    // goes at once, so the queue does not show work that nothing owns.
    cancel(id: string) {
      const entry = inflight.get(id);
      if (entry) entry.controller.abort();
      delete db.data.jobs[id];
      persist();
      setImmediate(tick);
      return Boolean(entry);
    },

    // Starts no new job, asks the running jobs to stop, and waits for them. Returns false if a job is still running after the grace time.
    // The data must not change under a job, so a caller that needs this must not go on when it gets false.
    async pause() {
      paused = true;
      for (const { controller } of inflight.values()) controller.abort();
      let timer: NodeJS.Timeout;
      const timeout = new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), graceMs)));
      const idle = await Promise.race([Promise.all([...inflight.values()].map((entry) => entry.done)).then(() => true as const), timeout]);
      clearTimeout(timer!);
      return idle;
    },

    // The data can be new after a pause, so the periodic jobs are checked again.
    resume() {
      paused = false;
      schedulePeriodic();
      setImmediate(tick);
    },

    // Starts no new job and waits for the running ones to end. It does not stop them, so a job that copies a
    // file keeps its work. The caller resumes the queue when it does not go on with the restart.
    async drain() {
      paused = true;
      await Promise.allSettled([...inflight.values()].map((entry) => entry.done));
    },

    // Handlers that ignore the signal keep their lease. Another start recovers them after it expires.
    async stop() {
      stopping = true;
      clearInterval(tickTimer);
      clearInterval(leaseTimer);
      for (const { controller } of inflight.values()) controller.abort();
      let timer: NodeJS.Timeout;
      const timeout = new Promise((resolve) => (timer = setTimeout(resolve, graceMs)));
      await Promise.race([Promise.all([...inflight.values()].map((entry) => entry.done)), timeout]);
      clearTimeout(timer!);
      await save();
    },
  };
}
