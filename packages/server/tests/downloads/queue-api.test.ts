import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { enqueue } from '../../src/core/jobs.ts';
import { episode, indexer as indexerFixture, movie, title } from '../helpers/test-fixtures.ts';
import { hashOf, MIB, startPipeline, until } from '../helpers/test-pipeline.ts';

let pipe: Awaited<ReturnType<typeof startPipeline>> | undefined;
let api: Awaited<ReturnType<Awaited<ReturnType<typeof startPipeline>>['api']>> | undefined;
afterEach(async () => {
  api?.close();
  await pipe?.stop();
  pipe = api = undefined;
});

const aired = (n: number) => episode(1, n, '2020-01-0' + n);
const NAME = 'Movie.Name.2019.1080p.BluRay-GRP';

async function withMovie() {
  pipe = await startPipeline();
  api = await pipe.api();
  const film = movie({ rootId: 'movie', manualRelease: true });
  pipe.db.data.titles[film.key] = film;
  pipe.tracker.state.items = [{ title: NAME, size: 100 * 120 * MIB }];
  return film;
}

describe('requests and summary', () => {
  it('starts a search from the API and counts the entries by stage', async () => {
    const film = await withMovie();
    expect((await api!.post('/queue/search', { titleKey: 'nope' })).status).toBe(400);
    const started = await api!.post('/queue/search', { titleKey: film.key });
    expect(started.status).toBe(202);
    expect(started.body.started).toEqual(['movie:2']);
    await until(() => pipe!.queue.get('movie:2')!.stage === 'downloading');

    const summary = (await api!.get('/queue/summary')).body;
    expect(summary).toMatchObject({ targets: 1, counts: { downloading: 1 }, hasClient: true, indexers: 1 });
    // A second request for a target that is in the journey starts nothing.
    expect((await api!.post('/queue/search', { titleKey: film.key })).body.started).toEqual([]);
  });

  it('lets the user search a movie that waits for its release', async () => {
    pipe = await startPipeline();
    api = await pipe.api();
    const film = movie({ rootId: 'movie', manualRelease: false, meta: { ...movie().meta, releaseDates: [{ region: 'US', kind: 'theatrical', date: '2019-01-01T00:00:00.000Z' }] } });
    pipe.db.data.titles[film.key] = film;
    expect(pipe.finder.requestSearch(film.key)).toEqual([]);

    const started = await api.post('/queue/search', { titleKey: film.key });
    expect(started.status).toBe(202);
    expect(started.body.started).toEqual([film.key]);
  });

  it('puts the targets of a title that waits for its release at the end', async () => {
    pipe = await startPipeline();
    api = await pipe.api();
    const waiting = movie({ key: 'movie:3', tmdbId: 3, meta: { ...movie().meta, tmdbId: 3 }, rootId: 'movie', manualRelease: false });
    const released = movie({ rootId: 'movie', manualRelease: true });
    pipe.db.data.titles[waiting.key] = waiting;
    pipe.db.data.titles[released.key] = released;
    pipe.tracker.state.items = [{ title: NAME, size: 100 * 120 * MIB }];

    // The waiting title enters the queue first, so it would come first without the sort of the list.
    expect((await api.post('/queue/search', { titleKey: waiting.key })).status).toBe(202);
    await until(() => pipe!.queue.get('movie:3')!.attempt > 0);
    expect((await api.post('/queue/search', { titleKey: released.key })).status).toBe(202);
    await until(() => pipe!.queue.get('movie:2')!.attempt > 0);

    const rows = (await api.get('/queue')).body.items.map((row: { titleKey: string }) => row.titleKey);
    expect(rows).toEqual(['movie:2', 'movie:3']);
  });

  it('names the quality of the release of an entry', async () => {
    const film = await withMovie();
    await api!.post('/queue/search', { titleKey: film.key });
    await until(() => pipe!.queue.get('movie:2')!.stage === 'downloading');

    const item = (await api!.get('/queue')).body.items[0];
    expect(item.release).toMatchObject({ title: NAME, sizeBytes: 100 * 120 * MIB, quality: 'BluRay 1080p' });
  });

  it('names the file of each target and its size', async () => {
    pipe = await startPipeline();
    api = await pipe.api();
    const series = title({ rootId: 'tv', episodes: [aired(1), aired(2)] });
    pipe.db.data.titles[series.key] = series;
    pipe.queue.request(pipe.queue.ensure(series.key, 1, 1), 'test');
    pipe.queue.request(pipe.queue.ensure(series.key, 1, 2), 'test');

    // The first episode has an open import. The second one is in the library already.
    pipe.db.data.imports.j = {
      id: 'j',
      hash: 'h',
      titleKey: series.key,
      createdAt: 0,
      steps: [{ entryIds: ['tv:1:1x1'], source: 'Show.Name.S01E01.1080p.mkv', dest: 'Show Name - S01E01 - Episode 1.mkv', replaces: null, state: 'planned', method: null, sizeBytes: 1_200 * MIB, episodes: [{ season: 1, number: 1 }], validation: 'basic' }],
    };
    series.episodes[1]!.fileId = 'file-2';
    pipe.db.data.files['file-2'] = { id: 'file-2', titleKey: series.key, path: 'Season 01/Show Name - S01E02 - Episode 2.mkv', sizeBytes: 1_100 * MIB, mtimeMs: 0, episodes: [{ season: 1, number: 2 }], missing: false, addedAt: 0 };

    const entries = (await api.get('/queue/groups/tv:1')).body.items;
    expect(entries[0].file).toEqual({ name: 'Show.Name.S01E01.1080p.mkv', sizeBytes: 1_200 * MIB });
    expect(entries[1].file).toEqual({ name: 'Show Name - S01E02 - Episode 2.mkv', sizeBytes: 1_100 * MIB });
  });

  it('names the item job that runs now, so the queue status and the job list agree', async () => {
    const film = await withMovie();
    await pipe!.worker.pause();
    pipe!.finder.requestSearch(film.key);
    // The worker holds the search of the target, as it does while the search runs.
    const job = Object.values(pipe!.db.data.jobs).find((item) => item.type === 'queue.search')!;
    job.state = 'running';
    job.attempts = 1;
    job.leaseOwner = 'test';
    job.leaseExpiresAt = Date.now() + 60_000;

    expect((await api!.get('/queue/summary')).body.currentJob).toEqual({ type: 'queue.search', label: 'Movie Name (2019)' });
    expect((await api!.get('/queue/jobs')).body.items[0]).toMatchObject({ id: job.id, state: 'running', label: 'Movie Name (2019)' });

    // A job that waits is not the current work.
    job.state = 'waiting';
    job.leaseOwner = null;
    job.leaseExpiresAt = null;
    expect((await api!.get('/queue/summary')).body.currentJob).toBeNull();
  });

  it('removes the targets and jobs of a title that leaves the library', async () => {
    const film = await withMovie();
    await pipe!.worker.pause();
    pipe!.finder.requestSearch(film.key);
    const entry = pipe!.queue.get('movie:2')!;
    const job = Object.values(pipe!.db.data.jobs).find((item) => item.type === 'queue.search')!;
    job.state = 'running';
    job.leaseOwner = 'test';
    job.leaseExpiresAt = Date.now() + 60_000;

    expect((await api!.del('/library/movie:2')).status).toBe(200);

    expect(pipe!.queue.get(entry.id)).toBeUndefined();
    expect(pipe!.db.data.jobs[job.id]).toBeUndefined();
    expect((await api!.get('/queue/summary')).body.currentJob).toBeNull();
  });

  it('names why a target that waits for its next search found no release', async () => {
    const film = await withMovie();
    const entry = pipe!.queue.ensure(film.key, null, null);
    pipe!.queue.request(entry, 'test');

    const detail = async () => (await api!.get(`/queue/entries/${entry.id}`)).body.entry;
    const total = async (stage: string) => (await api!.get(`/queue?stage=${stage}`)).body.total;
    const move = (reason: { code: string } | null) => pipe!.queue.move(entry, { stage: 'queued', branch: 'waiting', reason }, 'test');

    // The indexers answered, and no release passed the profile. The target waits for its next search, so it is in
    // Waiting, and its row keeps the key that says it found no release.
    move({ code: 'no_results' });
    expect((await detail()).key).toBe('not_found');
    expect((await api!.get('/queue/summary')).body.counts).toEqual({ not_found: 1 });
    expect(await total('queued')).toBe(1);
    expect(await total('searching')).toBe(0);

    // The indexers answered, and every release was rejected. The target also waits for its next search, so it is
    // in Waiting, and its row keeps the key that says it found no release that fits the preset.
    move({ code: 'all_rejected' });
    expect((await detail()).key).toBe('no_match');
    expect((await api!.get('/queue/summary')).body.counts).toEqual({ no_match: 1 });
    expect(await total('queued')).toBe(1);
    expect(await total('searching')).toBe(0);

    // The search reached its budget. The target searches again, so it stays in the searching stage.
    move({ code: 'search_deferred' });
    expect((await detail()).key).toBe('waiting');
    expect((await api!.get('/queue/summary')).body.counts).toEqual({ waiting: 1 });
    expect(await total('searching')).toBe(1);
    expect(await total('queued')).toBe(0);

    move(null);
    expect((await detail()).key).toBe('waiting');
  });

  it('keeps a target that waits for its turn apart from one that waits for its next search', async () => {
    pipe = await startPipeline();
    api = await pipe.api();
    const film = movie({ rootId: 'movie', manualRelease: true });
    pipe.db.data.titles[film.key] = film;
    pipe.queue.request(pipe.queue.ensure(film.key, null, null), 'test');

    // The target is in the queue, before its first search. It is Waiting.
    expect((await api.get('/queue')).body.items.map((i: { key: string }) => i.key)).toEqual(['queued']);
    expect((await api.get('/queue?stage=queued')).body.total).toBe(1);
    expect((await api.get('/queue?stage=searching')).body.total).toBe(0);
  });

  it('shows a target that fetches its release in the Searching tab, above the targets that search now', async () => {
    pipe = await startPipeline();
    api = await pipe.api();
    const searching = title({ rootId: 'tv', key: 'tv:1', episodes: [aired(1)] });
    const fetching = title({ rootId: 'tv', key: 'tv:2', tmdbId: 2, meta: { ...title().meta, tmdbId: 2, title: 'Other Show' }, episodes: [episode(1, 1, '2020-01-01')] });
    pipe.db.data.titles[searching.key] = searching;
    pipe.db.data.titles[fetching.key] = fetching;
    const searchingEntry = pipe.queue.ensure(searching.key, 1, 1);
    const fetchingEntry = pipe.queue.ensure(fetching.key, 1, 1);
    pipe.queue.request(searchingEntry, 'test');
    pipe.queue.request(fetchingEntry, 'test');
    // The searching title began first, so the order of creation alone would put it first.
    searchingEntry.createdAt = 1;
    fetchingEntry.createdAt = 2;
    pipe.queue.move(fetchingEntry, { stage: 'fetching', branch: null, reason: null }, 'test');
    pipe.queue.move(searchingEntry, { stage: 'searching' }, 'test');

    const list = (await api.get('/queue?stage=searching')).body;
    expect(list.total).toBe(2);
    expect(list.items.map((item: { key: string; counts: Record<string, number> }) => [item.key, item.counts])).toEqual([
      ['tv:2:1', { fetching: 1 }],
      ['tv:1:1', { searching: 1 }],
    ]);
    // Fetching has no tab of its own.
    expect((await api.get('/queue?stage=fetching')).body.total).toBe(0);
  });

  it('shows each season of a series as its own group, with its episodes as lazy children', async () => {
    pipe = await startPipeline();
    api = await pipe.api();
    const series = title({ rootId: 'tv', episodes: [aired(1), aired(2), episode(2, 1, '2020-02-01')] });
    pipe.db.data.titles[series.key] = series;
    pipe.finder.requestSearch(series.key);
    await until(() => pipe!.queue.get('tv:1:2x1')!.branch === 'waiting' && pipe!.queue.get('tv:1:1x2')!.branch === 'waiting');

    const list = (await api.get('/queue')).body;
    expect(list.total).toBe(2);
    expect(list.items.map((i: { kind: string; key: string; season: number | null; total: number; reached: { imported: number } }) => [i.kind, i.key, i.season, i.total, i.reached.imported])).toEqual([
      ['group', 'tv:1:1', 1, 2, 0],
      ['group', 'tv:1:2', 2, 1, 0],
    ]);
    expect(list.items.map((i: { counts: Record<string, number> }) => i.counts)).toEqual([{ not_found: 2 }, { not_found: 1 }]);
    // The summary counts the series, not its seasons: every target of the series waits for its next search.
    expect((await api.get('/queue/summary')).body.counts).toEqual({ not_found: 1 });
    const children = (await api.get('/queue/groups/tv:1')).body.items;
    expect(children.map((c: { label: string }) => c.label)).toEqual(['Show Name S01E01', 'Show Name S01E02', 'Show Name S02E01']);
    expect(children[0].reason.message).toContain('Not found in any indexers');
    expect(children[0].search).toMatchObject({ result: 'no_results' });
    // The group of a season reads the episodes of that season only.
    const season2 = (await api.get('/queue/groups/tv:1?season=2')).body.items;
    expect(season2.map((c: { label: string }) => c.label)).toEqual(['Show Name S02E01']);

    // Filters. A target that waits for its next search is in Waiting, also when the search found nothing.
    expect((await api.get('/queue?stage=queued')).body.total).toBe(2);
    expect((await api.get('/queue?stage=searching')).body.total).toBe(0);
    expect((await api.get('/queue?stage=not_found')).body.total).toBe(0);
    expect((await api.get('/queue?stage=waiting&type=movie')).body.total).toBe(0);
    expect((await api.get('/queue?q=show')).body.total).toBe(2);
    expect((await api.get('/queue?q=other')).body.total).toBe(0);
  });

  it('gives each season of a series its own slot in the stage that it reached', async () => {
    pipe = await startPipeline();
    api = await pipe.api();
    const series = title({ rootId: 'tv', episodes: [aired(1), episode(2, 1, '2020-02-01')] });
    pipe.db.data.titles[series.key] = series;
    const first = pipe.queue.ensure(series.key, 1, 1);
    const second = pipe.queue.ensure(series.key, 2, 1);
    pipe.queue.request(first, 'test');
    pipe.queue.request(second, 'test');
    pipe.queue.move(first, { stage: 'fetching', branch: null, reason: null }, 'test');
    pipe.queue.move(second, { stage: 'importing' }, 'test');

    // The season that fetches its release shows in Searching, and the season that imports shows in Importing.
    const searching = (await api.get('/queue?stage=searching')).body;
    expect(searching.items.map((item: { key: string; season: number | null; counts: Record<string, number> }) => [item.key, item.season, item.counts])).toEqual([['tv:1:1', 1, { fetching: 1 }]]);
    const importing = (await api.get('/queue?stage=importing')).body;
    expect(importing.items.map((item: { key: string; season: number | null; counts: Record<string, number> }) => [item.key, item.season, item.counts])).toEqual([['tv:1:2', 2, { importing: 1 }]]);
    // Both seasons are rows of the list, also when the same series has one in each stage.
    expect((await api.get('/queue')).body.items.map((item: { key: string }) => item.key)).toEqual(['tv:1:2', 'tv:1:1']);
    // The summary counts the series once for each stage that its seasons show.
    expect((await api.get('/queue/summary')).body.counts).toEqual({ fetching: 1, importing: 1 });
  });

  it('shows a series as searching from the add, before its episodes load', async () => {
    pipe = await startPipeline();
    api = await pipe.api();
    const series = title({ episodesLoadedAt: null, episodes: [] });
    pipe.db.data.titles[series.key] = series;
    enqueue({ type: 'queue.initial', payload: { key: series.key }, dedupeKey: `initial:${series.key}` });

    // The series is one group that searches. It has no target yet, so it has no season and no episode row.
    const list = (await api.get('/queue')).body;
    expect(list.total).toBe(1);
    expect(list.items).toEqual([expect.objectContaining({ kind: 'group', key: 'tv:1', titleKey: 'tv:1', season: null, total: 0, counts: { searching: 1 }, pending: true })]);
    expect((await api.get('/queue?stage=searching')).body.total).toBe(1);
    expect((await api.get('/queue?stage=downloading')).body.total).toBe(0);
    expect((await api.get('/queue?type=movie')).body.total).toBe(0);
    expect((await api.get('/queue?q=show')).body.total).toBe(1);
    expect((await api.get('/queue?q=other')).body.total).toBe(0);
    expect((await api.get('/queue/summary')).body).toMatchObject({ targets: 1, counts: { searching: 1 }, working: { searching: 1 }, stopped: 0 });

    // The first search ended with no target, so the series leaves the queue.
    const job = Object.values(pipe.db.data.jobs).find((item) => item.dedupeKey === 'initial:tv:1')!;
    delete pipe.db.data.jobs[job.id];
    expect((await api.get('/queue')).body.items).toEqual([]);
    expect((await api.get('/queue/summary')).body).toMatchObject({ targets: 0, counts: {} });
  });

  it('keeps a paused series out of the loading group', async () => {
    pipe = await startPipeline();
    api = await pipe.api();
    const series = title({ episodesLoadedAt: null, episodes: [], paused: true });
    pipe.db.data.titles[series.key] = series;
    enqueue({ type: 'queue.initial', payload: { key: series.key }, dedupeKey: `initial:${series.key}` });
    expect((await api.get('/queue')).body.items).toEqual([]);
  });

  it('counts the targets of a group that reached each stage', async () => {
    pipe = await startPipeline();
    api = await pipe.api();
    const series = title({ rootId: 'tv', episodes: [aired(1), aired(2)] });
    pipe.db.data.titles[series.key] = series;
    const pack = 'Show.Name.S01.1080p.WEB-DL-GRP';
    pipe.tracker.state.items = [{ title: pack, size: 2 * 60 * 45 * MIB }];
    pipe.finder.requestSearch(series.key);
    await until(() => ['tv:1:1x1', 'tv:1:1x2'].every((id) => pipe!.queue.get(id)!.stage === 'downloading'));
    // The release of both episodes is in the client, so both are found, and no download finished.
    expect((await api.get('/queue')).body.items[0].reached).toEqual({ found: 2, completed: 0, validated: 0, imported: 0 });
    pipe.complete(pack, { 'Show.Name.S01E01.mkv': 'one', 'Show.Name.S01E02.mkv': 'two' });
    await until(() => ['tv:1:1x1', 'tv:1:1x2'].every((id) => pipe!.queue.get(id)!.stage === 'available'));
    // The group leaves the list when every episode is in the library. Its children keep the stages.
    expect((await api.get('/queue')).body.items).toEqual([]);
    const children = (await api.get('/queue/groups/tv:1')).body.items;
    expect(children.map((child: { stage: string }) => child.stage)).toEqual(['available', 'available']);
  });

  it('gives a group the part of the download that the client reports for its torrent', async () => {
    pipe = await startPipeline();
    api = await pipe.api();
    const series = title({ rootId: 'tv', episodes: [aired(1), aired(2)] });
    pipe.db.data.titles[series.key] = series;
    const pack = 'Show.Name.S01.1080p.WEB-DL-GRP';
    const files = ['Show.Name.S01E01.mkv', 'Show.Name.S01E02.mkv'];
    pipe.tracker.state.items = [{ title: pack, size: 2 * 60 * 45 * MIB, files }];
    pipe.finder.requestSearch(series.key);
    await until(() => ['tv:1:1x1', 'tv:1:1x2'].every((id) => pipe!.queue.get(id)!.stage === 'downloading'));

    // The torrent has half of the pack, and each file has its own part. The group shows the part of the torrent, so the
    // bar of the inspector matches the percentage of the client, and not the part of the least advanced file.
    const hash = hashOf(pack, files);
    pipe.qbit.progress(hash, 0.5);
    pipe.qbit.setFiles(hash, [
      { name: `${pack}/Show.Name.S01E01.mkv`, size: 60 * 45 * MIB, progress: 0.9 },
      { name: `${pack}/Show.Name.S01E02.mkv`, size: 60 * 45 * MIB, progress: 0.7 },
    ]);
    await until(() => pipe!.poller.transfer(hash)?.entryProgress?.['tv:1:1x1'] === 0.9 && pipe!.poller.transfer(hash)?.entryProgress?.['tv:1:1x2'] === 0.7);

    expect((await api.get('/queue')).body.items[0].download).toBe(0.5);
  });

  it('gives a group no part of a download when none of its targets downloads', async () => {
    pipe = await startPipeline();
    api = await pipe.api();
    // The worker stays away, so the targets keep the stage that the test gives them.
    await pipe.worker.pause();
    const series = title({ rootId: 'tv', episodes: [aired(1), aired(2)] });
    pipe.db.data.titles[series.key] = series;
    // Both episodes search. The client has no transfer for the season.
    for (const number of [1, 2]) {
      const entry = pipe.queue.ensure(series.key, 1, number);
      pipe.queue.request(entry, 'test');
      pipe.queue.move(entry, { stage: 'searching' }, 'test');
    }

    expect((await api.get('/queue')).body.items[0]).toMatchObject({ kind: 'group', key: 'tv:1:1', download: null });
  });

  it('tells the work apart from the targets that stopped', async () => {
    const film = await withMovie();
    await api!.post('/queue/search', { titleKey: film.key });
    const entry = pipe!.queue.get('movie:2')!;
    await until(() => entry.stage === 'downloading');
    // The target works: it counts in the stage, and nothing is stopped.
    expect((await api!.get('/queue/summary')).body).toMatchObject({ counts: { downloading: 1 }, working: { downloading: 1 }, stopped: 0 });
    // The target stops with a reason. Its key becomes Stuck, and only the work counts as working.
    pipe!.queue.move(entry, { reason: { code: 'too_many_attempts' } }, 'test');
    expect((await api!.get('/queue/summary')).body).toMatchObject({ counts: { stuck: 1 }, working: {}, stopped: 1 });
  });

  it('gives a target that a reason blocks its own key', async () => {
    const film = await withMovie();
    const entry = pipe!.queue.ensure(film.key, null, null);
    pipe!.queue.request(entry, 'test');

    const detail = async () => (await api!.get(`/queue/entries/${entry.id}`)).body.entry;
    const total = async (stage: string) => (await api!.get(`/queue?stage=${stage}`)).body.total;

    pipe!.queue.move(entry, { stage: 'validating', reason: { code: 'client_error' } }, 'test');
    expect(await detail()).toMatchObject({ key: 'stuck', stage: 'validating' });
    expect((await api!.get('/queue/summary')).body.counts).toEqual({ stuck: 1 });
    expect(await total('stuck')).toBe(1);
    expect(await total('validating')).toBe(0);
    expect((await api!.get('/queue')).body.items[0].key).toBe('stuck');

    // A target that waits for its next search keeps the key of the search.
    pipe!.queue.move(entry, { stage: 'queued', branch: 'waiting', reason: { code: 'no_results' } }, 'test');
    expect((await detail()).key).toBe('not_found');

    // Without a reason, the stage is the key.
    pipe!.queue.move(entry, { stage: 'validating', branch: null, reason: null }, 'test');
    expect((await detail()).key).toBe('validating');
    // Validating belongs to the import tab, so the filter of that tab returns the target.
    expect(await total('importing')).toBe(1);
    expect(await total('validating')).toBe(0);
  });

  it('pauses the queue from the API and shows it in the summary', async () => {
    await withMovie();
    expect((await api!.get('/queue/summary')).body.paused).toBe(false);
    expect((await api!.post('/queue/pause', { paused: true })).body).toEqual({ paused: true });
    expect((await api!.get('/queue/summary')).body.paused).toBe(true);
    expect((await api!.post('/queue/pause', { paused: 'yes' })).status).toBe(400);
    expect((await api!.post('/queue/pause', { paused: false })).body).toEqual({ paused: false });
    expect((await api!.get('/queue/summary')).body.paused).toBe(false);
  });
});

