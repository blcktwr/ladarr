import { move, branchOf } from '../helpers/test-queue.ts';
import { stageOf, reasonOfEntry } from '../../src/library/downloads/queue.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { episode, indexer, movie, release, title } from '../helpers/test-fixtures.ts';
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
    // The policy of the moment rejects the release for its size.
    pipe.db.data.qualitySizes.movie['bluray-1080'] = { min: 200, preferred: null, max: null };

    const [entry] = pipe.finder.requestSearch(m.key);
    await until(() => branchOf(entry!) === 'waiting');
    expect(entry!.search!.topRejections).toContain('size_below_min');
    const before = searches();
    expect(before).toBe(1);

    // The user lowers the limit. The search of the sweep uses the cache: no new request, but the new policy.
    pipe.db.data.qualitySizes.movie['bluray-1080'] = { min: 0, preferred: null, max: null };
    pipe.finder.requestSearch(m.key);
    await until(() => stageOf(entry!) === 'downloading');
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
    await until(() => branchOf(pipe!.queue.get(a.key)) === 'waiting');
    expect(searches()).toBe(1);
  });
});

describe('release date', () => {
  it('waits for the release date before the next search', async () => {
    pipe = await startPipeline();
    const date = '2999-01-01T00:00:00.000Z';
    const m = movie({ rootId: 'movie', manualRelease: false, meta: { ...movie().meta, releaseDates: [{ region: 'US', kind: 'digital', date }] } });
    pipe.db.data.titles[m.key] = m;
    pipe.tracker.state.items = [];

    const [entry] = pipe.finder.requestSearch(m.key, { manual: true, fresh: true });
    await until(() => branchOf(entry!) === 'waiting');

    expect(entry!.search!.nextAt).toBe(Date.parse(date));
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
    await until(() => stageOf(entry) === 'downloading');
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
    move(pipe.queue, entry, { branch: 'cancelled' }, 'cancelled by the user');
    pipe.tracker.state.items = [{ title: 'Show.Name.S01E01.1080p.WEB-DL-GRP', size: 60 * 45 * MIB }];
    await pipe.finder.rss(AbortSignal.timeout(5_000));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(branchOf(entry)).toBe('cancelled');
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
    await until(() => stageOf(pipe!.queue.get('tv:1:1x1')) === 'downloading');
    expect(pipe.queue.get('tv:20:1x1')).toBeUndefined();
  });
});

describe('bad releases', () => {
  it('asks for the user when the best release is not a torrent', async () => {
    pipe = await startPipeline();
    const m = film();
    pipe.db.data.titles[m.key] = m;
    const bad = 'Movie.Name.2019.1080p.WEB-DL-BAD';
    pipe.tracker.state.items = [{ title: bad, size: 100 * 60 * MIB, bad: true }, { title: NAME, size: 100 * 120 * MIB }];
    const [entry] = pipe.finder.requestSearch(m.key);
    // Without a list of failed releases, the search takes the bad release again on each attempt, until the target asks
    // for the user. No torrent reaches the client.
    await until(() => reasonOfEntry(entry!)?.code === 'too_many_attempts');
    expect(entry!.attempt).toBe(3);
    expect(pipe.qbit.torrents.size).toBe(0);
  });

  it('asks for the user after three bad releases', async () => {
    pipe = await startPipeline();
    const m = film();
    pipe.db.data.titles[m.key] = m;
    pipe.tracker.state.items = ['A', 'B', 'C', 'D'].map((x, i) => ({ title: `Movie.Name.2019.1080p.WEB-DL-${x}`, size: 100 * 60 * MIB, bad: true, seeders: 40 - i }));
    const [entry] = pipe.finder.requestSearch(m.key);
    await until(() => reasonOfEntry(entry!)?.code === 'too_many_attempts');
    expect(entry!.attempt).toBe(3);
    expect(pipe.qbit.torrents.size).toBe(0);
  });

  it('does not blame the release when the indexer fails to give the file', async () => {
    pipe = await startPipeline();
    const m = film();
    pipe.db.data.titles[m.key] = m;
    pipe.tracker.state.items = [{ title: NAME, size: 100 * 120 * MIB }];
    const [entry] = pipe.finder.requestSearch(m.key);
    await until(() => stageOf(entry!) === 'fetching' || stageOf(entry!) === 'sending' || stageOf(entry!) === 'downloading');
    // The entry keeps the release: the fault is not a reason to blame it.
    expect(entry!.release!.title).toBe(NAME);
    expect(entry!.attempts.filter((attempt) => attempt.outcome === 'failed')).toEqual([]);
  });
});

