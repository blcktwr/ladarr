import { afterEach, describe, expect, it } from 'vitest';
import { episode, movie, title } from '../helpers/test-fixtures.ts';
import { hashOf, MIB, startPipeline, until } from '../helpers/test-pipeline.ts';

let pipe: Awaited<ReturnType<typeof startPipeline>> | undefined;
let api: Awaited<ReturnType<Awaited<ReturnType<typeof startPipeline>>['api']>> | undefined;
afterEach(async () => {
  api?.close();
  await pipe?.stop();
  pipe = api = undefined;
});

const NAME = 'Movie.Name.2019.1080p.BluRay-GRP';
const film = () => movie({ rootId: 'movie', manualRelease: true });
const searches = () => pipe!.tracker.state.searches.filter((u) => u.searchParams.get('t') !== 'caps').length;

describe('cache', () => {
  it('answers from the cache without a request, and applies the policy of now', async () => {
    pipe = await startPipeline();
    const m = film();
    pipe.db.data.titles[m.key] = m;
    pipe.tracker.state.items = [{ title: NAME, size: 100 * 120 * MIB }];
    pipe.db.data.blocklist[`1:${NAME}`] = { title: NAME, reason: 'test', at: Date.now() };

    const [entry] = pipe.finder.requestSearch(m.key);
    await until(() => entry!.branch === 'waiting');
    expect(entry!.search!.topRejections).toContain('blocklisted');
    const before = searches();
    expect(before).toBe(1);

    // The user takes the release off the blocklist. The search of the sweep uses the cache: no new request, but the new policy.
    delete pipe.db.data.blocklist[`1:${NAME}`];
    pipe.finder.requestSearch(m.key);
    await until(() => entry!.stage === 'downloading');
    expect(searches()).toBe(before);
  });

  it('shares one request between equal searches that run at the same time', async () => {
    pipe = await startPipeline();
    const a = film();
    const b = movie({ key: 'movie:3', tmdbId: 3, rootId: 'movie', manualRelease: true });
    pipe.db.data.titles[a.key] = a;
    pipe.db.data.titles[b.key] = b;
    pipe.tracker.state.items = [];
    // Same title, same query: both targets ask the same question of the indexer.
    pipe.finder.requestSearch(a.key, { fresh: true });
    pipe.finder.requestSearch(a.key, { fresh: true });
    await until(() => pipe!.queue.get(a.key)!.branch === 'waiting');
    expect(searches()).toBe(1);
  });
});

describe('RSS', () => {
  it('takes a new release for a missing target without a search', async () => {
    pipe = await startPipeline();
    const m = film();
    const other = movie({ key: 'movie:5', tmdbId: 5, rootId: 'movie', manualRelease: true, meta: { ...movie().meta, tmdbId: 5, title: 'Other Film', originalTitle: 'Other Film', year: 2021 } });
    pipe.db.data.titles[m.key] = m;
    pipe.db.data.titles[other.key] = other;
    pipe.tracker.state.items = [
      { title: NAME, size: 100 * 120 * MIB },
      { title: 'Unknown.Film.2020.1080p.BluRay-GRP', size: 100 * 120 * MIB },
    ];
    await pipe.finder.rss(AbortSignal.timeout(5_000));
    const entry = pipe.queue.get(m.key)!;
    await until(() => entry.stage === 'downloading');
    expect(entry.history.map((h) => h.stage)).not.toContain('searching');
    expect(entry.attempts[0]!.reason).toBe('found by RSS');
    expect(pipe.queue.get(other.key)).toBeUndefined();
    expect(pipe.tracker.state.searches.find((u) => u.searchParams.get('t') === 'search')!.searchParams.get('q')).toBeNull();
  });

  it('does not start a target that the user cancelled', async () => {
    pipe = await startPipeline();
    const series = title({ rootId: 'tv', episodes: [episode(1, 1, '2020-01-01')] });
    pipe.db.data.titles[series.key] = series;
    const entry = pipe.queue.ensure(series.key, 1, 1);
    pipe.queue.request(entry, 'test');
    pipe.queue.move(entry, { branch: 'cancelled' }, 'cancelled by the user');
    pipe.tracker.state.items = [{ title: 'Show.Name.S01E01.1080p.WEB-DL-GRP', size: 60 * 45 * MIB }];
    await pipe.finder.rss(AbortSignal.timeout(5_000));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(entry.branch).toBe('cancelled');
    expect(pipe.tracker.state.downloads).toEqual([]);
  });
});