describe('order', () => {
  // The rows of the default view, as "movie:11" for a movie and "group:tv:1:1" for a season of a series.
  const rows = async () => (await api!.get('/queue')).body.items.map((row: { kind: string; id: string; key: string }) => (row.kind === 'group' ? `group:${row.key}` : row.id));

  // A target of the queue at the place in time of the test, before its first move.
  function target(titleKey: string, createdAt: number, season: number | null = null, number: number | null = null) {
    const entry = pipe!.queue.ensure(titleKey, season, number);
    entry.createdAt = createdAt;
    pipe!.queue.request(entry, 'test');
    return entry;
  }

  function addFilm(tmdbId: number) {
    const film = movie({ key: `movie:${tmdbId}`, tmdbId, rootId: 'movie', manualRelease: true });
    pipe!.db.data.titles[film.key] = film;
    return film;
  }

  it('puts a target that is further in the journey above one that was created earlier', async () => {
    pipe = await startPipeline();
    api = await pipe.api();
    addFilm(11);
    addFilm(12);
    // The first target is older. The second one is further in the journey.
    const first = target('movie:11', 1_000);
    const second = target('movie:12', 2_000);
    pipe.queue.move(first, { stage: 'downloading' }, 'test');
    pipe.queue.move(second, { stage: 'importing' }, 'test');

    expect(await rows()).toEqual(['movie:12', 'movie:11']);
  });

  it('shows a new target at the end of the list', async () => {
    pipe = await startPipeline();
    api = await pipe.api();
    for (const id of [11, 12, 13, 14]) addFilm(id);
    // The targets enter the queue from the least advanced to the most advanced.
    target('movie:11', 1_000);
    pipe.queue.move(target('movie:12', 2_000), { stage: 'downloading' }, 'test');
    pipe.queue.move(target('movie:13', 3_000), { stage: 'importing' }, 'test');
    // A request of a movie that the user adds now goes after every target that the queue has.
    target('movie:14', 4_000);

    expect(await rows()).toEqual(['movie:13', 'movie:12', 'movie:11', 'movie:14']);
  });

  it('keeps the stage of a target that stopped', async () => {
    pipe = await startPipeline();
    api = await pipe.api();
    for (const id of [11, 12, 13]) addFilm(id);
    // The rows enter the queue from the least advanced to the most advanced.
    const downloading = target('movie:11', 1_000);
    const validating = target('movie:12', 2_000);
    pipe.queue.move(target('movie:13', 3_000), { stage: 'importing' }, 'test');
    pipe.queue.move(downloading, { stage: 'downloading', branch: 'paused' }, 'test');
    pipe.queue.move(validating, { stage: 'validating', reason: { code: 'client_error' } }, 'test');

    // The pause and the reason change no rank: validating is above downloading and below importing.
    expect(await rows()).toEqual(['movie:13', 'movie:12', 'movie:11']);
  });

  it('ranks a series by its least advanced episode', async () => {
    pipe = await startPipeline();
    api = await pipe.api();
    const series = title({ rootId: 'tv', episodes: [aired(1), aired(2)] });
    pipe.db.data.titles[series.key] = series;
    addFilm(11);
    addFilm(12);
    // The first episode is in the library. The second one is still downloading.
    pipe.queue.move(target('tv:1', 1_000, 1, 1), { stage: 'available' }, 'test');
    pipe.queue.move(target('tv:1', 1_001, 1, 2), { stage: 'downloading' }, 'test');
    pipe.queue.move(target('movie:11', 2_000), { stage: 'searching' }, 'test');
    pipe.queue.move(target('movie:12', 3_000), { stage: 'validating' }, 'test');

    // The group is at Downloading: above the search and below the validation.
    expect(await rows()).toEqual(['movie:12', 'group:tv:1:1', 'movie:11']);
  });

  it('puts a target that found no release after every other row, also after one that has no match', async () => {
    pipe = await startPipeline();
    api = await pipe.api();
    for (const id of [11, 12, 13]) addFilm(id);
    // The target without a release came first, so the order of creation alone would put it first.
    const none = target('movie:11', 1_000);
    const rejected = target('movie:12', 2_000);
    pipe.queue.move(none, { stage: 'queued', branch: 'waiting', reason: { code: 'no_results' } }, 'test');
    pipe.queue.move(rejected, { stage: 'queued', branch: 'waiting', reason: { code: 'all_rejected' } }, 'test');
    pipe.queue.move(target('movie:13', 3_000), { stage: 'searching' }, 'test');

    expect(await rows()).toEqual(['movie:13', 'movie:12', 'movie:11']);
  });

  it('puts a season with an episode that found no release after every other row', async () => {
    pipe = await startPipeline();
    api = await pipe.api();
    const series = title({ rootId: 'tv', episodes: [aired(1), aired(2)] });
    pipe.db.data.titles[series.key] = series;
    for (const id of [11, 12]) addFilm(id);
    // The season is downloading, but one of its episodes found no release. The season came first.
    pipe.queue.move(target('tv:1', 1_000, 1, 1), { stage: 'downloading' }, 'test');
    pipe.queue.move(target('tv:1', 1_001, 1, 2), { stage: 'queued', branch: 'waiting', reason: { code: 'no_results' } }, 'test');
    pipe.queue.move(target('movie:11', 2_000), { stage: 'queued', branch: 'waiting', reason: { code: 'all_rejected' } }, 'test');
    pipe.queue.move(target('movie:12', 3_000), { stage: 'searching' }, 'test');

    expect(await rows()).toEqual(['movie:12', 'movie:11', 'group:tv:1:1']);
  });

  it('does not let the number of episodes decide the order of two series that tie', async () => {
    pipe = await startPipeline();
    api = await pipe.api();
    const older = title({ key: 'tv:2', tmdbId: 2, rootId: 'tv', episodes: [aired(1), aired(2), aired(3), aired(4), aired(5)] });
    const newer = title({ rootId: 'tv', episodes: [aired(1), aired(2)] });
    pipe.db.data.titles[older.key] = older;
    pipe.db.data.titles[newer.key] = newer;
    for (let number = 1; number <= 5; number++) pipe.queue.move(target('tv:2', 1_000 + number, 1, number), { stage: 'downloading' }, 'test');
    for (let number = 1; number <= 2; number++) pipe.queue.move(target('tv:1', 2_000 + number, 1, number), { stage: 'downloading' }, 'test');

    // Both series are at Downloading, so the one that came first goes first.
    expect(await rows()).toEqual(['group:tv:2:1', 'group:tv:1:1']);
  });

  it('puts the movie that has more of its download above the one that was created earlier', async () => {
    pipe = await startPipeline();
    api = await pipe.api();

    // A movie that really downloads its release, so the client reports the part of the transfer. The titles differ,
    // so each search finds its own release.
    async function downloadingFilm(tmdbId: number, name: string, release: string, createdAt: number) {
      const film = addFilm(tmdbId);
      film.meta = { ...film.meta, tmdbId, title: name, originalTitle: name };
      pipe!.queue.ensure(film.key, null, null).createdAt = createdAt;
      pipe!.tracker.state.items = [{ title: release, size: 100 * 120 * MIB }];
      pipe!.finder.requestSearch(film.key);
      await until(() => pipe!.queue.get(film.key)!.stage === 'downloading');
      return hashOf(release);
    }

    const older = await downloadingFilm(11, 'Alpha Film', 'Alpha.Film.2019.1080p.BluRay-GRP', 1_000);
    const newer = await downloadingFilm(12, 'Beta Film', 'Beta.Film.2019.1080p.WEB-DL-GRP', 2_000);
    pipe.qbit.progress(older, 0.25);
    pipe.qbit.progress(newer, 0.75);
    await until(() => pipe!.poller.transfer(older)?.progress === 0.25 && pipe!.poller.transfer(newer)?.progress === 0.75);

    // The second movie came later, and its transfer has more of the download, so it goes first.
    expect(await rows()).toEqual(['movie:12', 'movie:11']);
  });

  it('puts the series whose slowest downloading episode has more above the one that was created earlier', async () => {
    pipe = await startPipeline();
    api = await pipe.api();
    const slow = title({ key: 'tv:2', tmdbId: 2, rootId: 'tv', meta: { ...title().meta, tmdbId: 2, title: 'Other Show', originalTitle: 'Other Show' }, episodes: [aired(1), aired(2)] });
    const fast = title({ rootId: 'tv', episodes: [aired(1), aired(2)] });
    pipe.db.data.titles[slow.key] = slow;
    pipe.db.data.titles[fast.key] = fast;
    // The first series came first.
    for (const number of [1, 2]) pipe.queue.ensure('tv:2', 1, number).createdAt = 1_000 + number;
    for (const number of [1, 2]) pipe.queue.ensure('tv:1', 1, number).createdAt = 2_000 + number;

    // A pack for each series. The files download one before the other.
    const slowPack = 'Other.Show.S01.1080p.WEB-DL-GRP';
    const fastPack = 'Show.Name.S01.1080p.WEB-DL-GRP';
    const slowFiles = ['Other.Show.S01E01.mkv', 'Other.Show.S01E02.mkv'];
    const fastFiles = ['Show.Name.S01E01.mkv', 'Show.Name.S01E02.mkv'];
    pipe.tracker.state.items = [{ title: slowPack, size: 2 * 60 * 45 * MIB, files: slowFiles }];
    pipe.finder.requestSearch('tv:2');
    await until(() => ['tv:2:1x1', 'tv:2:1x2'].every((id) => pipe!.queue.get(id)!.stage === 'downloading'));
    pipe.tracker.state.items = [{ title: fastPack, size: 2 * 60 * 45 * MIB, files: fastFiles }];
    pipe.finder.requestSearch('tv:1');
    await until(() => ['tv:1:1x1', 'tv:1:1x2'].every((id) => pipe!.queue.get(id)!.stage === 'downloading'));

    const slowHash = hashOf(slowPack, slowFiles);
    const fastHash = hashOf(fastPack, fastFiles);
    pipe.qbit.progress(slowHash, 0.7);
    pipe.qbit.progress(fastHash, 0.62);
    pipe.qbit.setFiles(slowHash, [
      { name: `${slowPack}/Other.Show.S01E01.mkv`, size: 60 * 45 * MIB, progress: 0.9 },
      { name: `${slowPack}/Other.Show.S01E02.mkv`, size: 60 * 45 * MIB, progress: 0.5 },
    ]);
    pipe.qbit.setFiles(fastHash, [
      { name: `${fastPack}/Show.Name.S01E01.mkv`, size: 60 * 45 * MIB, progress: 0.65 },
      { name: `${fastPack}/Show.Name.S01E02.mkv`, size: 60 * 45 * MIB, progress: 0.6 },
    ]);
    await until(
      () =>
        pipe!.poller.transfer(slowHash)?.entryProgress?.['tv:2:1x1'] === 0.9 &&
        pipe!.poller.transfer(slowHash)?.entryProgress?.['tv:2:1x2'] === 0.5 &&
        pipe!.poller.transfer(fastHash)?.entryProgress?.['tv:1:1x1'] === 0.65 &&
        pipe!.poller.transfer(fastHash)?.entryProgress?.['tv:1:1x2'] === 0.6,
    );

    // The first series came first and has the episode that is further, but the second series goes first: its
    // slowest downloading episode has more of its file than the slowest one of the first series.
    expect(await rows()).toEqual(['group:tv:1:1', 'group:tv:2:1']);
  });

  it('leaves finished rows out of the list and keeps the group', async () => {
    pipe = await startPipeline();
    api = await pipe.api();
    const finished = title({ key: 'tv:2', tmdbId: 2, rootId: 'tv', meta: { ...title().meta, tmdbId: 2, title: 'Other Show', originalTitle: 'Other Show' }, episodes: [aired(1), aired(2)] });
    const partial = title({ rootId: 'tv', episodes: [aired(1), aired(2)] });
    pipe.db.data.titles[finished.key] = finished;
    pipe.db.data.titles[partial.key] = partial;
    addFilm(11);
    // A finished movie.
    pipe.queue.move(target('movie:11', 1_000), { stage: 'available' }, 'test');
    // A series that finished, and a series with one episode in the library.
    pipe.queue.move(target('tv:2', 2_000, 1, 1), { stage: 'available' }, 'test');
    pipe.queue.move(target('tv:2', 2_001, 1, 2), { stage: 'available' }, 'test');
    pipe.queue.move(target('tv:1', 3_000, 1, 1), { stage: 'available' }, 'test');
    pipe.queue.move(target('tv:1', 3_001, 1, 2), { stage: 'downloading' }, 'test');

    const list = (await api.get('/queue')).body;
    expect(list.items.map((row: { kind: string; key: string }) => [row.kind, row.key])).toEqual([['group', 'tv:1:1']]);
    expect(list.items[0].reached.imported).toBe(1);

    // The entry of a finished target still answers.
    expect((await api.get('/queue/entries/movie:11')).body.entry.stage).toBe('available');
    // The group of the finished series keeps every episode.
    const episodes = (await api.get('/queue/groups/tv:2')).body.items;
    expect(episodes.map((entry: { label: string; stage: string }) => [entry.label, entry.stage])).toEqual([
      ['Other Show S01E01', 'available'],
      ['Other Show S01E02', 'available'],
    ]);
    // A group that is still in the list keeps its finished episodes in season and number order.
    const kept = (await api.get('/queue/groups/tv:1')).body.items;
    expect(kept.map((entry: { label: string; stage: string }) => [entry.label, entry.stage])).toEqual([
      ['Show Name S01E01', 'available'],
      ['Show Name S01E02', 'downloading'],
    ]);
  });

  it('puts the target that has its release above the one that only searches', async () => {
    pipe = await startPipeline();
    api = await pipe.api();
    addFilm(11);
    addFilm(12);
    // The first target came first, but it only searches. The second one has its release and waits for a slot.
    pipe.queue.move(target('movie:11', 1_000), { stage: 'searching' }, 'test');
    pipe.queue.move(target('movie:12', 2_000), { stage: 'fetching', branch: null, reason: null }, 'test');

    expect(await rows()).toEqual(['movie:12', 'movie:11']);
    expect((await api.get('/queue?stage=searching')).body.items.map((item: { id: string }) => item.id)).toEqual(['movie:12', 'movie:11']);
  });

  it('ranks a waiting target with a searching one', async () => {
    pipe = await startPipeline();
    api = await pipe.api();
    const series = title({ rootId: 'tv', episodes: [aired(1), aired(2)] });
    pipe.db.data.titles[series.key] = series;
    addFilm(11);
    addFilm(12);
    // The series waits for its next search. Its stage is Queued, and the page shows Searching.
    target('movie:11', 1_000);
    pipe.queue.move(target('tv:1', 2_000, 1, 1), { branch: 'waiting' }, 'test');
    pipe.queue.move(target('tv:1', 2_001, 1, 2), { branch: 'waiting' }, 'test');
    pipe.queue.move(target('movie:12', 3_000), { stage: 'downloading' }, 'test');

    expect(await rows()).toEqual(['movie:12', 'group:tv:1:1', 'movie:11']);
  });
});

