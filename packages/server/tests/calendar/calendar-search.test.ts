import { afterEach, describe, expect, it } from 'vitest';
import { BULK_SEARCH_JOB } from '../../src/library/calendar/calendar-search.ts';
import { librarySearchHandler } from '../../src/jobs/library-search.ts';
import { open, type Db } from '../../src/core/db.ts';
import { createEvents } from '../../src/core/events.ts';
import { createFinder } from '../../src/library/grab/finder.ts';
import { enqueue, type Job } from '../../src/core/jobs.ts';
import { createQueue } from '../../src/library/downloads/queue.ts';
import { episode, movie, title } from '../helpers/test-fixtures.ts';
import { startPipeline } from '../helpers/test-pipeline.ts';
import type { Title } from '../../src/library/library.ts';

const film = (id: number, extra: Partial<Title> = {}) => movie({ key: `movie:${id}`, tmdbId: id, manualRelease: true, meta: { ...movie().meta, tmdbId: id, title: `Film ${String(id).padStart(3, '0')}` }, ...extra });

// The services without a worker, so the jobs stay in the database where the test can count them.
async function setup(titles: Title[]) {
  const db: Db = await open('unused.json');
  for (const item of titles) db.data.titles[item.key] = item;
  const queue = createQueue(db, createEvents(), () => {});
  const finder = createFinder({ db, queue, indexers: {} as never, enqueue: (input) => enqueue(db, input) });
  const handler = librarySearchHandler({ db, finder, enqueue: (input) => enqueue(db, input) });
  const jobs = (type: string) => Object.values(db.data.jobs).filter((job) => job.type === type);
  const run = (payload: unknown, signal = new AbortController().signal, job?: Job) => handler.run({ ...job, payload } as Job, { signal });
  return { db, queue, finder, jobs, run };
}