describe('RSS with similar titles', () => {
  it('decides for every title whose name starts the release name', async () => {
    pipe = await startPipeline();
    const short = title({ key: 'tv:20', tmdbId: 20, rootId: 'tv', meta: { ...title().meta, tmdbId: 20, title: 'Show', originalTitle: 'Show' }, episodes: [episode(1, 1)] });
    const long = title({ rootId: 'tv', episodes: [episode(1, 1)] });
    pipe.db.data.titles[short.key] = short;
    pipe.db.data.titles[long.key] = long;
    pipe.tracker.state.items = [{ title: 'Show.Name.S01E01.1080p.WEB-DL-GRP', size: 60 * 45 * MIB }];
    await pipe.finder.rss(AbortSignal.timeout(5_000));
    await until(() => pipe!.queue.get('tv:1:1x1')?.stage === 'downloading');
    expect(pipe.queue.get('tv:20:1x1')).toBeUndefined();
  });
});

describe('bad releases', () => {
  it('blocks a file that is not a torrent and takes the next release', async () => {
    pipe = await startPipeline();
    const m = film();
    pipe.db.data.titles[m.key] = m;
    const bad = 'Movie.Name.2019.1080p.WEB-DL-BAD';
    pipe.tracker.state.items = [{ title: bad, size: 100 * 60 * MIB, bad: true }, { title: NAME, size: 100 * 120 * MIB }];
    const [entry] = pipe.finder.requestSearch(m.key);
    await until(() => entry!.stage === 'downloading');
    expect(entry!.release!.title).toBe(NAME);
    expect(Object.values(pipe.db.data.blocklist)).toMatchObject([{ title: bad, reason: 'invalid_torrent', titleKey: m.key }]);
    expect(entry!.attempts.map((a) => [a.n, a.outcome, a.reason])).toEqual([[1, 'failed', 'search requested'], [2, 'running', 'fallback: invalid_torrent']]);
    expect(pipe.qbit.torrents.size).toBe(1);
  });

  it('asks for the user after three bad releases', async () => {
    pipe = await startPipeline();
    const m = film();
    pipe.db.data.titles[m.key] = m;
    pipe.tracker.state.items = ['A', 'B', 'C', 'D'].map((x, i) => ({ title: `Movie.Name.2019.1080p.WEB-DL-${x}`, size: 100 * 60 * MIB, bad: true, seeders: 40 - i }));
    const [entry] = pipe.finder.requestSearch(m.key);
    await until(() => entry!.reason?.code === 'too_many_attempts');
    expect(entry!.attempt).toBe(3);
    expect(entry!.attempt).toBe(3);
    expect(Object.keys(pipe.db.data.blocklist)).toHaveLength(3);
    expect(pipe.qbit.torrents.size).toBe(0);
  });

  it('does not blame the release when the indexer fails to give the file', async () => {
    pipe = await startPipeline();
    const m = film();
    pipe.db.data.titles[m.key] = m;
    pipe.tracker.state.items = [{ title: NAME, size: 100 * 120 * MIB }];
    const [entry] = pipe.finder.requestSearch(m.key);
    await until(() => entry!.stage === 'fetching' || entry!.stage === 'sending' || entry!.stage === 'downloading');
    expect(pipe.db.data.blocklist).toEqual({});
  });
});