describe('the sweep', () => {
  it('searches a season again with one request, so a pack that arrived later is taken', async () => {
    pipe = await startPipeline();
    const series = title({ rootId: 'tv', episodes: [1, 2, 3].map((n) => episode(1, n, '2020-01-01')) });
    pipe.db.data.titles[series.key] = series;
    const entries = pipe.finder.requestSearch(series.key);
    await until(() => entries.every((e) => branchOf(e) === 'waiting'));
    // The first search asks only for the season: every episode is old, so none gets an individual query.
    expect(searches()).toBe(1);

    pipe.tracker.state.items = [{ title: 'Show.Name.S01.1080p.WEB-DL-GRP', size: 3 * 60 * 45 * MIB }];
    for (const entry of entries) entry.search!.nextAt = Date.now() - 1;
    pipe.finder.clearCache();
    const before = pipe.tracker.state.searches.length;
    pipe.finder.sweep();
    await until(() => entries.every((e) => stageOf(e) === 'downloading'));
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
    await until(() => branchOf(entry!) === 'waiting');
    pipe.tracker.state.items = [{ title: NAME, size: 100 * 120 * MIB }];
    // Not yet: the wait is not over.
    pipe.finder.sweep();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(branchOf(entry!)).toBe('waiting');
    // Twelve hours pass: the cache of five minutes is empty by then.
    entry!.search!.nextAt = Date.now() - 1;
    pipe.finder.clearCache();
    pipe.finder.sweep();
    await until(() => stageOf(entry!) === 'downloading');

    const yesterday = new Date(Date.now() - 24 * 60 * 60_000).toISOString().slice(0, 10);
    const series = title({ rootId: 'tv', episodes: [episode(1, 1, '2020-01-01'), episode(1, 2, yesterday)] });
    pipe.db.data.titles[series.key] = series;
    pipe.tracker.state.items = [{ title: 'Show.Name.S01E02.1080p.WEB-DL-GRP', size: 60 * 45 * MIB }];
    pipe.finder.sweep();
    // The sweep searches the new episode and the old missing one. A pause or a stopped app must not leave the old
    // episode without work.
    expect(pipe.queue.get('tv:1:1x2')).toBeDefined();
    expect(pipe.queue.get('tv:1:1x1')).toBeDefined();
    await until(() => stageOf(pipe!.queue.get('tv:1:1x2')!) === 'downloading');
  });
});