describe('actions', () => {
  it('previews an action and refuses one that the stage does not allow', async () => {
    const film = await withMovie();
    await api!.post('/queue/search', { titleKey: film.key });
    await until(() => pipe!.queue.get('movie:2')!.stage === 'downloading');

    const preview = await api!.post('/queue/actions', { action: 'pause', ids: ['movie:2'], preview: true });
    expect(preview.body.affected).toHaveLength(1);
    expect(pipe!.queue.get('movie:2')!.branch).toBeNull();
    const refused = await api!.post('/queue/actions', { action: 'resume', ids: ['movie:2'] });
    expect(refused.status).toBe(409);
    expect(refused.body.unsupported[0].reason).toContain('not paused');
    expect((await api!.post('/queue/actions', { action: 'explode', ids: ['movie:2'] })).status).toBe(400);
  });

  it('replaces the file that blocks the destination name when the user asks', async () => {
    const film = await withMovie();
    await api!.post('/queue/search', { titleKey: film.key });
    const entry = pipe!.queue.get('movie:2')!;
    await until(() => entry.stage === 'downloading');

    const folder = join(pipe!.folders.movies, 'Movie Name (2019)');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'Movie Name (2019).mkv'), 'someone else');
    pipe!.complete(NAME, { [`${NAME}.mkv`]: 'video-data' });

    await until(() => entry.reason?.code === 'destination_exists');
    expect(entry.reason?.detail).toBe('Movie Name (2019)/Movie Name (2019).mkv');
    // A target that stopped before the check was kept still offers the fix.
    entry.reason = { code: 'destination_exists' };

    expect((await api!.post('/queue/actions', { action: 'replace', ids: ['movie:2'] })).status).toBe(200);
    await until(() => entry.stage === 'available');
    expect(entry.reason).toBeNull();
    expect(readFileSync(join(folder, 'Movie Name (2019).mkv'), 'utf8')).toBe('video-data');
  });

  it('pauses and resumes the transfer in the client', async () => {
    const film = await withMovie();
    await api!.post('/queue/search', { titleKey: film.key });
    const entry = pipe!.queue.get('movie:2')!;
    await until(() => entry.stage === 'downloading');
    pipe!.qbit.progress(hashOf(NAME), 0.3);

    expect((await api!.post('/queue/actions', { action: 'pause', ids: ['movie:2'] })).status).toBe(200);
    expect(entry.branch).toBe('paused');
    expect(pipe!.qbit.torrents.get(hashOf(NAME))!.state).toBe('stoppedDL');
    expect((await api!.post('/queue/actions', { action: 'resume', ids: ['movie:2'] })).status).toBe(200);
    expect(entry.branch).toBeNull();
    expect(pipe!.qbit.torrents.get(hashOf(NAME))!.state).toBe('downloading');
  });

  it('shows the full scope of a pause on a pack before it changes the client', async () => {
    pipe = await startPipeline();
    api = await pipe.api();
    const series = title({ rootId: 'tv', episodes: [aired(1), aired(2), aired(3)] });
    pipe.db.data.titles[series.key] = series;
    pipe.tracker.state.items = [{ title: 'Show.Name.S01.1080p.WEB-DL-GRP', size: 3 * 60 * 45 * MIB }];
    pipe.finder.requestSearch(series.key);
    await until(() => pipe!.queue.get('tv:1:1x3')!.stage === 'downloading');

    const preview = (await api.post('/queue/actions', { action: 'pause', ids: ['tv:1:1x2'], preview: true })).body;
    expect(preview.affected.map((a: { id: string }) => a.id)).toEqual(['tv:1:1x1', 'tv:1:1x2', 'tv:1:1x3']);
    expect(preview.sharedTransfers).toEqual([{ name: expect.any(String), entries: 3 }]);
    expect(pipe.qbit.calls.some((c) => c.path === 'torrents/stop')).toBe(false);

    // The summary counts the transfer once, and the list shows it as shared on each episode.
    pipe.qbit.progress(hashOf('Show.Name.S01.1080p.WEB-DL-GRP'), 0.5);
    await until(() => pipe!.poller.transfer(hashOf('Show.Name.S01.1080p.WEB-DL-GRP'))?.progress === 0.5);
    expect((await api.get('/queue/summary')).body).toMatchObject({ targets: 3, activeTransfers: 1, downloadRate: 1_000_000 });
    const rows = (await api.get('/queue/groups/tv:1')).body.items;
    expect(rows.every((r: { transfer: { shared: boolean; sharedWith: number } }) => r.transfer.shared && r.transfer.sharedWith === 3)).toBe(true);
  });

  it('shows the progress of its own file for each episode of a pack', async () => {
    pipe = await startPipeline();
    api = await pipe.api();
    const series = title({ rootId: 'tv', episodes: [aired(1), aired(2)] });
    pipe.db.data.titles[series.key] = series;
    const name = 'Show.Name.S01.1080p.WEB-DL-GRP';
    const files = ['Show.Name.S01E01.mkv', 'Show.Name.S01E02.mkv'];
    pipe.tracker.state.items = [{ title: name, size: 2 * 60 * 45 * MIB, files }];
    pipe.finder.requestSearch(series.key);
    await until(() => pipe!.queue.get('tv:1:1x2')!.stage === 'downloading');

    // A pack downloads one file before the other, so the torrent has one part and each episode has its own.
    const hash = hashOf(name, files);
    pipe.qbit.progress(hash, 0.5);
    pipe.qbit.setFiles(hash, [
      { name: `${name}/Show.Name.S01E01.mkv`, size: 60 * 45 * MIB, progress: 1 },
      { name: `${name}/Show.Name.S01E02.mkv`, size: 60 * 45 * MIB, progress: 0.25 },
    ]);
    await until(() => pipe!.poller.transfer(hash)?.entryProgress?.['tv:1:1x2'] === 0.25);

    const rows = (await api.get('/queue/groups/tv:1')).body.items;
    expect(rows.map((row: { id: string; transfer: { progress: number } }) => [row.id, row.transfer.progress])).toEqual([
      ['tv:1:1x1', 1],
      ['tv:1:1x2', 0.25],
    ]);
    expect(rows.map((row: { id: string; file: { name: string; sizeBytes: number } | null }) => [row.id, row.file])).toEqual([
      ['tv:1:1x1', { name: 'Show.Name.S01E01.mkv', sizeBytes: 60 * 45 * MIB }],
      ['tv:1:1x2', { name: 'Show.Name.S01E02.mkv', sizeBytes: 60 * 45 * MIB }],
    ]);
  });

  it('acts on every season of a series from its group row', async () => {
    pipe = await startPipeline();
    api = await pipe.api();
    const series = title({ rootId: 'tv', episodes: [aired(1), episode(2, 1, '2020-02-01')] });
    pipe.db.data.titles[series.key] = series;
    pipe.finder.requestSearch(series.key);
    await until(() => pipe!.queue.get('tv:1:2x1')!.branch === 'waiting');

    const preview = (await api.post('/queue/actions', { action: 'priority', group: { titleKey: 'tv:1', season: null }, preview: true })).body;
    expect(preview.affected.map((a: { id: string }) => a.id)).toEqual(['tv:1:1x1', 'tv:1:2x1']);
  });

  it('keeps the attempt history when a retry goes back to an earlier stage', async () => {
    const film = await withMovie();
    pipe!.tracker.state.items = [];
    await api!.post('/queue/search', { titleKey: film.key });
    const entry = pipe!.queue.get('movie:2')!;
    await until(() => entry.branch === 'waiting');

    pipe!.tracker.state.items = [{ title: NAME, size: 100 * 120 * MIB }];
    expect((await api!.post('/queue/actions', { action: 'retry', ids: ['movie:2'] })).status).toBe(200);
    await until(() => entry.stage === 'downloading');
    expect(entry.id).toBe('movie:2');
    expect(entry.attempts.map((a) => [a.n, a.reason])).toEqual([[1, 'search requested'], [2, 'retry']]);
    expect(entry.attempts[0]!.outcome).toBe('failed');
    const detail = (await api!.get('/queue/entries/movie:2')).body.entry;
    expect(detail.history.map((h: { cause: string }) => h.cause)).toContain('retry');
  });

  it('keeps the priority lane in the order the user marked, and shows the position', async () => {
    pipe = await startPipeline();
    api = await pipe.api();
    // No indexer answers, so the entries stay in the queue.
    pipe.tracker.state.fail = true;
    pipe.db.data.indexers[1]!.health.retryAt = Date.now() + 60_000;
    const a = movie({ key: 'movie:11', tmdbId: 11, rootId: 'movie', manualRelease: true });
    const b = movie({ key: 'movie:12', tmdbId: 12, rootId: 'movie', manualRelease: true });
    const c = movie({ key: 'movie:13', tmdbId: 13, rootId: 'movie', manualRelease: true });
    for (const t of [a, b, c]) pipe.db.data.titles[t.key] = t;
    pipe.worker.stop;
    for (const t of [a, b, c]) {
      pipe.queue.request(pipe.queue.ensure(t.key, null, null), 'test');
    }
    expect((await api.post('/queue/actions', { action: 'priority', ids: ['movie:13'] })).status).toBe(200);
    expect((await api.post('/queue/actions', { action: 'priority', ids: ['movie:11'] })).status).toBe(200);
    const lane = (await api.get('/queue?priority=1')).body;
    expect(lane.items.map((i: { id: string; lane: number }) => [i.id, i.lane])).toEqual([['movie:13', 1], ['movie:11', 2]]);
    // The normal view keeps its own order.
    expect((await api.get('/queue')).body.items.map((i: { id: string }) => i.id)).toEqual(['movie:11', 'movie:12', 'movie:13']);
    expect((await api.post('/queue/actions', { action: 'unpriority', ids: ['movie:13'] })).status).toBe(200);
    expect((await api.get('/queue?priority=1')).body.items.map((i: { id: string; lane: number }) => [i.id, i.lane])).toEqual([['movie:11', 1]]);
  });
});