describe('batches', () => {
  it('searches a bounded batch and schedules the next one', async () => {
    const keys = Array.from({ length: 60 }, (_, n) => film(n + 1).key);
    const { db, jobs, run } = await setup(keys.map((key) => film(Number(key.split(':')[1]))));
    await run({ planId: 'p', keys, offset: 0 });
    expect(jobs('queue.search')).toHaveLength(25);
    expect(Object.keys(db.data.queue)).toEqual(keys.slice(0, 25));
    expect(jobs(BULK_SEARCH_JOB).map((job) => job.payload)).toEqual([{ planId: 'p', keys, offset: 25 }]);

    await run({ planId: 'p', keys, offset: 25 });
    await run({ planId: 'p', keys, offset: 50 });
    expect(jobs('queue.search')).toHaveLength(60);
    // The last batch schedules nothing.
    expect(jobs(BULK_SEARCH_JOB).map((job) => (job.payload as { offset: number }).offset)).toEqual([25, 50]);
  });

  it('makes no second job when a batch runs again', async () => {
    const keys = Array.from({ length: 30 }, (_, n) => film(n + 1).key);
    const { jobs, run } = await setup(keys.map((key) => film(Number(key.split(':')[1]))));
    await run({ planId: 'p', keys, offset: 0 });
    await run({ planId: 'p', keys, offset: 0 });
    expect(jobs('queue.search')).toHaveLength(25);
    expect(jobs(BULK_SEARCH_JOB)).toHaveLength(1);
  });

  it('ends a batch after a title that started many targets', async () => {
    const big = title({ key: 'tv:1', episodes: Array.from({ length: 400 }, (_, n) => episode(1, n + 1)) });
    const keys = ['tv:1', 'movie:2', 'movie:3'];
    const { db, jobs, run } = await setup([big, film(2), film(3)]);
    await run({ planId: 'p', keys, offset: 0 });
    expect(Object.keys(db.data.queue)).toHaveLength(400);
    expect(db.data.queue['movie:2']).toBeUndefined();
    expect(jobs(BULK_SEARCH_JOB).map((job) => job.payload)).toEqual([{ planId: 'p', keys, offset: 1 }]);
    // One job for the season, not one for each episode.
    expect(jobs('queue.search')).toHaveLength(1);
  });

  it('waits before the next batch while many searches wait', async () => {
    const keys = Array.from({ length: 30 }, (_, n) => film(n + 1).key);
    const { db, jobs, run } = await setup(keys.map((key) => film(Number(key.split(':')[1]))));
    for (let n = 0; n < 50; n++) enqueue(db, { type: 'queue.search', dedupeKey: `other:${n}` });
    const before = Date.now();
    await run({ planId: 'p', keys, offset: 0 });
    expect(jobs(BULK_SEARCH_JOB)[0]!.runAt).toBeGreaterThanOrEqual(before + 30_000);
  });

  it('starts the next batch at once when the backlog is small', async () => {
    const keys = Array.from({ length: 30 }, (_, n) => film(n + 1).key);
    const { jobs, run } = await setup(keys.map((key) => film(Number(key.split(':')[1]))));
    const before = Date.now();
    await run({ planId: 'p', keys, offset: 0 });
    expect(jobs(BULK_SEARCH_JOB)[0]!.runAt).toBeLessThan(before + 5_000);
  });

  it('keeps the progress of a batch that stops, so a retry starts at the next title', async () => {
    const keys = Array.from({ length: 10 }, (_, n) => film(n + 1).key);
    const { db, finder, jobs, run } = await setup(keys.map((key) => film(Number(key.split(':')[1]))));
    const job = enqueue(db, { type: BULK_SEARCH_JOB, payload: { planId: 'p', keys, offset: 0 }, dedupeKey: 'library.search:p:0' });
    const controller = new AbortController();
    const request = finder.requestSearch;
    finder.requestSearch = (key, options) => {
      const started = request(key, options);
      if (key === 'movie:3') controller.abort();
      return started;
    };
    await expect(run(job.payload, controller.signal, job)).rejects.toThrow();
    expect((db.data.jobs[job.id]!.payload as { offset: number }).offset).toBe(3);
    expect(jobs('queue.search')).toHaveLength(3);
    finder.requestSearch = request;
    // The retry reads the payload that the database holds.
    await run(db.data.jobs[job.id]!.payload, new AbortController().signal, db.data.jobs[job.id]);
    expect(jobs('queue.search')).toHaveLength(10);
  });

  it('stops when the worker stops, and a title that is gone starts nothing', async () => {
    const { db, run } = await setup([film(1)]);
    const controller = new AbortController();
    controller.abort();
    await expect(run({ planId: 'p', keys: ['movie:1'], offset: 0 }, controller.signal)).rejects.toThrow();
    expect(db.data.queue).toEqual({});
    await run({ planId: 'p', keys: ['movie:9'], offset: 0 });
    expect(db.data.queue).toEqual({});
  });
});

