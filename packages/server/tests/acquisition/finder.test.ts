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
    await until(() => entry!.search?.result === 'all_rejected');
    expect(entry!.search!.topRejections).toContain('size_below_min');
    const before = searches();
    expect(before).toBe(1);

    // The search for another catalog record uses the same cache and the new policy.
    pipe.db.data.qualitySizes.movie['bluray-1080'] = { min: 0, preferred: null, max: null };
    const other = movie({ ...m, key: 'movie:3', tmdbId: 3 });
    pipe.db.data.titles[other.key] = other;
    const [next] = pipe.finder.requestSearch(other.key);
    await until(() => stageOf(next!) === 'downloading');
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
  const read = (title: string) => ({ type: 'torrent', title });
  const movieSearch = { type: 'search', season: null, episode: null };

  it('tries the next ranked release without repeating the indexer search when the first is corrupt', async () => {
    pipe = await startPipeline();
    const m = film();
    pipe.db.data.titles[m.key] = m;
    const bad = 'Movie.Name.2019.1080p.BluRay-BAD';
    pipe.tracker.state.items = [{ title: NAME, size: 100 * 120 * MIB }, { title: bad, size: 100 * 120 * MIB, bad: true, seeders: 100 }];
    pipe.finder.requestSearch(m.key);

    await expect.poll(() => pipe!.acquisition).toEqual([movieSearch, read(bad), read(NAME), { type: 'add', hash: hashOf(NAME) }]);
  });

  it('lists more than eight distinct preference rejections in stable rank order', async () => {
    pipe = await startPipeline({ indexer: { rejectZeroSeeders: true } });
    const m = film();
    pipe.db.data.titles[m.key] = m;
    const quality = Array.from({ length: 9 }, (_, i) => ({ title: `Movie.Name.2019.720p.BluRay-GRP${i}`, size: 100 * 60 * MIB, seeders: i < 2 ? 50 : 50 - i }));
    const twoReasons = { title: 'Movie.Name.2019.1080p.WEB-DL-TINY', size: MIB, seeders: 0 };
    pipe.db.data.qualitySizes.movie['webdl-1080'] = { min: 12.5, preferred: null, max: null };
    pipe.tracker.state.items = [twoReasons, ...quality.toReversed(), quality[0]!];
    api = await pipe.api();
    const url = `/queue/entries/${m.key}`;
    const detail = async () => (await api!.get(url)).body.entry;

    pipe.finder.requestSearch(m.key);
    await expect.poll(async () => (await detail())?.status).toMatch(/^(stuck|no_match)$/);
    const stopped = await detail();
    expect.soft(stopped).toMatchObject({ status: 'stuck', tab: 'stuck' });
    const rejected: { title: string; reasons: string[] }[] = stopped.search.rejected;
    expect.soft(rejected.map((item) => item.title)).toEqual([...quality.map((item) => item.title), twoReasons.title]);
    expect.soft(rejected.find((item) => item.title === twoReasons.title)?.reasons ?? []).toHaveLength(2);
    for (const row of rejected) {
      expect(row.reasons.length).toBeGreaterThan(0);
      expect(row).not.toHaveProperty('link');
      expect(row).not.toHaveProperty('magnet');
    }
    expect((await detail()).search.rejected).toEqual(rejected);
    expect(pipe.acquisition).toEqual([movieSearch]);
  });

  it('ranks a corrupt source last and does not let a manual choice add it', async () => {
    pipe = await startPipeline();
    const m = film();
    pipe.db.data.titles[m.key] = m;
    const low = 'Movie.Name.2019.720p.BluRay-LOW';
    pipe.tracker.state.items = [{ title: NAME, size: 100 * 120 * MIB, bad: true }, { title: low, size: 100 * 60 * MIB }];
    api = await pipe.api();
    const url = `/queue/entries/${m.key}`;
    const detail = async () => (await api!.get(url)).body.entry;

    pipe.finder.requestSearch(m.key);
    await expect.poll(async () => (await detail())?.status).toBe('stuck');
    expect.soft(pipe.acquisition).toEqual([movieSearch, read(NAME)]);
    expect((await detail()).search.rejected).toEqual([
      expect.objectContaining({ title: low, reasons: expect.arrayContaining([expect.any(String)]) }),
      expect.objectContaining({ title: NAME, reasons: expect.arrayContaining([expect.any(String)]) }),
    ]);

    const chosen = await api.post(`${url}/releases/grab`, { indexerId: 1, guid: NAME });
    if (chosen.status === 202) {
      await expect.poll(async () => (await detail()).status).toBe('stuck');
    } else {
      expect(chosen.status).toBe(409);
    }
    expect(pipe.acquisition.filter((event) => event.type === 'add')).toEqual([]);
  });

  it('verifies the torrent again before adding a manually chosen quality rejection', async () => {
    pipe = await startPipeline();
    const m = film();
    pipe.db.data.titles[m.key] = m;
    const low = 'Movie.Name.2019.720p.BluRay-LOW';
    pipe.tracker.state.items = [{ title: low, size: 100 * 60 * MIB }];
    api = await pipe.api();
    const url = `/queue/entries/${m.key}`;

    pipe.finder.requestSearch(m.key);
    await expect.poll(async () => (await api!.get(url)).body.entry?.status).toMatch(/^(stuck|no_match)$/);
    expect(pipe.acquisition).toEqual([movieSearch]);
    const chosen = await api.post(`${url}/releases/grab`, { indexerId: 1, guid: low });
    expect(chosen.status).toBe(202);
    await expect.poll(async () => (await api!.get(url)).body.entry?.status).toBe('downloading');
    expect(pipe.acquisition).toEqual([movieSearch, read(low), { type: 'add', hash: hashOf(low) }]);
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
  it('admits the episode at midnight and uses the hourly retry for its season', async () => {
    const midnight = Date.UTC(2026, 10, 21);
    const hour = 3_600_000;
    let now = midnight - 1;
    using clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    pipe = await startPipeline();
    const series = title({ rootId: 'tv', episodes: [episode(1, 1, '2026-11-20'), episode(1, 2, '2026-11-21'), episode(1, 3, null)] });
    pipe.db.data.titles[series.key] = series;
    const season = () => pipe!.queue.findItem(series.key, 1);

    await pipe.worker.drain();
    pipe.finder.sweep();
    expect(pipe.queue.get('tv:1:1x2')).toBeUndefined();
    now = midnight;
    pipe.finder.sweep();
    expect(season()?.entryIds).toEqual(['tv:1:1x1', 'tv:1:1x2']);
    expect(pipe.queue.get('tv:1:1x3')).toBeUndefined();
    pipe.worker.resume();
    await expect.poll(() => season()?.nextAt).toBe(midnight + hour);

    now += hour;
    await expect.poll(() => season()?.nextAt).toBe(now + hour);

    now += hour;
    const pack = 'Show.Name.S01.1080p.WEB-DL-GRP';
    const files = ['Show.Name.S01E01.mkv', 'Show.Name.S01E02.mkv'];
    pipe.tracker.state.items = [{ title: pack, size: 2 * 60 * 45 * MIB, files }];
    await expect.poll(() => season()?.state.kind).toBe('downloading');
    expect(pipe.acquisition.filter((event) => event.type === 'add')).toEqual([{ type: 'add', hash: hashOf(pack, files) }]);
  });

  it('searches a season again with one request, so a pack that arrived later is taken', async () => {
    let now = Date.UTC(2026, 10, 26);
    using clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    pipe = await startPipeline();
    const series = title({ rootId: 'tv', episodes: [1, 2, 3].map((n) => episode(1, n, '2020-01-01')) });
    pipe.db.data.titles[series.key] = series;
    pipe.finder.requestSearch(series.key);
    const season = () => pipe!.queue.findItem(series.key, 1);
    await expect.poll(() => season()?.state.kind).toBe('waiting');
    expect(pipe.tracker.state.searches.map((url) => url.searchParams.get('ep'))).toEqual([null, '1', '2', '3']);
    pipe.tracker.state.items = [{ title: 'Show.Name.S01.1080p.WEB-DL-GRP', size: 3 * 60 * 45 * MIB }];
    const before = pipe.tracker.state.searches.length;
    now = season()!.nextAt!;
    pipe.finder.sweep();
    await expect.poll(() => season()?.state.kind).toBe('downloading');
    // The due targets go in one request for the season. The pack covers every episode, so no episode needs its own query.
    expect(pipe.tracker.state.searches.slice(before).map((url) => url.searchParams.get('ep'))).toEqual([null]);
    expect(pipe.qbit.torrents.size).toBe(1);
  });

  it('takes a new movie release only when the item is due', async () => {
    let now = Date.UTC(2026, 10, 26);
    using clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    pipe = await startPipeline();
    const m = film();
    pipe.db.data.titles[m.key] = m;
    pipe.tracker.state.items = [];
    pipe.finder.requestSearch(m.key);
    const item = () => pipe!.queue.findItem(m.key, null);
    await expect.poll(() => item()?.state.kind).toBe('waiting');
    pipe.tracker.state.items = [{ title: NAME, size: 100 * 120 * MIB }];
    const due = item()!.nextAt!;
    now = due - 1;
    pipe.finder.sweep();
    expect(item()?.state.kind).toBe('waiting');
    expect(searches()).toBe(1);
    now = due;
    pipe.finder.sweep();
    await expect.poll(() => item()?.state.kind).toBe('downloading');
    expect(searches()).toBe(2);
  });

  it('includes both older and recent missing episodes in a season admitted by the sweep', async () => {
    pipe = await startPipeline();
    const yesterday = new Date(Date.now() - 24 * 60 * 60_000).toISOString().slice(0, 10);
    const series = title({ rootId: 'tv', episodes: [episode(1, 1, '2020-01-01'), episode(1, 2, yesterday)] });
    pipe.db.data.titles[series.key] = series;
    pipe.tracker.state.answer = (url) => {
      const ep = url.searchParams.get('ep');
      return ep === null ? [] : [{ title: `Show.Name.S01E0${ep}.1080p.WEB-DL-GRP`, size: 60 * 45 * MIB }];
    };
    pipe.finder.sweep();
    // The sweep searches the new episode and the old missing one. A pause or a stopped app must not leave the old
    // episode without work.
    expect(pipe.queue.get('tv:1:1x2')).toBeDefined();
    expect(pipe.queue.get('tv:1:1x1')).toBeDefined();
    await expect.poll(() => pipe!.queue.findItem(series.key, 1)?.state.kind).toBe('downloading');
    expect(pipe.tracker.state.searches.map((url) => url.searchParams.get('ep'))).toEqual([null, '1', '2']);
    expect(pipe.qbit.torrents.size).toBe(2);
  });

  it('keeps retrying an empty movie search after three completed rounds', async () => {
    let now = Date.UTC(2026, 10, 26);
    using clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    pipe = await startPipeline();
    api = await pipe.api();
    const m = film();
    pipe.db.data.titles[m.key] = m;
    const status = async () => (await api!.get(`/queue/entries/${m.key}`)).body.entry?.status;
    pipe.finder.requestSearch(m.key);

    for (const round of [1, 2, 3, 4]) {
      await expect.poll(searches).toBe(round);
      await expect.poll(status).toBe('not_found');
      if (round < 4) {
        now += 24 * 60 * 60 * 1000;
        pipe.finder.sweep();
      }
    }
    expect(pipe.acquisition).toEqual(Array.from({ length: 4 }, () => ({ type: 'search', season: null, episode: null })));
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

  it('restores a lost waiting search at the due time stored on the item', async () => {
    pipe = await startPipeline();
    const { m, entry } = await waitingFilm();
    expect(searchJobs()).toHaveLength(1);
    const item = pipe.queue.findItem(m.key, null)!;

    await pipe.worker.drain();
    expect(pipe.worker.cancel(searchJobs()[0]!.id)).toBe(false);
    pipe.finder.sweep();

    const matching = searchJobs().filter((job) => {
      const payload = payloadOf(job);
      return job.state !== 'failed' && payload.titleKey === m.key && payload.season === null;
    });
    expect(matching).toHaveLength(1);
    expect(payloadOf(matching[0]!)).toMatchObject({ entryIds: [entry.id] });
    expect(matching[0]!.state).toBe('waiting');
    expect(matching[0]!.runAt).toBe(item.nextAt);
  });

  it('joins a new episode to its existing season without adding a second turn', async () => {
    pipe = await startPipeline();
    const series = title({ rootId: 'tv', episodes: [episode(1, 1), episode(1, 2)] });
    pipe.db.data.titles[series.key] = series;
    pipe.tracker.state.items = [];
    const [first] = pipe.finder.requestSearch(series.key, { season: 1, number: 1 });
    await until(() => branchOf(first!) === 'waiting');
    await until(idle);
    const item = pipe.queue.findItem(series.key, 1)!;

    // The second episode is requested before the next search of the season runs.
    pipe.db.data.queuePaused = true;
    const [second] = pipe.finder.requestSearch(series.key, { season: 1, number: 2 });

    expect(pipe.queue.findItem(series.key, 1)?.id).toBe(item.id);
    expect(pipe.queue.findItem(series.key, 1)?.entryIds).toEqual([first!.id, second!.id]);
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

describe('admission of a series', () => {
  it('groups a mixed catalog response into one item per season', async () => {
    pipe = await startPipeline();
    const series = title({ rootId: 'tv', episodes: [episode(2, 2), episode(1, 2), episode(2, 1), episode(1, 1)] });
    pipe.db.data.titles[series.key] = series;
    // Keep the worker from claiming an item while admission is checked.
    pipe.db.data.queuePaused = true;
    pipe.finder.requestSearch(series.key);

    const items = Object.values(pipe.db.data.queueItems).filter((item) => item.titleKey === series.key);
    expect(items.map((item) => item.season).sort()).toEqual([1, 2]);
    expect(pipe.queue.findItem(series.key, 1)?.entryIds).toEqual(['tv:1:1x1', 'tv:1:1x2']);
    expect(pipe.queue.findItem(series.key, 2)?.entryIds).toEqual(['tv:1:2x1', 'tv:1:2x2']);
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
    move(pipe.queue, entry, { stage: 'downloading', reason: { code: 'torrent_missing' } }, 'torrent left the client');
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
    await pipe.worker.drain();
    const [entry] = pipe.finder.requestSearch(m.key);
    expect(entry).toBeDefined();
    const before = structuredClone(entry!.attempts);
    expect(searchJobs()).toHaveLength(1);
    expect(pipe.worker.cancel(searchJobs()[0]!.id)).toBe(false);
    pipe.finder.sweep();

    expect(pipe.queue.findItem(m.key, null)?.state).toEqual({ kind: 'queued' });
    expect(entry!.attempts).toEqual(before);
    expect(entry!.attempts.at(-1)).toMatchObject({ outcome: 'running', endedAt: null });
    const jobs = searchJobs();
    expect(jobs).toHaveLength(1);
    expect(holds(jobs[0]!, entry!.id)).toBe(true);
  });

  it('leaves a target that a waiting search job holds alone', async () => {
    pipe = await startPipeline();
    const m = film();
    pipe.db.data.titles[m.key] = m;
    await pipe.worker.drain();
    const [entry] = pipe.finder.requestSearch(m.key, { fresh: true });
    expect(searchJobs()).toHaveLength(1);

    pipe.finder.sweep();

    expect(entry!.attempt).toBe(1);
    const jobs = searchJobs();
    expect(jobs).toHaveLength(1);
    expect(holds(jobs[0]!, entry!.id)).toBe(true);
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
    const name = 'Show.Name.S01.1080p.WEB-DL-GRP';
    const files = ['Show.Name.S01E01.mkv', 'Show.Name.S01E02.mkv'];
    const chosen = release(name, { sizeBytes: 2 * 60 * 45 * MIB, link: `http://127.0.0.1:${pipe.tracker.port}/1/download?file=${encodeURIComponent(name)}` });
    pipe.tracker.state.items = [{ title: name, size: chosen.sizeBytes, files }];
    const want = pipe.finder.wantForRelease(series, chosen, 1)!;
    return { series, entries, chosen, want, files };
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
    const { series, entries, chosen, want, files } = await selected();
    const attempts = entries.map((entry) => entry.attempt);

    expect(pipe!.finder.grabManual(entries, chosen, want)).toEqual({ reserved: true });

    expect(entries.map((entry) => entry.state.kind)).toEqual(['fetching', 'fetching']);
    expect(entries.map((entry) => entry.attempt)).toEqual(attempts.map((attempt) => attempt + 1));
    expect(entries.every((entry) => entry.release?.guid === chosen.guid && entry.release.manual)).toBe(true);
    expect(pipe!.queue.findItem(series.key, 1)?.entryIds).toEqual(entries.map((entry) => entry.id));
    expect(pipe!.acquisition).toEqual([]);
    pipe!.db.data.queuePaused = false;
    await expect.poll(() => pipe!.acquisition).toEqual([
      { type: 'torrent', title: chosen.title },
      { type: 'add', hash: hashOf(chosen.title, files) },
    ]);
  });
});