describe('repair', () => {
  it('matches a file by hand, and the match stays', async () => {
    const film = await withMovie();
    await api!.post('/queue/search', { titleKey: film.key });
    const entry = pipe!.queue.get('movie:2')!;
    await until(() => entry.stage === 'downloading');
    // The download holds two files. The largest one is the wrong one: an extra.
    pipe!.complete(NAME, { 'extras/behind-the-scenes.mkv': 'x'.repeat(5000), 'Movie.mkv': 'the-film' });
    await until(() => entry.stage === 'available');
    // The automatic pick is the largest file. The user wants the other, so this entry starts again from the files.
    const files = (await api!.get('/queue/entries/movie:2/files')).body;
    expect(files.files.map((f: { rel: string }) => f.rel).sort()).toEqual(['Movie.mkv', 'extras/behind-the-scenes.mkv']);
    expect((await api!.post('/queue/entries/movie:2/match', { file: '../etc/passwd' })).status).toBe(400);
    expect((await api!.post('/queue/entries/movie:2/match', { file: 'Movie.mkv', preview: true })).body).toMatchObject({ affected: [{ id: 'movie:2' }] });
    expect((await api!.post('/queue/entries/movie:2/match', { file: 'Movie.mkv' })).status).toBe(200);
    expect(entry.manualMatch).toEqual({ file: 'Movie.mkv', covers: [] });
  });

  it('does not offer a match for a file that ffprobe can not read', async () => {
    pipe = await startPipeline({ probe: async () => ({ ok: false, reason: 'unreadable' }) });
    api = await pipe.api();
    const film = movie({ rootId: 'movie', manualRelease: true });
    pipe.db.data.titles[film.key] = film;
    pipe.tracker.state.items = [{ title: NAME, size: 100 * 120 * MIB }];
    await api.post('/queue/search', { titleKey: film.key });
    const entry = pipe.queue.get('movie:2')!;
    await until(() => entry.stage === 'downloading');
    pipe.complete(NAME, { [`${NAME}.mkv`]: 'broken' });
    await until(() => entry.reason?.code === 'file_unreadable');
    const body = (await api.get('/queue/entries/movie:2')).body;
    expect(body.entry.reason).toMatchObject({ code: 'file_unreadable', action: 'none' });
  });

  it('lists only the files of the torrent when the content folder holds other downloads', async () => {
    const film = await withMovie();
    await api!.post('/queue/search', { titleKey: film.key });
    const entry = pipe!.queue.get('movie:2')!;
    await until(() => entry.stage === 'downloading');
    // The client created no folder for this torrent, so it reports the folder of every download as the content.
    const hash = hashOf(NAME);
    pipe!.qbit.torrents.get(hash)!.content_path = pipe!.folders.downloads;
    pipe!.qbit.setFiles(hash, [{ name: `${NAME}.mkv`, size: 8, progress: 1 }]);
    writeFileSync(join(pipe!.folders.downloads, `${NAME}.mkv`), 'the-film');
    mkdirSync(join(pipe!.folders.downloads, 'Other.Show.S01'));
    writeFileSync(join(pipe!.folders.downloads, 'Other.Show.S01', 'Other.Show.S01E01.mkv'), 'other');
    const files = (await api!.get('/queue/entries/movie:2/files')).body;
    expect(files.files.map((f: { rel: string }) => f.rel)).toEqual([`${NAME}.mkv`]);
  });

  it('lets a retry of a blocked import use a file chosen by hand', async () => {
    pipe = await startPipeline();
    api = await pipe.api();
    const series = title({ rootId: 'tv', episodes: [aired(1)] });
    pipe.db.data.titles[series.key] = series;
    const name = 'Show.Name.S01E01.1080p.WEB-DL-GRP';
    pipe.tracker.state.items = [{ title: name, size: 60 * 45 * MIB }];
    pipe.finder.requestSearch(series.key);
    const entry = pipe.queue.get('tv:1:1x1')!;
    await until(() => entry.stage === 'downloading');
    // Two videos, and no name that says the episode: ladarr can not pick one.
    pipe.complete(name, { 'a.mkv': 'first', 'b.mkv': 'second-file' });
    await until(() => entry.reason?.code === 'file_not_found');
    expect((await api.get('/queue/entries/tv:1:1x1')).body.entry.reason).toMatchObject({ action: 'match' });

    expect((await api.post('/queue/entries/tv:1:1x1/match', { file: 'b.mkv', covers: [{ season: 1, number: 1 }] })).status).toBe(200);
    await until(() => entry.stage === 'available');
    const file = Object.values(pipe.db.data.files)[0]!;
    expect(file.path).toBe('Show Name (2020)/Season 01/Show Name - S01E01 - Episode 1.mkv');
    expect(entry.attempts.map((a) => a.reason)).toEqual(['search requested', 'retry']);
  });
});

