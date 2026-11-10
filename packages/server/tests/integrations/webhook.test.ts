import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyData, open, type Db } from '../../src/core/db.ts';
import { createEvents } from '../../src/core/events.ts';
import { enqueue as enqueueJob } from '../../src/core/jobs.ts';
import { closeLog, logToFile, recentLogs } from '../../src/core/log.ts';
import { createQueue } from '../../src/library/downloads/queue.ts';
import { episode, movie, NOW, title } from '../helpers/test-fixtures.ts';
import { startTestApp } from '../helpers/test-app.ts';
import { MIB, startPipeline, until } from '../helpers/test-pipeline.ts';
import { createWebhooks, MAX_ATTEMPTS, type DeliveryPayload, type WebhookEvent } from '../../src/core/webhook.ts';
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
const deliveriesOf = (db: Db) => jobsOf(db).map((job) => job.payload as DeliveryPayload);
const eventsOf = (db: Db) => deliveriesOf(db).map((payload) => payload.event);

// Events go to jobs, without a worker. One webhook for each event of the queue points at the destination.
async function collect(destination: string | null = 'http://receiver.test/hook') {
  const db = await open('unused.json');
  Object.assign(db.data, emptyData());
  if (destination) {
    db.data.webhooks = [
      { id: 'available-webhook', type: 'available', url: destination },
      { id: 'stuck-webhook', type: 'stuck', url: destination },
    ];
  }
  const webhooks = createWebhooks({ enqueue: (input) => enqueueJob(input), now: () => NOW });
  const queue = createQueue(createEvents(), () => {}, webhooks.onMove);
  return { db, webhooks, queue };
}

describe('events', () => {
  it('sends available for a movie and for an episode with the shared schema', async () => {
    const { db, queue } = await collect();
    db.data.titles['movie:2'] = movie();
    db.data.titles['tv:1'] = title({ episodes: [episode(1, 2)] });
    queue.move(queue.ensure('movie:2', null, null), { stage: 'available' }, 'imported');
    queue.move(queue.ensure('tv:1', 1, 2), { stage: 'available' }, 'imported');

    const base = { schemaVersion: 1, id: expect.any(String), type: 'available', timestamp: '2024-06-01T00:00:00.000Z', reason: null, problem: null };
    expect(eventsOf(db)).toEqual([
      { ...base, title: { key: 'movie:2', mediaType: 'movie', name: 'Movie Name', year: 2019, ids: { tmdb: 2, tvdb: null, imdb: null } }, episode: null },
      { ...base, title: { key: 'tv:1', mediaType: 'tv', name: 'Show Name', year: 2020, ids: { tmdb: 1, tvdb: 55, imdb: null } }, episode: { season: 1, number: 2, name: 'Episode 2' } },
    ]);
    expect(new Set(eventsOf(db).map((event) => event.id)).size).toBe(2);
    expect(deliveriesOf(db).map((payload) => payload.webhookId)).toEqual(['available-webhook', 'available-webhook']);
  });

  it('sends stuck once for each time that an entry stops, with the reason', async () => {
    const { db, queue } = await collect();
    db.data.titles['movie:2'] = movie();
    const entry = queue.ensure('movie:2', null, null);
    queue.move(entry, { reason: { code: 'file_not_found' } }, 'import blocked');
    queue.move(entry, { reason: { code: 'file_unreadable' } }, 'import blocked');
    expect(eventsOf(db)).toHaveLength(1);
    expect(eventsOf(db)[0]).toMatchObject({ type: 'stuck', title: { key: 'movie:2' }, reason: { code: 'file_not_found', message: 'The download has no file for this target.' } });
    expect(deliveriesOf(db)[0]!.webhookId).toBe('stuck-webhook');

    queue.move(entry, { branch: null, reason: null }, 'retry');
    queue.move(entry, { reason: { code: 'disk_full' } }, 'import blocked');
    expect(eventsOf(db).map((event) => event.type)).toEqual(['stuck', 'stuck']);
    expect(eventsOf(db)[1]!.reason?.code).toBe('disk_full');
    expect(eventsOf(db)[1]!.id).not.toBe(eventsOf(db)[0]!.id);
  });

  it('sends available once, and not for other moves', async () => {
    const { db, queue } = await collect();
    db.data.titles['movie:2'] = movie();
    const entry = queue.ensure('movie:2', null, null);
    queue.move(entry, { stage: 'searching' }, 'search');
    queue.move(entry, { stage: 'available' }, 'imported');
    queue.move(entry, { stage: 'available' }, 'imported');
    expect(eventsOf(db).map((event) => event.type)).toEqual(['available']);
  });

  it('sends each event only to the webhooks of its type', async () => {
    const { db, queue } = await collect();
    db.data.titles['movie:2'] = movie();
    queue.move(queue.ensure('movie:2', null, null), { stage: 'available' }, 'imported');
    queue.move(queue.ensure('movie:2', null, null), { reason: { code: 'file_not_found' } }, 'blocked');
    expect(deliveriesOf(db).map(({ webhookId, event }) => [webhookId, event.type])).toEqual([
      ['available-webhook', 'available'],
      ['stuck-webhook', 'stuck'],
    ]);
  });

  it('delivers the same event to each webhook of its type', async () => {
    const { db, queue } = await collect();
    db.data.webhooks.push({ id: 'available-webhook-2', type: 'available', url: 'http://other.test/hook' });
    db.data.titles['movie:2'] = movie();
    queue.move(queue.ensure('movie:2', null, null), { stage: 'available' }, 'imported');
    expect(deliveriesOf(db).map((payload) => payload.webhookId)).toEqual(['available-webhook', 'available-webhook-2']);
    expect(eventsOf(db)[0]).toBe(eventsOf(db)[1]);
  });

  it('makes no job when no webhook of the type is set', async () => {
    const { db, queue } = await collect(null);
    queue.move(queue.ensure('movie:2', null, null), { stage: 'available' }, 'imported');
    queue.move(queue.ensure('movie:2', null, null), { reason: { code: 'file_not_found' } }, 'blocked');
    expect(Object.keys(db.data.jobs)).toEqual([]);
  });

  it('never lets an error reach the move of the queue', async () => {
    const db = await open('unused.json');
    Object.assign(db.data, emptyData());
    db.data.webhooks = [{ id: 'hook', type: 'available', url: 'http://receiver.test/hook' }];
    const webhooks = createWebhooks({
      enqueue() {
        throw new Error('broken');
      },
    });
    const queue = createQueue(createEvents(), () => {}, webhooks.onMove);
    const entry = queue.ensure('movie:2', null, null);
    expect(() => queue.move(entry, { stage: 'available' }, 'imported')).not.toThrow();
    expect(entry.stage).toBe('available');
  });

  it('drops an event when the backlog is full', async () => {
    const { db, queue } = await collect();
    for (let i = 0; i < 1_000; i++) enqueueJob({ type: 'webhook.deliver', payload: {} });
    queue.move(queue.ensure('movie:2', null, null), { stage: 'available' }, 'imported');
    expect(jobsOf(db)).toHaveLength(1_000);
  });
});