describe('the sweep', () => {
  it('searches a season again with one request, so a pack that arrived later is taken', async () => {
    pipe = await startPipeline();
    const series = title({ rootId: 'tv', episodes: [1, 2, 3].map((n) => episode(1, n, '2020-01-01')) });
    pipe.db.data.titles[series.key] = series;
    const entries = pipe.finder.requestSearch(series.key);
    await until(() => entries.every((e) => e.branch === 'waiting'));
    // The first search asks only for the season: every episode is old, so none gets an individual query.
    expect(searches()).toBe(1);

    pipe.tracker.state.items = [{ title: 'Show.Name.S01.1080p.WEB-DL-GRP', size: 3 * 60 * 45 * MIB }];
    for (const entry of entries) entry.search!.nextAt = Date.now() - 1;
    pipe.finder.clearCache();
    const before = pipe.tracker.state.searches.length;
    pipe.finder.sweep();
    await until(() => entries.every((e) => e.stage === 'downloading'));
    // The due targets go in one request for the season. The pack covers every episode, so no episode needs its own query.
    expect(pipe.tracker.state.searches.slice(before).map((url) => url.searchParams.get('ep'))).toEqual([null]);
    expect(pipe.qbit.torrents.size).toBe(1);
  });

  it('searches again when the wait is over, and searches every episode that is due', async () => {
    pipe = await startPipeline();
    const m = film();
    pipe.db.data.titles[m.key] = m;
    pipe.tracker.state.items = [];
    const [entry] = pipe.finder.requestSearch(m.key);
    await until(() => entry!.branch === 'waiting');
    pipe.tracker.state.items = [{ title: NAME, size: 100 * 120 * MIB }];
    // Not yet: the wait is not over.
    pipe.finder.sweep();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(entry!.branch).toBe('waiting');
    // Twelve hours pass: the cache of five minutes is empty by then.
    entry!.search!.nextAt = Date.now() - 1;
    pipe.finder.clearCache();
    pipe.finder.sweep();
    await until(() => entry!.stage === 'downloading');

    const yesterday = new Date(Date.now() - 24 * 60 * 60_000).toISOString().slice(0, 10);
    const series = title({ rootId: 'tv', episodes: [episode(1, 1, '2020-01-01'), episode(1, 2, yesterday)] });
    pipe.db.data.titles[series.key] = series;
    pipe.tracker.state.items = [{ title: 'Show.Name.S01E02.1080p.WEB-DL-GRP', size: 60 * 45 * MIB }];
    pipe.finder.sweep();
    // The sweep searches the new episode and the old missing one. A pause or a stopped app must not leave the old
    // episode without work.
    expect(pipe.queue.get('tv:1:1x2')).toBeDefined();
    expect(pipe.queue.get('tv:1:1x1')).toBeDefined();
    await until(() => pipe!.queue.get('tv:1:1x2')!.stage === 'downloading');
  });
});