describe('jobs', () => {
  // A paused queue keeps the search and the import jobs waiting, so the list does not change while the test reads it.
  async function start() {
    pipe = await startPipeline();
    api = await pipe.api();
    pipe.db.data.queuePaused = true;
    const film = movie({ rootId: 'movie', manualRelease: true });
    pipe.db.data.titles[film.key] = film;
    return { film, entry: pipe.queue.ensure(film.key, null, null) };
  }

  const search = (entry: { titleKey: string; id: string }, runAt?: number) =>
    enqueue({ type: 'queue.search', payload: { titleKey: entry.titleKey, season: null, entryIds: [entry.id] }, runAt });

  const searchJobs = () => Object.values(pipe!.db.data.jobs).filter((job) => job.type === 'queue.search');

  // A film that finds no release, with the search that ended and the job that waits for the next one.
  async function startWaiting() {
    pipe = await startPipeline();
    api = await pipe.api();
    const film = movie({ rootId: 'movie', manualRelease: true });
    pipe.db.data.titles[film.key] = film;
    pipe.tracker.state.items = [];
    const [entry] = pipe.finder.requestSearch(film.key);
    await until(() => entry!.branch === 'waiting');
    await until(() => !searchJobs().some((job) => job.state === 'running'));
    return { film, entry: entry! };
  }

  it('lists the waiting and the running jobs of the item flow', async () => {
    const { film, entry } = await start();
    const later = Date.now() + 60_000;
    const allowed = [
      enqueue({ type: 'queue.initial', payload: { key: film.key } }),
      search(entry),
      enqueue({ type: 'queue.grab', payload: { entryIds: [entry.id] }, runAt: later }),
      enqueue({ type: 'import.run', payload: { hash: 'a' }, runAt: later }),
    ];
    // The worker holds one job of the item flow. The list shows it above the jobs that wait.
    const running = search(entry, later);
    running.state = 'running';
    running.leaseOwner = 'test';
    running.leaseExpiresAt = Date.now() + 60_000;
    // A job outside the item flow stays out of the list, also when the worker holds it.
    const otherRunning = enqueue({ type: 'queue.rss', runAt: later });
    otherRunning.state = 'running';
    otherRunning.leaseOwner = 'test';
    otherRunning.leaseExpiresAt = Date.now() + 60_000;
    const others = [
      otherRunning,
      enqueue({ type: 'backup.auto', runAt: later }),
      enqueue({ type: 'test.wait', payload: { name: 'x' }, runAt: later }),
      enqueue({ type: 'metadata.sweep', runAt: later }),
    ];

    const jobs = await api!.get('/queue/jobs');
    expect(jobs.status).toBe(200);
    const items = jobs.body.items;
    const listed = items.map((item: { id: string }) => item.id);
    expect(listed).toEqual(expect.arrayContaining([...allowed.map((job) => job.id), running.id]));
    for (const job of others) expect(listed).not.toContain(job.id);
    expect(items.map((item: { type: string }) => item.type).sort()).toEqual(['import.run', 'queue.grab', 'queue.initial', 'queue.search', 'queue.search']);
    // The job that the worker holds comes before every job that waits.
    expect(items[0]).toMatchObject({ id: running.id, type: 'queue.search', state: 'running' });
    for (const item of items.slice(1)) expect(item.state).toBe('waiting');
    // Every job carries its payload and its timing, the state, and the fields of the item flow.
    for (const item of items) {
      expect(item).toEqual(
        expect.objectContaining({
          id: expect.any(String),
          type: expect.any(String),
          state: expect.stringMatching(/^(waiting|running)$/),
          runAt: expect.any(Number),
          attempts: expect.any(Number),
          eta: expect.any(Number),
        }),
      );
      expect(item).toHaveProperty('payload');
      expect(item).toHaveProperty('priority');
      expect(item).toHaveProperty('lastError');
      expect(item.label === null || typeof item.label === 'string').toBe(true);
    }
  });

  it('lists the running job first, then the waiting jobs in the order that the worker starts them', async () => {
    pipe = await startPipeline();
    api = await pipe.api();
    pipe.db.data.queuePaused = true;
    // The import jobs stay waiting while the queue is paused.
    const waiting = (hash: string, runAt: number, priority = false) => enqueue({ type: 'import.run', payload: { hash }, runAt, priority });

    // The priority job starts before every waiting job of the normal lane, also when it is due later.
    const first = waiting('priority', 9_000, true);
    const late = waiting('late', 4_000);
    const tieA = waiting('tie-a', 3_000);
    const tieB = waiting('tie-b', 3_000);
    const early = waiting('early', 2_000);
    // A job that the worker holds comes before every waiting job, also when it is due later. A job that failed is not listed.
    const running = waiting('running', 10_000);
    running.state = 'running';
    running.leaseOwner = 'test';
    running.leaseExpiresAt = Date.now() + 60_000;
    const failed = waiting('failed', 1_000);
    failed.state = 'failed';
    failed.lastError = { kind: 'outage', message: 'boom' };

    const jobs = await api.get('/queue/jobs');
    expect(jobs.status).toBe(200);
    const items = jobs.body.items.filter((item: { type: string }) => item.type === 'import.run');
    // The running job comes first. Then the priority job, then the normal jobs follow their due time, and a tie keeps the order of the add.
    expect(items.map((item: { type: string; payload: { hash: string } }) => [item.type, item.payload.hash])).toEqual([
      ['import.run', 'running'],
      ['import.run', 'priority'],
      ['import.run', 'early'],
      ['import.run', 'tie-a'],
      ['import.run', 'tie-b'],
      ['import.run', 'late'],
    ]);
    expect(items.map((item: { id: string }) => item.id)).toEqual([running.id, first.id, early.id, tieA.id, tieB.id, late.id]);
    expect(items.map((item: { state: string }) => item.state)).toEqual(['running', 'waiting', 'waiting', 'waiting', 'waiting', 'waiting']);
    expect(items[0]).toMatchObject({ state: 'running', runAt: 10_000 });
    expect(items[1]).toMatchObject({ state: 'waiting', runAt: 9_000, attempts: 0, priority: expect.any(Number), lastError: null, eta: expect.any(Number) });
    expect(items[2]).toMatchObject({ state: 'waiting', runAt: 2_000, priority: null });
    // The job that failed is absent from the list.
    const listed = jobs.body.items.map((item: { id: string }) => item.id);
    expect(listed).not.toContain(failed.id);
  });

  // The Activity page shows Searching while a search runs. The panel must show the job that runs it.
  it('shows the search job that the worker runs while the page shows Searching', async () => {
    const { film, entry } = await start();
    const job = search(entry);
    job.state = 'running';
    job.leaseOwner = 'test';
    job.leaseExpiresAt = Date.now() + 60_000;

    const items = (await api!.get('/queue/jobs')).body.items;
    expect(items.map((item: { id: string; state: string }) => [item.id, item.state])).toEqual([[job.id, 'running']]);
    expect(items[0]).toMatchObject({
      type: 'queue.search',
      state: 'running',
      payload: { titleKey: film.key, season: null, entryIds: [entry.id] },
      label: 'Movie Name (2019)',
    });
  });

  it('names the poster of the title of a job', async () => {
    const { film, entry } = await start();
    film.meta.posterPath = '/movie.jpg';
    const job = search(entry);

    const item = (await api!.get('/queue/jobs')).body.items.find((row: { id: string }) => row.id === job.id);
    expect(item.posterPath).toBe('/movie.jpg');
  });

  it('estimates a start for a search after the next request of its indexer', async () => {
    const { entry } = await start();
    const next = Date.now() + 60_000;
    pipe!.db.data.indexers[1]!.nextRequestAt = next;
    const job = search(entry);

    const item = (await api!.get('/queue/jobs')).body.items.find((row: { id: string }) => row.id === job.id);
    expect(item.eta).toBeGreaterThanOrEqual(next - 2_000);
  });

  it('estimates a start for an import without the wait of an indexer', async () => {
    await start();
    const next = Date.now() + 60_000;
    pipe!.db.data.indexers[1]!.nextRequestAt = next;
    const job = enqueue({ type: 'import.run', payload: { hash: 'a' } });

    const item = (await api!.get('/queue/jobs')).body.items.find((row: { id: string }) => row.id === job.id);
    expect(item.eta).toBeLessThan(next);
  });

  it('names a search job after the first target of its payload', async () => {
    const { film, entry } = await start();
    const other = movie({ key: 'movie:3', tmdbId: 3, rootId: 'movie', manualRelease: true, meta: { ...film.meta, tmdbId: 3, title: 'Other Movie', originalTitle: 'Other Movie' } });
    pipe!.db.data.titles[other.key] = other;
    const second = pipe!.queue.ensure(other.key, null, null);
    const job = enqueue({ type: 'queue.search', payload: { titleKey: film.key, season: null, entryIds: [entry.id, second.id] } });

    const item = (await api!.get('/queue/jobs')).body.items.find((row: { id: string }) => row.id === job.id);
    expect(item.label).toBe('Movie Name (2019)');
  });

  it('lists the search job that waits for the next search of a target', async () => {
    const { film, entry } = await startWaiting();
    const items = (await api!.get('/queue/jobs')).body.items.filter((item: { type: string }) => item.type === 'queue.search');

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: 'queue.search',
      state: 'waiting',
      payload: { titleKey: film.key, season: null, entryIds: [entry.id] },
      label: 'Movie Name (2019)',
    });
    expect(items[0].eta).toBeGreaterThanOrEqual(entry.search!.nextAt! - 2_000);
    expect(items[0].eta).toBeLessThanOrEqual(entry.search!.nextAt! + 2_000);
  });

  it('drops the search job that waits when its target is complete', async () => {
    const { entry } = await startWaiting();
    // The job is listed while the target waits for its next search.
    expect((await api!.get('/queue/jobs')).body.items.filter((item: { type: string }) => item.type === 'queue.search')).toHaveLength(1);

    pipe!.queue.move(entry, { stage: 'available', branch: null }, 'test');
    // Every target is complete, so the queue of the item flow has no job.
    expect((await api!.get('/queue/jobs')).body.items).toEqual([]);
  });

  it('keeps a running job above the search job that waits for the next search', async () => {
    const { film, entry } = await startWaiting();
    // The running job is due after the waiting one, so only its state puts it first.
    const running = enqueue({ type: 'queue.search', payload: { titleKey: film.key, season: null, entryIds: [entry.id] }, runAt: entry.search!.nextAt! + 60_000 });
    running.state = 'running';
    running.leaseOwner = 'test';
    running.leaseExpiresAt = Date.now() + 60_000;

    const items = (await api!.get('/queue/jobs')).body.items.filter((item: { type: string }) => item.type === 'queue.search');
    expect(items).toHaveLength(2);
    expect(items.map((item: { state: string }) => item.state)).toEqual(['running', 'waiting']);
    expect(items[0].id).toBe(running.id);
  });

  it('marks a waiting job of a target as priority from the jobs list', async () => {
    const { entry } = await start();
    const job = search(entry);
    const other = enqueue({ type: 'queue.rss', runAt: Date.now() + 60_000 });
    const running = search(entry);
    running.state = 'running';
    running.leaseOwner = 'test';
    running.leaseExpiresAt = Date.now() + 60_000;

    expect((await api!.post(`/queue/jobs/${job.id}/priority`)).status).toBe(200);
    expect(typeof pipe!.db.data.jobs[job.id]!.priority).toBe('number');
    // A job that is not of a target, and a job that the worker holds, are refused.
    expect((await api!.post(`/queue/jobs/${other.id}/priority`)).status).toBe(404);
    expect((await api!.post(`/queue/jobs/${running.id}/priority`)).status).toBe(409);
  });

  it('runs a waiting job of a target now from the jobs list', async () => {
    const { entry } = await start();
    const job = search(entry, Date.now() + 60_000);
    const other = enqueue({ type: 'queue.rss', runAt: Date.now() + 60_000 });
    const running = search(entry, Date.now() + 60_000);
    running.state = 'running';
    running.leaseOwner = 'test';
    running.leaseExpiresAt = Date.now() + 60_000;

    expect((await api!.post(`/queue/jobs/${job.id}/run`)).status).toBe(200);
    expect(pipe!.db.data.jobs[job.id]!.runAt).toBeLessThanOrEqual(Date.now());
    // A job that is not of a target, and a job that the worker holds, are refused.
    expect((await api!.post(`/queue/jobs/${other.id}/run`)).status).toBe(404);
    expect((await api!.post(`/queue/jobs/${running.id}/run`)).status).toBe(409);
  });

  it('removes a waiting job of a target from the jobs list', async () => {
    const { entry } = await start();
    const job = search(entry);
    const other = enqueue({ type: 'queue.rss', runAt: Date.now() + 60_000 });
    const running = search(entry);
    running.state = 'running';
    running.leaseOwner = 'test';
    running.leaseExpiresAt = Date.now() + 60_000;

    expect((await api!.del(`/queue/jobs/${job.id}`)).status).toBe(200);
    expect(pipe!.db.data.jobs[job.id]).toBeUndefined();
    // A job that is not of a target, and a job that the worker holds, are refused.
    expect((await api!.del(`/queue/jobs/${other.id}`)).status).toBe(404);
    expect((await api!.del(`/queue/jobs/${running.id}`)).status).toBe(409);
    expect(pipe!.db.data.jobs[running.id]).toBeDefined();
  });

  it('removes the future search of a target and stops the sweep from putting it back', async () => {
    const { film, entry } = await startWaiting();
    const job = searchJobs().find((item) => (item.payload as { titleKey: string }).titleKey === film.key)!;
    expect(job.runAt).toBeGreaterThan(Date.now());

    expect((await api!.del(`/queue/jobs/${job.id}`)).status).toBe(200);
    expect(pipe!.db.data.jobs[job.id]).toBeUndefined();
    expect(entry).toMatchObject({ branch: null, reason: { code: 'job_removed' } });
    expect(entry.search!.nextAt).toBeNull();

    // The target waits no more, so the sweep puts no search for the same title back.
    pipe!.finder.sweep();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(searchJobs().filter((item) => (item.payload as { titleKey: string }).titleKey === film.key)).toEqual([]);
    expect((await api!.get('/queue/jobs')).body.items.filter((item: { type: string }) => item.type === 'queue.search')).toEqual([]);
  });
});