describe('selection API', () => {
  let pipe: Awaited<ReturnType<typeof startPipeline>> | undefined;
  let api: Awaited<ReturnType<Awaited<ReturnType<typeof startPipeline>>['api']>> | undefined;
  afterEach(async () => {
    api?.close();
    await pipe?.stop();
    pipe = api = undefined;
  });

  async function library() {
    pipe = await startPipeline();
    api = await pipe.api();
    const titles = [
      film(1),
      film(2, { paused: true }),
      // No release date and no override: nothing to search.
      film(3, { manualRelease: false }),
      title({ key: 'tv:4', rootId: 'tv', episodes: [episode(1, 1), episode(1, 2), episode(1, 3, '2999-01-01'), episode(1, 4, '2020-01-01', { override: 'unmonitored' })] }),
      film(5),
    ];
    for (const item of titles) pipe.db.data.titles[item.key] = item;
    return pipe.db;
  }

  it('previews the targets that a search would start', async () => {
    const db = await library();
    db.data.titles['tv:4']!.seriesType = 'anime';
    const preview = (await api!.post('/library/search/preview', { filter: 'missing' })).body;
    expect(preview).toMatchObject({ titles: 3, targets: 4 });
    expect(preview.sample).toEqual([
      expect.objectContaining({ key: 'movie:1', targets: 1 }),
      expect.objectContaining({ key: 'movie:5', targets: 1 }),
      expect.objectContaining({ key: 'tv:4', targets: 2 }),
    ]);
    expect(typeof preview.planId).toBe('string');
    expect((await api!.post('/library/search/preview', { filter: 'missing', type: 'movie' })).body).toMatchObject({ titles: 2, targets: 2 });
    expect((await api!.post('/library/search/preview', { filter: 'missing', type: 'anime' })).body).toMatchObject({ titles: 1, targets: 2 });
    expect((await api!.post('/library/search/preview', { filter: 'missing', type: 'tv' })).body).toMatchObject({ titles: 1, targets: 2 });
    expect((await api!.post('/library/search/preview', { keys: ['tv:4', 'movie:2', 'nope', 'tv:4'] })).body).toMatchObject({ titles: 1, targets: 2 });
  });

  it('does not count a target that is in the journey, but counts one that waits for a release', async () => {
    const db = await library();
    const entry = (id: string, titleKey: string, extra: object) => {
      db.data.queue[id] = { id, titleKey, season: null, number: null, stage: 'queued', branch: null, attempt: 1, ...extra } as never;
    };
    entry('movie:1', 'movie:1', { stage: 'downloading' });
    entry('movie:5', 'movie:5', { branch: 'waiting' });
    entry('tv:4:1x1', 'tv:4', { season: 1, number: 1, reason: { code: 'no_indexers' } });
    entry('tv:4:1x2', 'tv:4', { season: 1, number: 2, stage: 'available' });
    expect((await api!.post('/library/search/preview', { filter: 'missing' })).body).toMatchObject({ titles: 2, targets: 2 });
  });

  it('makes no plan when nothing needs a search', async () => {
    await library();
    expect((await api!.post('/library/search/preview', { filter: 'waiting' })).body).toEqual({ planId: null, titles: 0, targets: 0, sample: [] });
  });

  it('refuses a selection that is not valid', async () => {
    await library();
    expect((await api!.post('/library/search/preview', { filter: 'nope' })).body).toEqual({ error: 'invalid_filter' });
    expect((await api!.post('/library/search/preview', { kind: 'upgrades', filter: 'upgrades', resolution: 1080 })).body).toEqual({ error: 'invalid_filter' });
    expect((await api!.post('/library/search/preview', { keys: 'movie:1' })).body).toEqual({ error: 'invalid_selection' });
    expect((await api!.post('/library/search/preview', { keys: [1] })).body).toEqual({ error: 'invalid_selection' });
    expect((await api!.post('/library/search', { planId: 'nope' })).body).toEqual({ error: 'plan_not_found' });
    expect((await api!.post('/library/search', {})).status).toBe(404);
  });

  it('starts one job for a plan, also when the request comes twice', async () => {
    const db = await library();
    const { planId } = (await api!.post('/library/search/preview', { filter: 'missing' })).body;
    const first = await api!.post('/library/search', { planId });
    const second = await api!.post('/library/search', { planId });
    expect(first.status).toBe(202);
    expect(first.body).toMatchObject({ titles: 3, targets: 4 });
    expect(second.body.jobId).toBe(first.body.jobId);
    const jobs = Object.values(db.data.jobs).filter((job) => job.type === BULK_SEARCH_JOB);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload).toEqual({ planId, keys: ['movie:1', 'movie:5', 'tv:4'], offset: 0 });
  });

  it('runs the plan through the handler and makes the searches', async () => {
    const db = await library();
    const { planId } = (await api!.post('/library/search/preview', { filter: 'missing' })).body;
    await api!.post('/library/search', { planId });
    const job = Object.values(db.data.jobs).find((item) => item.type === BULK_SEARCH_JOB)!;
    const handler = librarySearchHandler({ db, finder: pipe!.finder, enqueue: (input) => enqueue(db, input) });
    await handler.run(job, { signal: new AbortController().signal });
    expect(Object.keys(db.data.queue).sort()).toEqual(['movie:1', 'movie:5', 'tv:4:1x1', 'tv:4:1x2']);
  });
});