describe('delivery', () => {
  async function deliver() {
    const receiver = await startReceiver();
    closers.push(receiver.close);
    const db = await open('unused.json');
    Object.assign(db.data, emptyData());
    db.data.webhooks = [{ id: 'hook', type: 'available', url: receiver.url }];
    db.data.titles['movie:2'] = movie();
    const worker = createWorker(async () => {}, webhookDeliverHandler({ db, timeoutMs: 300 }), { tickMs: 15 });
    worker.start();
    closers.push(() => worker.stop());
    const webhooks = createWebhooks({ enqueue: (input) => worker.enqueue(input), now: () => NOW });
    const queue = createQueue(createEvents(), () => {}, webhooks.onMove);
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
    expect(seen!.headers).toMatchObject({ 'content-type': 'application/json', 'x-ladarr-event-id': seen!.body.id, 'x-ladarr-event-type': 'available' });
    expect(seen!.body).toMatchObject({ schemaVersion: 1, type: 'available', title: { key: 'movie:2' } });
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

  it('drops the event when the user removed the webhook', async () => {
    const { receiver, db, finish } = await deliver();
    db.data.webhooks = [];
    finish();
    // No job is made without a webhook. A job that was made before the removal ends without a request.
    enqueueJob({ type: 'webhook.deliver', payload: { webhookId: 'hook' } });
    await until(() => jobsOf(db).length === 0);
    expect(receiver.state.seen).toEqual([]);
  });
});

describe('worker slots', () => {
  it('runs other work while the deliveries wait for a receiver that does not answer', async () => {
    const receiver = await startReceiver();
    closers.push(receiver.close);
    receiver.state.respond = () => 'hang';
    const db = await open('unused.json');
    Object.assign(db.data, emptyData());
    db.data.webhooks = [{ id: 'hook', type: 'available', url: receiver.url }];
    const ran: string[] = [];
    // Two slots in all. Without separate slots, the two deliveries would take both.
    const worker = createWorker(async () => {}, { ...webhookDeliverHandler({ db, timeoutMs: 60_000 }), work: { run: async () => void ran.push('done') } }, { tickMs: 15, concurrency: 2 });
    worker.start();
    closers.push(() => worker.stop());
    const webhooks = createWebhooks({ enqueue: (input) => worker.enqueue(input) });
    const queue = createQueue(createEvents(), () => {}, webhooks.onMove);
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
    pipe.db.data.webhooks = [{ id: 'hook', type: 'available', url: receiver.url }];

    // The webhook jobs run in their own worker, so the worker of the pipeline needs no change.
    const hookWorker = createWorker(async () => {}, webhookDeliverHandler({ db: pipe.db, timeoutMs: 60_000 }), { tickMs: 15 });
    hookWorker.start();
    closers.push(() => hookWorker.stop());
    const webhooks = createWebhooks({ enqueue: (input) => hookWorker.enqueue(input) });
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
    expect(receiver.state.seen[0]!.body).toMatchObject({ type: 'available', title: { key: film.key, name: 'Movie Name' } });
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
    const worker = createWorker(async () => {}, webhookDeliverHandler({ db: app.db, timeoutMs: 300 }), { tickMs: 15 });
    worker.start();
    closers.push(() => worker.stop());

    const answers: unknown[] = [];
    const saved = await app.fetchJson('POST', '/webhook', { type: 'available', url: `http://127.0.0.1:${failing.port}/hook/${secret}` });
    expect(saved.status).toBe(201);
    const id = app.db.data.webhooks[0]!.id;
    answers.push(saved.body, (await app.get('/webhook')).body, (await app.post('/webhook/test', { url: `http://127.0.0.1:${failing.port}/hook/${secret}` })).body);

    // Two failed tries on a receiver that answers 500, then two on a port that nobody listens on.
    const webhooks = createWebhooks({ enqueue: (input) => worker.enqueue(input) });
    const queue = createQueue(createEvents(), () => {}, webhooks.onMove);
    queue.move(queue.ensure('movie:2', null, null), { stage: 'available' }, 'imported');
    const skipWaits = () => {
      for (const job of jobsOf(app.db)) if (job.state === 'waiting') job.runAt = 0;
      return false;
    };
    await until(() => skipWaits() || failing.state.seen.length >= 4);
    app.db.data.webhooks[0]!.url = `http://127.0.0.1:1/hook/${secret}`;
    answers.push((await app.post(`/webhook/${id}/test`, {})).body, (await app.post('/webhook/test', { url: `http://127.0.0.1:1/hook/${secret}` })).body);
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
  it('saves a valid address with its event, shows only the host, changes it, and removes it', async () => {
    const app = await startTestApp();
    closers.push(app.close);
    expect((await app.get('/webhook')).body).toEqual({ webhooks: [] });
    const created = await app.fetchJson('POST', '/webhook', { type: 'available', url: 'https://hooks.example.com:8443/a/b?token=x' });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({ webhook: { id: expect.any(String), type: 'available', host: 'hooks.example.com:8443' } });
    expect(app.db.data.webhooks).toEqual([{ id: expect.any(String), type: 'available', url: 'https://hooks.example.com:8443/a/b?token=x' }]);
    expect((await app.get('/webhook')).body).toEqual({ webhooks: [{ id: expect.any(String), type: 'available', host: 'hooks.example.com:8443' }] });
    const id = app.db.data.webhooks[0]!.id;
    expect((await app.fetchJson('PUT', `/webhook/${id}`, { type: 'stuck', url: 'https://hooks.example.com/other' })).body).toEqual({ webhook: { id, type: 'stuck', host: 'hooks.example.com' } });
    expect(app.db.data.webhooks).toEqual([{ id, type: 'stuck', url: 'https://hooks.example.com/other' }]);
    expect((await app.del(`/webhook/${id}`)).status).toBe(204);
    expect(app.db.data.webhooks).toEqual([]);
    expect((await app.get('/webhook')).body).toEqual({ webhooks: [] });
  });

  it.each([['ftp://example.com/hook'], ['not a url'], ['http://user:pass@example.com/hook'], [''], [42], [null]])('refuses the address %j', async (url) => {
    const app = await startTestApp();
    closers.push(app.close);
    const res = await app.fetchJson('POST', '/webhook', { type: 'available', url });
    expect(res).toMatchObject({ status: 400, body: { error: 'invalid_setting', field: 'url' } });
    expect(app.db.data.webhooks).toEqual([]);
    expect((await app.post('/webhook/test', { url })).status).toBe(400);
  });

  it.each([['unknown'], [''], [null], [42]])('refuses the event type %j', async (type) => {
    const app = await startTestApp();
    closers.push(app.close);
    const res = await app.fetchJson('POST', '/webhook', { type, url: 'https://example.com/hook' });
    expect(res).toMatchObject({ status: 400, body: { error: 'invalid_setting', field: 'type' } });
    expect(app.db.data.webhooks).toEqual([]);
  });

  it('tests an address that is not saved or a saved webhook, and saves nothing', async () => {
    const app = await startTestApp();
    closers.push(app.close);
    const receiver = await startReceiver();
    closers.push(receiver.close);

    expect((await app.post('/webhook/test', {})).status).toBe(400);
    expect((await app.post('/webhook/test', { url: receiver.url })).body).toEqual({ ok: true });
    expect(app.db.data.webhooks).toEqual([]);
    expect(receiver.state.seen[0]!.body).toMatchObject({ schemaVersion: 1, type: 'test', title: null, episode: null });

    await app.fetchJson('POST', '/webhook', { type: 'available', url: receiver.url });
    const id = app.db.data.webhooks[0]!.id;
    receiver.state.respond = () => 503;
    expect((await app.post(`/webhook/${id}/test`, {})).body).toEqual({ ok: false, code: 'rejected', status: 503 });
    expect((await app.post('/webhook/test', { url: 'http://127.0.0.1:1/' })).body).toEqual({ ok: false, code: 'unreachable', status: null });
  });

  it('drops the events that wait when the webhook is removed, so another one does not get them', async () => {
    const app = await startTestApp();
    closers.push(app.close);
    const old = await startReceiver();
    closers.push(old.close);
    old.state.respond = () => 503;
    const next = await startReceiver();
    closers.push(next.close);
    const worker = createWorker(async () => {}, webhookDeliverHandler({ db: app.db }), { tickMs: 15 });
    worker.start();
    closers.push(() => worker.stop());
    const webhooks = createWebhooks({ enqueue: (input) => worker.enqueue(input) });
    const queue = createQueue(createEvents(), () => {}, webhooks.onMove);

    await app.fetchJson('POST', '/webhook', { type: 'available', url: old.url });
    const oldId = app.db.data.webhooks[0]!.id;
    queue.move(queue.ensure('movie:2', null, null), { stage: 'available' }, 'imported');
    // The first try fails, and the retry waits for the backoff.
    await until(() => jobsOf(app.db)[0]?.state === 'waiting' && jobsOf(app.db)[0]?.attempts === 1);
    await app.del(`/webhook/${oldId}`);
    expect(jobsOf(app.db)).toEqual([]);

    await app.fetchJson('POST', '/webhook', { type: 'available', url: next.url });
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
  it('turns the one destination of an old file into one webhook for each status of the queue', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ladarr-webhook-db-'));
    closers.push(() => rmSync(dir, { recursive: true, force: true }));
    const { webhooks: _webhooks, ...old } = emptyData();
    const file = join(dir, 'db.json');
    writeFileSync(file, JSON.stringify({ ...old, schemaVersion: 3, webhook: { url: 'http://old.test/hook', health: null } }));
    // lowdb uses a memory adapter when NODE_ENV is "test".
    vi.stubEnv('NODE_ENV', 'production');
    closers.push(() => vi.unstubAllEnvs());
    const db = await open(file);
    expect(db.data.webhooks).toEqual([
      { id: expect.any(String), type: 'available', url: 'http://old.test/hook' },
      { id: expect.any(String), type: 'stuck', url: 'http://old.test/hook' },
    ]);
  });

  it('gives an old file with no destination an empty list', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ladarr-webhook-db-'));
    closers.push(() => rmSync(dir, { recursive: true, force: true }));
    const { webhooks: _webhooks, ...old } = emptyData();
    const file = join(dir, 'db.json');
    writeFileSync(file, JSON.stringify({ ...old, schemaVersion: 3 }));
    vi.stubEnv('NODE_ENV', 'production');
    closers.push(() => vi.unstubAllEnvs());
    const db = await open(file);
    expect(db.data.webhooks).toEqual([]);
  });
});