describe('manual search', () => {
  it('searches the season pack when the user asks for several episodes of a season', async () => {
    pipe = await startPipeline();
    const series = title({ rootId: 'tv', episodes: [1, 2, 3].map((n) => episode(1, n, '2020-01-01')) });
    pipe.db.data.titles[series.key] = series;
    pipe.tracker.state.items = [{ title: 'Show.Name.S01.1080p.WEB-DL-GRP', size: 3 * 60 * 45 * MIB }];

    const entries = pipe.finder.requestSearch(series.key, { season: 1, manual: true, fresh: true });
    await until(() => entries.every((entry) => stageOf(entry) === 'downloading'));
    // The pack covers every episode, so the run asks for the season and no episode needs its own query.
    expect(pipe.tracker.state.searches.filter((url) => url.searchParams.get('t') !== 'caps').map((url) => url.searchParams.get('ep'))).toEqual([null]);
    expect(pipe.qbit.torrents.size).toBe(1);
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
    await until(() => branchOf(entry!) === 'waiting');
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
    await until(() => branchOf(first!) === 'waiting');
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

describe('the order of the searches of a series', () => {
  it('starts the first season and its first episode, whatever the order of the episodes of the title', async () => {
    pipe = await startPipeline();
    const series = title({ rootId: 'tv', episodes: [episode(2, 2), episode(1, 2), episode(2, 1), episode(1, 1)] });
    pipe.db.data.titles[series.key] = series;
    // The queue is held, so the search jobs stay waiting while the test reads them.
    pipe.db.data.queuePaused = true;
    pipe.finder.requestSearch(series.key);

    const payloads = Object.values(pipe.db.data.jobs)
      .filter((job) => job.type === 'queue.search')
      .sort((a, b) => a.seq - b.seq)
      .map((job) => job.payload as { season: number; entryIds: string[] });
    expect(payloads.map((payload) => payload.season)).toEqual([1, 2]);
    expect(payloads.map((payload) => payload.entryIds)).toEqual([
      ['tv:1:1x1', 'tv:1:1x2'],
      ['tv:1:2x1', 'tv:1:2x2'],
    ]);
  });
});

describe('the order of the sweep', () => {
  // A target that waits for its next search, with the result of the search that left it waiting.
  function waitingWith(tmdbId: number, result: 'no_results' | 'all_rejected') {
    const m = movie({ key: `movie:${tmdbId}`, tmdbId, rootId: 'movie', manualRelease: true });
    pipe!.db.data.titles[m.key] = m;
    const entry = pipe!.queue.ensure(m.key, null, null);
    pipe!.queue.request(entry, 'test');
    move(pipe!.queue, entry, { stage: 'queued', branch: 'waiting', reason: { code: result } }, 'test');
    entry.search = { at: 0, indexers: [], candidates: 0, accepted: 0, result, topRejections: [], nextAt: Date.now() - 1, rejected: [] };
    return m;
  }

  it('searches a target that found no release after a target that has no match', async () => {
    pipe = await startPipeline();
    // The target without a release came first, so the order of creation alone would put it first.
    const none = waitingWith(11, 'no_results');
    const rejected = waitingWith(12, 'all_rejected');
    // The queue is held, so the searches that the sweep starts stay in it.
    pipe.db.data.queuePaused = true;
    pipe.finder.sweep();

    const searchJobs = Object.values(pipe.db.data.jobs).filter((job) => job.type === 'queue.search');
    const seqOf = (titleKey: string) => searchJobs.find((job) => (job.payload as { titleKey: string }).titleKey === titleKey)!.seq;
    expect(seqOf(none.key)).toBeGreaterThan(seqOf(rejected.key));
  });
});

describe('the repair of a blocked import', () => {
  type Payload = { titleKey: string; season: number | null; entryIds: string[] };
  const searchJobs = () => Object.values(pipe!.db.data.jobs).filter((job) => job.type === 'queue.search' && job.state === 'waiting');
  const holds = (job: { payload: unknown }, id: string) => (job.payload as Payload).entryIds.includes(id);

  // A target whose import stopped on a missing file of its pack, with its first attempt still open.
  const blockedImport = () => {
    const m = film();
    pipe!.db.data.titles[m.key] = m;
    const entry = pipe!.queue.ensure(m.key, null, null);
    pipe!.queue.request(entry, 'attached download');
    move(pipe!.queue, entry, { stage: 'importing', reason: { code: 'file_not_found' } }, 'import blocked');
    return { m, entry };
  };

  it('leaves a blocked import stuck, and starts no search', async () => {
    pipe = await startPipeline();
    const { entry } = blockedImport();
    // The repair waits thirty minutes after the import stopped.
    entry.stateSince = Date.now() - 31 * 60_000;
    // The queue is held, so a job that the repair starts would stay waiting while the test reads it.
    pipe.db.data.queuePaused = true;
    // The sweep decides what to drop with the time of its start, and a repair makes its job a moment later. The clock
    // moves forward on each read, so the test always sees that gap and never depends on the speed of the machine.
    let at = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => (at += 1));
    try {
      pipe.finder.sweep();
    } finally {
      clock.mockRestore();
    }

    // The import stopped, so the target waits for the user and keeps its first attempt.
    expect(entry.state).toMatchObject({ kind: 'blocked', at: 'importing' });
    expect(entry.attempt).toBe(1);
    expect(searchJobs()).toHaveLength(0);
  });

  it('leaves a target blocked at the import stuck, with no search', async () => {
    pipe = await startPipeline();
    const { entry } = blockedImport();
    // The same problem, now at the import.
    move(pipe.queue, entry, { stage: 'importing', reason: { code: 'torrent_missing' } }, 'torrent left the client');
    entry.stateSince = Date.now() - 31 * 60_000;
    pipe.db.data.queuePaused = true;
    pipe.finder.sweep();

    expect(entry.state).toMatchObject({ kind: 'blocked', at: 'importing' });
    expect(entry.attempt).toBe(1);
    expect(searchJobs()).toHaveLength(0);
  });

  it('keeps a target stuck before the import after a delay', async () => {
    pipe = await startPipeline();
    const { entry } = blockedImport();
    entry.state = { kind: 'blocked', at: 'downloading', problem: { code: 'torrent_missing' } };
    entry.stateSince = Date.now() - 31 * 60_000;
    const before = structuredClone(entry);
    pipe.db.data.queuePaused = true;
    // Time advances on each read, as it does during a sweep.
    let at = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => (at += 1));
    try {
      pipe.finder.sweep();
    } finally {
      clock.mockRestore();
    }

    expect(entry).toEqual(before);
    expect(searchJobs()).toHaveLength(0);
  });

  it('starts the search of a target that the queue left with an open attempt and no job', async () => {
    pipe = await startPipeline();
    const m = film();
    pipe.db.data.titles[m.key] = m;
    const entry = pipe.queue.ensure(m.key, null, null);
    pipe.queue.request(entry, 'attached download');
    // The second attempt of the repair stays open, and the job that would run it is gone.
    pipe.queue.endAttempt(entry, 'failed', 'file_not_found');
    pipe.queue.startAttempt(entry, 'verification repair');
    pipe.db.data.queuePaused = true;
    pipe.finder.sweep();

    expect(entry.state).toEqual({ kind: 'queued' });
    expect(entry.attempts.at(-1)).toMatchObject({ n: 3, outcome: 'running', endedAt: null });
    const jobs = searchJobs();
    expect(jobs).toHaveLength(1);
    expect(holds(jobs[0]!, entry.id)).toBe(true);
  });

  it('leaves a target that a waiting search job holds alone', async () => {
    pipe = await startPipeline();
    const m = film();
    pipe.db.data.titles[m.key] = m;
    const entry = pipe.queue.ensure(m.key, null, null);
    pipe.queue.request(entry, 'attached download');
    // The job that holds the open attempt waits, so the target has its search already.
    pipe.db.data.queuePaused = true;
    pipe.finder.enqueueSearch({ titleKey: m.key, season: null, entryIds: [entry.id], fresh: true });
    expect(searchJobs()).toHaveLength(1);

    pipe.finder.sweep();

    expect(entry.attempt).toBe(1);
    const jobs = searchJobs();
    expect(jobs).toHaveLength(1);
    expect(holds(jobs[0]!, entry.id)).toBe(true);
  });
});

describe('categories', () => {
  it('searches every category when the indexer has none', async () => {
    const push = { ...indexer().push.sonarr!, categories: [], animeCategories: [] };
    pipe = await startPipeline({ indexer: { push: { sonarr: push, radarr: push } } });
    const m = film();
    pipe.db.data.titles[m.key] = m;
    pipe.tracker.state.items = [{ title: NAME, size: 100 * 120 * MIB }];
    pipe.finder.requestSearch(m.key);
    await until(() => searches() === 1);
    expect(pipe.tracker.state.searches.find((url) => url.searchParams.get('t') !== 'caps')!.searchParams.has('cat')).toBe(false);
  });
});

describe('manual reservation', () => {
  async function selected() {
    pipe = await startPipeline();
    pipe.poller.stop();
    pipe.db.data.queuePaused = true;
    const series = title({ rootId: 'tv', episodes: [episode(1, 1), episode(1, 2)], numbering: { revision: 1, ranges: [] } });
    pipe.db.data.titles[series.key] = series;
    const entries = series.episodes.map((episode) => {
      const entry = pipe!.queue.ensure(series.key, episode.season, episode.number);
      pipe!.queue.request(entry, 'attached download');
      move(pipe!.queue, entry, { stage: 'importing', reason: { code: 'file_unmapped' } }, 'import blocked');
      entry.transferHash = hashOf('Show.Name.S01.720p.WEB-DL-OLD');
      entry.clientId = 'client-1';
      return entry;
    });
    const chosen = release('Show.Name.S01.1080p.WEB-DL-GRP', { sizeBytes: 2 * 60 * 45 * MIB });
    const want = pipe.finder.wantForRelease(series, chosen, 1)!;
    return { series, entries, chosen, want };
  }

  it.each(['busy target', 'stale numbering'] as const)('refuses a %s without changes to targets, attempts, or jobs', async (cause) => {
    const { series, entries, chosen, want } = await selected();
    if (cause === 'busy target') pipe!.queue.resolve(entries[1]!, 'downloading', 'fixture: download is active');
    else series.numbering = { revision: 2, ranges: [] };
    const before = structuredClone({ queue: pipe!.db.data.queue, jobs: pipe!.db.data.jobs, revision: pipe!.db.data.queueRev });

    const result = pipe!.finder.grabManual(entries, chosen, want);

    expect(result).toMatchObject({ rejections: expect.any(Array) });
    expect({ queue: pipe!.db.data.queue, jobs: pipe!.db.data.jobs, revision: pipe!.db.data.queueRev }).toEqual(before);
  });

  it('reserves the selected blocked targets when the complete selection is valid', async () => {
    const { entries, chosen, want } = await selected();
    const attempts = entries.map((entry) => entry.attempt);

    expect(pipe!.finder.grabManual(entries, chosen, want)).toEqual({ reserved: true });

    expect(entries.map((entry) => entry.state.kind)).toEqual(['fetching', 'fetching']);
    expect(entries.map((entry) => entry.attempt)).toEqual(attempts.map((attempt) => attempt + 1));
    expect(entries.every((entry) => entry.release?.guid === chosen.guid && entry.release.manual)).toBe(true);
    const jobs = Object.values(pipe!.db.data.jobs).filter((job) => job.type === 'queue.grab');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload).toEqual({ entryIds: entries.map((entry) => entry.id) });
    expect(pipe!.tracker.state.downloads).toEqual([]);
  });
});

describe('interactive search', () => {
  it('lists each release with its reasons, and grabs one by choice', async () => {
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
    expect(low).toMatchObject({ accepted: false });
    expect(low.rejections).toEqual([{ code: 'quality_not_in_profile', message: expect.stringContaining('quality') }]);
    // A release of another title is not in the list.
    expect(list.releases.find((r: { title: string }) => r.title === wrong)).toBeUndefined();
    // The second look uses the cache: no new request.
    await api.get(`/queue/releases?titleKey=${m.key}`);
    expect(searches()).toBe(1);

    const chosen = await api.post('/queue/releases/grab', { titleKey: m.key, indexerId: 1, guid: lowRes });
    expect(chosen.status).toBe(202);
    const entry = pipe.queue.get(m.key)!;
    await until(() => stageOf(entry) === 'downloading');
    expect(entry.release).toMatchObject({ title: lowRes, manual: true });
    expect(pipe.qbit.torrents.has(hashOf(lowRes))).toBe(true);
  });

  it('takes a release of another title by hand', async () => {
    pipe = await startPipeline();
    api = await pipe.api();
    const m = film();
    pipe.db.data.titles[m.key] = m;
    const wrong = 'Other.Movie.2019.1080p.BluRay-WRONG';
    pipe.tracker.state.items = [{ title: wrong, size: 100 * 120 * MIB }];

    const chosen = await api.post('/queue/releases/grab', { titleKey: m.key, indexerId: 1, guid: wrong });
    expect(chosen.status).toBe(202);
    const entry = pipe.queue.get(m.key)!;
    await until(() => stageOf(entry) === 'downloading');
    expect(entry.release).toMatchObject({ title: wrong, manual: true });
    expect(pipe.qbit.torrents.has(hashOf(wrong))).toBe(true);
  });
});
