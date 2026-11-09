import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Problem } from '@ladarr/shared/types';
import { emptyData, openDb, type Db } from '../../src/core/db.ts';
import { createEvents } from '../../src/core/events.ts';
import { enqueue as enqueueJob } from '../../src/core/jobs.ts';
import { closeLog, logToFile, recentLogs } from '../../src/core/log.ts';
import { createQueue } from '../../src/downloads/queue.ts';
import { episode, movie, NOW, title } from '../helpers/test-fixtures.ts';
import { startTestApp } from '../helpers/test-app.ts';
import { MIB, startPipeline, until } from '../helpers/test-pipeline.ts';
import { createWebhooks, MAX_ATTEMPTS, type WebhookEvent } from '../../src/integrations/webhook.ts';
import { webhookDeliverHandler } from '../../src/jobs/webhook-deliver.ts';
import { createWorker } from '../../src/core/worker.ts';

type Seen = { path: string; headers: IncomingHttpHeaders; body: WebhookEvent };

// A receiver on a local port. `respond` gets the number of the request and returns a status, or "hang" for no answer.
async function startReceiver() {
  const state = { seen: [] as Seen[], respond: (_n: number): number | 'hang' => 200 };
  const server: Server = createServer((req, res) => {
    let text = '';
    req.on('data', (chunk) => (text += chunk));
    req.on('end', () => {
      state.seen.push({ path: req.url!, headers: req.headers, body: JSON.parse(text) });
      const answer = state.respond(state.seen.length);
      if (answer === 'hang') return;
      res.writeHead(answer, answer >= 300 && answer < 400 ? { location: 'http://127.0.0.1:1/elsewhere' } : {}).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    state,
    port,
    url: `http://127.0.0.1:${port}/hook/token`,
    dropConnections: () => server.closeAllConnections(),
    close() {
      server.closeAllConnections();
      server.close();
    },
  };
}

const closers: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

const jobsOf = (db: Db) => Object.values(db.data.jobs).filter((job) => job.type === 'webhook.deliver');
const eventsOf = (db: Db) => jobsOf(db).map((job) => job.payload as WebhookEvent);

// Events go to jobs, without a worker. The problems come from `state.problems`.
async function collect(destination: string | null = 'http://receiver.test/hook') {
  const db = await openDb('unused.json');
  Object.assign(db.data, emptyData());
  db.data.webhook.url = destination;
  const state = { problems: [] as Problem[] };
  const webhooks = createWebhooks({ db, persist() {}, enqueue: (input) => enqueueJob(db, input), problems: async () => state.problems, now: () => NOW });
  const queue = createQueue(db, createEvents(), () => {}, webhooks.onMove);
  return { db, state, webhooks, queue };
}

const problem = (id: string, message = `Problem ${id}.`): Problem => ({ id, message, action: 'Do it.' });

describe('events', () => {
  it('sends import complete for a movie and for an episode with the shared schema', async () => {
    const { db, queue } = await collect();
    db.data.titles['movie:2'] = movie();
    db.data.titles['tv:1'] = title({ episodes: [episode(1, 2)] });
    queue.move(queue.ensure('movie:2', null, null), { stage: 'available' }, 'imported');
    queue.move(queue.ensure('tv:1', 1, 2), { stage: 'available' }, 'imported');

    const base = { schemaVersion: 1, id: expect.any(String), type: 'import_complete', timestamp: '2024-06-01T00:00:00.000Z', reason: null, problem: null };
    expect(eventsOf(db)).toEqual([
      { ...base, title: { key: 'movie:2', mediaType: 'movie', name: 'Movie Name', year: 2019, ids: { tmdb: 2, tvdb: null, imdb: null } }, episode: null },
      { ...base, title: { key: 'tv:1', mediaType: 'tv', name: 'Show Name', year: 2020, ids: { tmdb: 1, tvdb: 55, imdb: null } }, episode: { season: 1, number: 2, name: 'Episode 2' } },
    ]);
    expect(new Set(eventsOf(db).map((event) => event.id)).size).toBe(2);
  });

  it('sends needs attention once for each time that an entry stops, with the reason', async () => {
    const { db, queue } = await collect();
    db.data.titles['movie:2'] = movie();
    const entry = queue.ensure('movie:2', null, null);
    queue.move(entry, { reason: { code: 'file_not_found' } }, 'import blocked');
    queue.move(entry, { reason: { code: 'file_unreadable' } }, 'import blocked');
    expect(eventsOf(db)).toHaveLength(1);
    expect(eventsOf(db)[0]).toMatchObject({ type: 'needs_attention', title: { key: 'movie:2' }, reason: { code: 'file_not_found', message: 'The download has no file for this target.' } });

    queue.move(entry, { branch: null, reason: null }, 'retry');
    queue.move(entry, { reason: { code: 'disk_full' } }, 'import blocked');
    expect(eventsOf(db).map((event) => event.type)).toEqual(['needs_attention', 'needs_attention']);
    expect(eventsOf(db)[1]!.reason?.code).toBe('disk_full');
    expect(eventsOf(db)[1]!.id).not.toBe(eventsOf(db)[0]!.id);
  });

  it('sends import complete once, and not for other moves', async () => {
    const { db, queue } = await collect();
    db.data.titles['movie:2'] = movie();
    const entry = queue.ensure('movie:2', null, null);
    queue.move(entry, { stage: 'searching' }, 'search');
    queue.move(entry, { stage: 'available' }, 'imported');
    queue.move(entry, { stage: 'available' }, 'imported');
    expect(eventsOf(db).map((event) => event.type)).toEqual(['import_complete']);
  });

  it('makes no job when no destination is set', async () => {
    const { db, queue, webhooks } = await collect(null);
    queue.move(queue.ensure('movie:2', null, null), { stage: 'available' }, 'imported');
    await webhooks.checkHealth();
    expect(Object.keys(db.data.jobs)).toEqual([]);
  });

  it('never lets an error reach the move of the queue', async () => {
    const db = await openDb('unused.json');
    db.data.webhook.url = 'http://receiver.test/hook';
    const webhooks = createWebhooks({
      db,
      persist() {},
      enqueue() {
        throw new Error('broken');
      },
      problems: async () => [],
    });
    const queue = createQueue(db, createEvents(), () => {}, webhooks.onMove);
    const entry = queue.ensure('movie:2', null, null);
    expect(() => queue.move(entry, { stage: 'available' }, 'imported')).not.toThrow();
    expect(entry.stage).toBe('available');
  });

  it('drops an event when the backlog is full', async () => {
    const { db, queue } = await collect();
    for (let i = 0; i < 1_000; i++) enqueueJob(db, { type: 'webhook.deliver', payload: {} });
    queue.move(queue.ensure('movie:2', null, null), { stage: 'available' }, 'imported');
    expect(jobsOf(db)).toHaveLength(1_000);
  });
});

describe('health restored', () => {
  it('sets a baseline, then sends one event for each problem that is gone', async () => {
    const { db, state, webhooks } = await collect();
    state.problems = [problem('a'), problem('b')];
    await webhooks.checkHealth();
    expect(eventsOf(db)).toEqual([]);

    state.problems = [problem('a'), problem('b')];
    await webhooks.checkHealth();
    expect(eventsOf(db)).toEqual([]);

    state.problems = [problem('b'), problem('c')];
    await webhooks.checkHealth();
    expect(eventsOf(db)).toEqual([{ schemaVersion: 1, id: expect.any(String), type: 'health_restored', timestamp: '2024-06-01T00:00:00.000Z', title: null, episode: null, reason: null, problem: { id: 'a', message: 'Problem a.' } }]);

    state.problems = [];
    await webhooks.checkHealth();
    expect(eventsOf(db).map((event) => event.problem?.id)).toEqual(['a', 'b', 'c']);
  });

  it('starts a new baseline when the destination changes', async () => {
    const { db, state, webhooks } = await collect();
    state.problems = [problem('a')];
    await webhooks.checkHealth();
    db.data.webhook = { url: 'http://other.test/hook', health: null };
    state.problems = [];
    await webhooks.checkHealth();
    expect(eventsOf(db)).toEqual([]);
  });
});

describe('delivery', () => {
  async function deliver() {
    const receiver = await startReceiver();
    closers.push(receiver.close);
    const db = await openDb('unused.json');
    Object.assign(db.data, emptyData());
    db.data.webhook.url = receiver.url;
    db.data.titles['movie:2'] = movie();
    const worker = createWorker(db, async () => {}, webhookDeliverHandler({ db, timeoutMs: 300 }), { tickMs: 15 });
    worker.start();
    closers.push(() => worker.stop());
    const webhooks = createWebhooks({ db, persist() {}, enqueue: (input) => worker.enqueue(input), problems: async () => [], now: () => NOW });
    const queue = createQueue(db, createEvents(), () => {}, webhooks.onMove);
    const finish = () => queue.move(queue.ensure('movie:2', null, null), { stage: 'available' }, 'imported');
    // The test does not wait for the pause between two tries.
    const skipWaits = () => {
      for (const job of jobsOf(db)) if (job.state === 'waiting') job.runAt = 0;
      return false;
    };
    return { receiver, db, finish, skipWaits };
  }

  it('posts the event as JSON with its ID in the headers, and ends the job', async () => {
    const { receiver, db, finish } = await deliver();
    finish();
    await until(() => receiver.state.seen.length === 1 && jobsOf(db).length === 0);
    const [seen] = receiver.state.seen;
    expect(seen!.path).toBe('/hook/token');
    expect(seen!.headers).toMatchObject({ 'content-type': 'application/json', 'x-ladarr-event-id': seen!.body.id, 'x-ladarr-event-type': 'import_complete' });
    expect(seen!.body).toMatchObject({ schemaVersion: 1, type: 'import_complete', title: { key: 'movie:2' } });
  });

  it('logs the delivery with the target, the status and the path hidden', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ladarr-webhook-log-'));
    try {
      logToFile(join(dir, 'ladarr.log'));
      const { receiver, db, finish } = await deliver();
      finish();
      await until(() => receiver.state.seen.length === 1 && jobsOf(db).length === 0);
      await closeLog();
      const entries = await recentLogs(50, { kind: 'requests' });
      const entry = entries.find((item) => item.message === 'outbound request');
      expect(entry).toMatchObject({
        message: 'outbound request',
        system: 'Webhook',
        request: { method: 'POST', url: '[hidden]' },
        response: { status: 200 },
      });
      expect(entry).not.toHaveProperty('query');
      expect(JSON.stringify(entries)).not.toContain('/hook/token');
    } finally {
      await closeLog();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sends the same event ID and the same body on each retry after an outage', async () => {
    const { receiver, db, finish, skipWaits } = await deliver();
    receiver.state.respond = (n) => (n <= 2 ? 503 : 200);
    finish();
    await until(() => skipWaits() || (receiver.state.seen.length === 3 && jobsOf(db).length === 0));
    const ids = receiver.state.seen.map((request) => request.body.id);
    expect(new Set(ids).size).toBe(1);
    expect(receiver.state.seen.map((request) => request.headers['x-ladarr-event-id'])).toEqual([ids[0], ids[0], ids[0]]);
    expect(receiver.state.seen[2]!.body).toEqual(receiver.state.seen[0]!.body);
  });

  it('stops after the attempt limit and keeps the failed job', async () => {
    const { receiver, db, finish, skipWaits } = await deliver();
    receiver.state.respond = () => 500;
    finish();
    await until(() => skipWaits() || jobsOf(db)[0]?.state === 'failed');
    expect(receiver.state.seen).toHaveLength(MAX_ATTEMPTS);
    expect(jobsOf(db)[0]).toMatchObject({ state: 'failed', attempts: MAX_ATTEMPTS, lastError: { kind: 'outage', message: 'The receiver answered with status 500.' } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(receiver.state.seen).toHaveLength(MAX_ATTEMPTS);
  });

  it('does not retry an answer that a retry cannot change', async () => {
    const { receiver, db, finish, skipWaits } = await deliver();
    receiver.state.respond = () => 404;
    finish();
    await until(() => skipWaits() || jobsOf(db)[0]?.state === 'failed');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(receiver.state.seen).toHaveLength(1);
    expect(jobsOf(db)[0]).toMatchObject({ state: 'failed', attempts: 1, lastError: { kind: 'invalid_input' } });
  });

  it('retries a receiver that does not answer within the timeout', async () => {
    const { receiver, db, finish } = await deliver();
    receiver.state.respond = () => 'hang';
    finish();
    await until(() => jobsOf(db)[0]?.lastError);
    expect(jobsOf(db)[0]).toMatchObject({ state: 'waiting', attempts: 1, lastError: { kind: 'outage', message: 'The receiver did not answer.' } });
  });

  it('drops the event when the user removed the destination', async () => {
    const { receiver, db, finish } = await deliver();
    db.data.webhook.url = null;
    finish();
    // No job is made without a destination. A job that was made before the removal ends without a request.
    enqueueJob(db, { type: 'webhook.deliver', payload: {} });
    await until(() => jobsOf(db).length === 0);
    expect(receiver.state.seen).toEqual([]);
  });
});

describe('worker slots', () => {
  it('runs other work while the deliveries wait for a receiver that does not answer', async () => {
    const receiver = await startReceiver();
    closers.push(receiver.close);
    receiver.state.respond = () => 'hang';
    const db = await openDb('unused.json');
    Object.assign(db.data, emptyData());
    db.data.webhook.url = receiver.url;
    const ran: string[] = [];
    // Two slots in all. Without separate slots, the two deliveries would take both.
    const worker = createWorker(db, async () => {}, { ...webhookDeliverHandler({ db, timeoutMs: 60_000 }), work: { run: async () => void ran.push('done') } }, { tickMs: 15, concurrency: 2 });
    worker.start();
    closers.push(() => worker.stop());
    const webhooks = createWebhooks({ db, persist() {}, enqueue: (input) => worker.enqueue(input), problems: async () => [] });
    const queue = createQueue(db, createEvents(), () => {}, webhooks.onMove);
    for (const id of ['movie:1', 'movie:2', 'movie:3']) queue.move(queue.ensure(id, null, null), { stage: 'available' }, 'imported');
    await until(() => receiver.state.seen.length === 2);

    worker.enqueue({ type: 'work' });
    await until(() => ran.length === 1);
    expect(jobsOf(db).filter((job) => job.state === 'running')).toHaveLength(2);
  });
});

describe('import with a receiver outage', () => {
  it('finishes the import while the receiver does not answer, then sends the same event ID', async () => {
    const pipe = await startPipeline();
    closers.push(() => pipe.stop());
    const receiver = await startReceiver();
    closers.push(receiver.close);
    receiver.state.respond = () => 'hang';
    pipe.db.data.webhook.url = receiver.url;

    // The webhook jobs run in their own worker, so the worker of the pipeline needs no change.
    const hookWorker = createWorker(pipe.db, async () => {}, webhookDeliverHandler({ db: pipe.db, timeoutMs: 60_000 }), { tickMs: 15 });
    hookWorker.start();
    closers.push(() => hookWorker.stop());
    const webhooks = createWebhooks({ db: pipe.db, persist() {}, enqueue: (input) => hookWorker.enqueue(input), problems: async () => [] });
    const move = pipe.queue.move;
    pipe.queue.move = (entry, change, cause, detail) => {
      const before = { stage: entry.stage, branch: entry.branch, reason: entry.reason };
      move(entry, change, cause, detail);
      webhooks.onMove(entry, before);
    };

    const film = movie({ rootId: 'movie', meta: { ...movie().meta, releaseDates: [{ region: 'US', kind: 'digital', date: '2019-06-01' }] } });
    pipe.db.data.titles[film.key] = film;
    const name = 'Movie.Name.2019.1080p.BluRay.x264-GRP';
    pipe.tracker.state.items = [{ title: name, size: 100 * 120 * MIB }];
    const [entry] = pipe.finder.requestSearch(film.key);
    await until(() => entry!.stage === 'downloading');
    pipe.complete(name, { [`${name}.mkv`]: 'video-data' });

    await until(() => entry!.stage === 'available');
    expect(pipe.db.data.titles[film.key]!.fileId).not.toBeNull();
    // The request is open and waits for an answer, and the import is done.
    await until(() => receiver.state.seen.length === 1);
    expect(receiver.state.seen[0]!.body).toMatchObject({ type: 'import_complete', title: { key: film.key, name: 'Movie Name' } });
    expect(jobsOf(pipe.db)[0]).toMatchObject({ state: 'running' });

    // The receiver recovers. The connection drops, and the next try carries the same event.
    receiver.state.respond = () => 200;
    receiver.dropConnections();
    await until(() => {
      for (const job of jobsOf(pipe.db)) if (job.state === 'waiting') job.runAt = 0;
      return receiver.state.seen.length === 2 && jobsOf(pipe.db).length === 0;
    });
    expect(receiver.state.seen[1]!.body).toEqual(receiver.state.seen[0]!.body);
  });
});

describe('redaction', () => {
  const secret = 'S3CR3T-TOKEN-4711';

  it('keeps the address out of the log, the jobs, and every API answer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ladarr-webhook-'));
    closers.push(() => rmSync(dir, { recursive: true, force: true }));
    logToFile(join(dir, 'logs', 'ladarr.log'));
    closers.push(closeLog);

    const failing = await startReceiver();
    closers.push(failing.close);
    failing.state.respond = () => 500;
    const app = await startTestApp();
    closers.push(app.close);
    const worker = createWorker(app.db, async () => {}, webhookDeliverHandler({ db: app.db, timeoutMs: 300 }), { tickMs: 15 });
    worker.start();
    closers.push(() => worker.stop());

    const answers: unknown[] = [];
    const saved = await app.fetchJson('PUT', '/webhook', { url: `http://127.0.0.1:${failing.port}/hook/${secret}` });
    expect(saved.status).toBe(200);
    answers.push(saved.body, (await app.get('/webhook')).body, (await app.post('/webhook/test', {})).body);

    // Two failed tries on a receiver that answers 500, then two on a port that nobody listens on.
    const webhooks = createWebhooks({ db: app.db, persist() {}, enqueue: (input) => worker.enqueue(input), problems: async () => [] });
    const queue = createQueue(app.db, createEvents(), () => {}, webhooks.onMove);
    queue.move(queue.ensure('movie:2', null, null), { stage: 'available' }, 'imported');
    const skipWaits = () => {
      for (const job of jobsOf(app.db)) if (job.state === 'waiting') job.runAt = 0;
      return false;
    };
    await until(() => skipWaits() || failing.state.seen.length >= 4);
    app.db.data.webhook.url = `http://127.0.0.1:1/hook/${secret}`;
    answers.push((await app.post('/webhook/test', {})).body, (await app.post('/webhook/test', { url: `http://127.0.0.1:1/hook/${secret}` })).body);
    await until(() => skipWaits() || jobsOf(app.db)[0]?.lastError?.message === 'The receiver did not answer.');

    answers.push((await app.get('/system/logs')).body, (await app.get('/system/status')).body, jobsOf(app.db));
    await closeLog();
    const entries = await recentLogs(100);
    // The log has the failures, so the check below is not empty.
    expect(entries.filter((entry) => entry.message === 'webhook delivery failed').length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify([...answers, entries])).not.toContain(secret);
    expect(JSON.stringify(answers)).not.toContain('127.0.0.1:1');
  });
});

describe('API', () => {
  it('saves a valid address, shows only its host, and removes it', async () => {
    const app = await startTestApp();
    closers.push(app.close);
    expect((await app.get('/webhook')).body).toEqual({ webhook: null });
    expect((await app.fetchJson('PUT', '/webhook', { url: 'https://hooks.example.com:8443/a/b?token=x' })).body).toEqual({ webhook: { host: 'hooks.example.com:8443' } });
    expect(app.db.data.webhook).toEqual({ url: 'https://hooks.example.com:8443/a/b?token=x', health: null });
    expect((await app.get('/webhook')).body).toEqual({ webhook: { host: 'hooks.example.com:8443' } });
    expect((await app.del('/webhook')).body).toEqual({ webhook: null });
    expect(app.db.data.webhook).toEqual({ url: null, health: null });
  });

  it.each([['ftp://example.com/hook'], ['not a url'], ['http://user:pass@example.com/hook'], [''], [42], [null]])('refuses the address %j', async (url) => {
    const app = await startTestApp();
    closers.push(app.close);
    const res = await app.fetchJson('PUT', '/webhook', { url });
    expect(res).toMatchObject({ status: 400, body: { error: 'invalid_setting', field: 'url' } });
    expect(app.db.data.webhook.url).toBeNull();
    expect((await app.post('/webhook/test', { url })).status).toBe(400);
  });

  it('tests the address in the body or the saved one, and saves nothing', async () => {
    const app = await startTestApp();
    closers.push(app.close);
    const receiver = await startReceiver();
    closers.push(receiver.close);

    expect((await app.post('/webhook/test', {})).status).toBe(409);
    expect((await app.post('/webhook/test', { url: receiver.url })).body).toEqual({ ok: true });
    expect(app.db.data.webhook.url).toBeNull();
    expect(receiver.state.seen[0]!.body).toMatchObject({ schemaVersion: 1, type: 'test', title: null, episode: null });

    receiver.state.respond = () => 503;
    expect((await app.post('/webhook/test', { url: receiver.url })).body).toEqual({ ok: false, code: 'rejected', status: 503 });
    await app.fetchJson('PUT', '/webhook', { url: receiver.url });
    expect((await app.post('/webhook/test', {})).body).toEqual({ ok: false, code: 'rejected', status: 503 });
    expect((await app.post('/webhook/test', { url: 'http://127.0.0.1:1/' })).body).toEqual({ ok: false, code: 'unreachable', status: null });
  });

  it('drops the events that wait when the destination is removed, so a new destination does not get them', async () => {
    const app = await startTestApp();
    closers.push(app.close);
    const old = await startReceiver();
    closers.push(old.close);
    old.state.respond = () => 503;
    const next = await startReceiver();
    closers.push(next.close);
    const worker = createWorker(app.db, async () => {}, webhookDeliverHandler({ db: app.db }), { tickMs: 15 });
    worker.start();
    closers.push(() => worker.stop());
    const webhooks = createWebhooks({ db: app.db, persist() {}, enqueue: (input) => worker.enqueue(input), problems: async () => [] });
    const queue = createQueue(app.db, createEvents(), () => {}, webhooks.onMove);

    await app.fetchJson('PUT', '/webhook', { url: old.url });
    queue.move(queue.ensure('movie:2', null, null), { stage: 'available' }, 'imported');
    // The first try fails, and the retry waits for the backoff.
    await until(() => jobsOf(app.db)[0]?.state === 'waiting' && jobsOf(app.db)[0]?.attempts === 1);
    await app.del('/webhook');
    expect(jobsOf(app.db)).toEqual([]);

    await app.fetchJson('PUT', '/webhook', { url: next.url });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(next.state.seen).toEqual([]);
    expect(old.state.seen).toHaveLength(1);
  });

  it('does not follow a redirect', async () => {
    const app = await startTestApp();
    closers.push(app.close);
    const target = await startReceiver();
    closers.push(target.close);
    const redirecting = await startReceiver();
    closers.push(redirecting.close);
    redirecting.state.respond = () => 302;
    const res = await app.post('/webhook/test', { url: redirecting.url });
    expect(res.body).toEqual({ ok: false, code: 'rejected', status: 302 });
    expect(target.state.seen).toEqual([]);
  });
});

describe('old database', () => {
  it('loads a file from before the webhook and gives it an empty destination', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ladarr-webhook-db-'));
    closers.push(() => rmSync(dir, { recursive: true, force: true }));
    const { webhook: _webhook, ...old } = emptyData();
    const file = join(dir, 'db.json');
    writeFileSync(file, JSON.stringify(old));
    // lowdb uses a memory adapter when NODE_ENV is "test".
    vi.stubEnv('NODE_ENV', 'production');
    closers.push(() => vi.unstubAllEnvs());
    const db = await openDb(file);
    expect(db.data.webhook).toEqual({ url: null, health: null });
  });
});