describe('download clients', () => {
  const body = (port: number, extra = {}) => ({ name: 'Main', type: 'qbittorrent', host: '127.0.0.1', port, auth: { type: 'password', username: 'admin', password: 'secret' }, ...extra });

  it('sends the release that waited for a client when the user adds one', async () => {
    const film = await withMovie();
    pipe!.db.data.downloadClients = [];
    await api!.post('/queue/search', { titleKey: film.key });
    await until(() => pipe!.queue.get('movie:2')!.reason?.code === 'client_missing');
    // With no client, the release stops before the add, so it never left fetching.
    expect(pipe!.queue.get('movie:2')).toMatchObject({ stage: 'fetching', reason: { code: 'client_missing' } });
    expect((await api!.post('/clients', body(pipe!.qbit.port))).status).toBe(201);
    await until(() => pipe!.queue.get('movie:2')!.stage === 'downloading');
    expect(pipe!.queue.get('movie:2')!.reason).toBeNull();
  });

  it('sends a release of an indexer that is gone, with an indexer that ladarr has', async () => {
    const film = await withMovie();
    pipe!.db.data.downloadClients = [];
    await api!.post('/queue/search', { titleKey: film.key });
    const entry = pipe!.queue.get('movie:2')!;
    await until(() => entry.reason?.code === 'client_missing');
    // An entry from an older file keeps its stage and its release when no client is set.
    pipe!.queue.move(entry, { stage: 'sending' }, 'test');
    // The user removes the indexer and adds it again, so the id changes. The release keeps the old id.
    const old = pipe!.db.data.indexers[1]!;
    delete pipe!.db.data.indexers[1];
    pipe!.db.data.indexers[2] = indexerFixture({ id: 2, baseUrl: old.baseUrl });
    expect(entry.release?.indexerId).toBe(1);
    expect((await api!.post('/clients', body(pipe!.qbit.port))).status).toBe(201);
    await until(() => entry.stage === 'downloading');
    expect(entry.reason).toBeNull();
  });

  it('tests the settings before they are saved, adds a client to the list, and shows no secret', async () => {
    pipe = await startPipeline();
    api = await pipe.api();
    pipe.db.data.downloadClients = [];
    const draft = body(pipe.qbit.port);
    expect((await api.post('/clients/test', draft)).body).toMatchObject({ ok: true, apiVersion: '2.11.3' });
    expect((await api.get('/clients')).body.clients).toEqual([]);

    const saved = await api.post('/clients', draft);
    expect(saved.status).toBe(201);
    expect(saved.body.client).toMatchObject({ name: 'Main', type: 'qbittorrent', host: '127.0.0.1', port: pipe.qbit.port, auth: 'password', username: 'admin', enabled: true });
    expect(JSON.stringify(saved.body)).not.toContain('secret');
    const listed = (await api.get('/clients')).body.clients;
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain('secret');
    expect((await api.post(`/clients/${saved.body.client.id}/test`)).body).toMatchObject({ ok: true });
    expect((await api.post('/clients/missing/test')).status).toBe(404);

    const wrong = await api.post('/clients/test', body(pipe.qbit.port, { auth: { type: 'password', username: 'admin', password: 'wrong' } }));
    expect(wrong.body).toEqual({ ok: false, code: 'rejected' });
    // A second client goes after the first one.
    await api.post('/clients', body(pipe.qbit.port, { name: 'Second', enabled: false }));
    expect((await api.get('/clients')).body.clients.map((client: { name: string; enabled: boolean }) => [client.name, client.enabled])).toEqual([['Main', true], ['Second', false]]);
  });

  it('changes a client and keeps its secret, tests the changes before they are saved, and removes the client', async () => {
    pipe = await startPipeline();
    api = await pipe.api();
    const id = pipe.db.data.downloadClients[0]!.id;
    // A body with no password keeps the saved one. The test uses the changes, and it saves nothing.
    const draft = { name: 'Renamed', type: 'qbittorrent', host: '127.0.0.1', port: pipe.qbit.port, auth: { type: 'password', username: 'admin' }, enabled: false };
    expect((await api.post(`/clients/${id}/test`, draft)).body).toMatchObject({ ok: true });
    expect(pipe.db.data.downloadClients[0]!.name).toBe('qBittorrent');
    expect((await api.post(`/clients/${id}/test`, { ...draft, auth: { type: 'password', username: 'admin', password: 'wrong' } })).body).toEqual({ ok: false, code: 'rejected' });
    expect((await api.post(`/clients/${id}/test`, { ...draft, auth: { type: 'apiKey' } })).body).toEqual({ error: 'invalid_setting', field: 'apiKey' });

    const saved = await api.fetchJson('PUT', `/clients/${id}`, draft);
    expect(saved.status).toBe(200);
    expect(saved.body.client).toMatchObject({ id, name: 'Renamed', enabled: false, auth: 'password', username: 'admin' });
    expect(pipe.db.data.downloadClients[0]!.auth).toEqual({ type: 'password', username: 'admin', password: 'secret' });
    expect((await api.fetchJson('PUT', `/clients/${id}`, { ...draft, port: 0 })).body.field).toBe('port');
    expect((await api.fetchJson('PUT', '/clients/missing', draft)).status).toBe(404);

    expect((await api.del(`/clients/${id}`)).status).toBe(204);
    expect(pipe.db.data.downloadClients).toEqual([]);
    expect((await api.del(`/clients/${id}`)).status).toBe(404);
  });

  it('refuses settings that are not valid', async () => {
    pipe = await startPipeline();
    api = await pipe.api();
    const field = async (extra: object) => (await api!.post('/clients', body(pipe!.qbit.port, extra))).body.field;
    expect(await field({ name: ' ' })).toBe('name');
    expect(await field({ type: 'transmission' })).toBe('type');
    expect(await field({ host: '' })).toBe('host');
    expect(await field({ host: 'http://user:pass@host' })).toBe('host');
    expect(await field({ port: 0 })).toBe('port');
    expect(await field({ port: '8080' })).toBe('port');
    expect(await field({ auth: { type: 'apiKey', apiKey: ' ' } })).toBe('apiKey');
    expect(await field({ auth: { type: 'password', username: '', password: 'x' } })).toBe('username');
    expect(await field({ auth: { type: 'token' } })).toBe('auth');
    expect(await field({ enabled: 'yes' })).toBe('enabled');
    expect(pipe.db.data.downloadClients).toHaveLength(1);
  });
});