describe('the next search', () => {
  type Payload = { titleKey: string; season: number | null; entryIds: string[] };
  const searchJobs = () => Object.values(pipe!.db.data.jobs).filter((job) => job.type === 'queue.search');
  const payloadOf = (job: { payload: unknown }) => job.payload as Payload;
  const idle = () => !searchJobs().some((job) => job.state === 'running');

  // A film that finds no release waits for its next search.
  const waitingFilm = async () => {
    const m = film();
    pipe!.db.data.titles[m.key] = m;
    pipe!.tracker.state.items = [];
    const [entry] = pipe!.finder.requestSearch(m.key);
    await until(() => entry!.branch === 'waiting');
    await until(idle);
    return { m, entry: entry! };
  };

  it('leaves a waiting search job for the next search of a target that found no release', async () => {
    pipe = await startPipeline();
    const { m, entry } = await waitingFilm();

    expect(searchJobs()).toHaveLength(1);
    const job = searchJobs()[0]!;
    expect(job.state).toBe('waiting');
    expect(payloadOf(job)).toMatchObject({ titleKey: m.key, season: null, entryIds: [entry.id] });
    expect(job.runAt).toBeGreaterThanOrEqual(entry.search!.nextAt! - 2_000);
    expect(job.runAt).toBeLessThanOrEqual(entry.search!.nextAt! + 2_000);
    // The job waits for its time: the worker does not claim it early.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(pipe.db.data.jobs[job.id]).toMatchObject({ state: 'waiting' });
  });

  it('moves the waiting search job to now when the sweep finds the target due', async () => {
    pipe = await startPipeline();
    const { m, entry } = await waitingFilm();
    expect(searchJobs()).toHaveLength(1);

    // The queue is held, so the due job stays waiting while the test reads it.
    pipe.db.data.queuePaused = true;
    entry.search!.nextAt = Date.now() - 1;
    pipe.finder.clearCache();
    const before = Date.now();
    pipe.finder.sweep();

    const matching = searchJobs().filter((job) => {
      const payload = payloadOf(job);
      return job.state !== 'failed' && payload.titleKey === m.key && payload.season === null;
    });
    expect(matching).toHaveLength(1);
    expect(payloadOf(matching[0]!)).toMatchObject({ entryIds: [entry.id] });
    expect(matching[0]!.state).toBe('waiting');
    expect(matching[0]!.runAt).toBeGreaterThanOrEqual(before - 2_000);
    expect(matching[0]!.runAt).toBeLessThanOrEqual(Date.now() + 2_000);
  });

  it('puts a new episode into the search job that waits for its season', async () => {
    pipe = await startPipeline();
    const series = title({ rootId: 'tv', episodes: [episode(1, 1), episode(1, 2)] });
    pipe.db.data.titles[series.key] = series;
    pipe.tracker.state.items = [];
    const [first] = pipe.finder.requestSearch(series.key, { season: 1, number: 1 });
    await until(() => first!.branch === 'waiting');
    await until(idle);

    // The second episode is requested before the next search of the season runs.
    pipe.db.data.queuePaused = true;
    const [second] = pipe.finder.requestSearch(series.key, { season: 1, number: 2 });

    const matching = searchJobs().filter((job) => {
      const payload = payloadOf(job);
      return job.state !== 'failed' && payload.titleKey === series.key && payload.season === 1;
    });
    expect(matching).toHaveLength(1);
    const ids = payloadOf(matching[0]!).entryIds;
    expect(ids).toHaveLength(2);
    expect(ids).toEqual(expect.arrayContaining([first!.id, second!.id]));
    expect(matching[0]!.state).toBe('waiting');
  });
});

describe('interactive search', () => {
  it('lists each release with its reasons, and grabs one by choice but not an unsafe one', async () => {
    pipe = await startPipeline();
    api = await pipe.api();
    const m = film();
    pipe.db.data.titles[m.key] = m;
    const lowRes = 'Movie.Name.2019.720p.BluRay-LOW';
    const wrong = 'Other.Movie.2019.1080p.BluRay-WRONG';
    pipe.tracker.state.items = [{ title: lowRes, size: 60 * 100 * MIB }, { title: wrong, size: 100 * 120 * MIB }];

    const list = (await api.get(`/queue/releases?titleKey=${m.key}`)).body;
    expect(list).toMatchObject({ asked: 1, answered: 1 });
    const low = list.releases.find((r: { title: string }) => r.title === lowRes);
    expect(low).toMatchObject({ accepted: false, overridable: true });
    expect(low.rejections).toEqual([{ code: 'quality_not_in_profile', message: expect.stringContaining('quality') }]);
    // A release of another title is not in the list.
    expect(list.releases.find((r: { title: string }) => r.title === wrong)).toBeUndefined();
    // The second look uses the cache: no new request.
    await api.get(`/queue/releases?titleKey=${m.key}`);
    expect(searches()).toBe(1);

    const refused = await api.post('/queue/releases/grab', { titleKey: m.key, indexerId: 1, guid: wrong });
    expect(refused.status).toBe(409);
    expect(refused.body.rejections[0].code).toBe('wrong_title');
    expect(pipe.qbit.torrents.size).toBe(0);

    const chosen = await api.post('/queue/releases/grab', { titleKey: m.key, indexerId: 1, guid: lowRes });
    expect(chosen.status).toBe(202);
    const entry = pipe.queue.get(m.key)!;
    await until(() => entry.stage === 'downloading');
    expect(entry.release).toMatchObject({ title: lowRes, manual: true });
    expect(pipe.qbit.torrents.has(hashOf(lowRes))).toBe(true);
  });
});
