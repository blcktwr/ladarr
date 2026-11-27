import { afterEach, expect, it, vi } from 'vitest';
import { episode, movie, title } from '../helpers/test-fixtures.ts';
import { hashOf, MIB, startPipeline, type FakeItem } from '../helpers/test-pipeline.ts';
import type { ClientConfig } from '../../src/types.ts';

let pipe: Awaited<ReturnType<typeof startPipeline>>;
let api: Awaited<ReturnType<typeof pipe.api>> | undefined;
afterEach(async () => {
  api?.close();
  api = undefined;
  await pipe?.stop();
});

const EPISODE_SIZE = 60 * 45 * MIB;
const PACK = 'Show.Name.S01.1080p.WEB-DL-PACK';
const COMPLETE = 'Show.Name.S01.1080p.WEB-DL-FULL';
const SINGLE = 'Show.Name.S01E03.1080p.WEB-DL-SINGLE';
const WRONG = 'Show.Name.S01E03.1080p.WEB-DL-WRONG';
const MOVIE = 'Movie.Name.2019.1080p.BluRay-MOVIE';
const file = (n: number) => `Show.Name.S01E0${n}.mkv`;
const seasonSearch = { type: 'search', season: '1', episode: null };
const episodeSearch = (n: number) => ({ type: 'search', season: '1', episode: String(n) });
const missingSearch = episodeSearch(3);
const read = (item: FakeItem) => ({ type: 'torrent', title: item.title });
const add = (item: FakeItem) => ({ type: 'add', hash: hashOf(item.title, item.files) });
const anyAdd = expect.objectContaining({ type: 'add' });
const pack = (name: string, files: string[], count: number, seeders = 20): FakeItem => ({ title: name, size: count * EPISODE_SIZE, files, seeders });
const partial = () => pack(PACK, [file(1), file(2), 'Bonus/' + file(2), 'Sample/' + file(3), 'readme.nfo'], 2, 100);
const full = () => pack(COMPLETE, [file(1), file(2), file(3)], 3);
const single = () => pack(SINGLE, [file(3)], 1);
const episodeItem = (n: number) => pack(`Show.Name.S01E0${n}.1080p.WEB-DL-SINGLE`, [file(n)], 1);
const film = { title: MOVIE, size: 100 * 120 * MIB, category: 2040 };

async function setup(numbers = [1, 2, 3], options?: Parameters<typeof startPipeline>[0]) {
  pipe = await startPipeline(options);
  const series = title({ rootId: 'tv', episodes: numbers.map((n) => episode(1, n)) });
  pipe.db.data.titles[series.key] = series;
  api = await pipe.api();
  return series;
}

function advertise(season: FakeItem[], missing: FakeItem[] = []) {
  pipe.tracker.state.answer = (url) => {
    if (url.searchParams.get('season') !== '1') return [];
    const ep = url.searchParams.get('ep');
    return ep === null ? season : Number(ep) === 3 ? missing : [];
  };
}

const group = async (key: string) => (await api!.get(`/queue/groups/${key}?season=1`)).body.group;
const entry = async (key: string) => (await api!.get(`/queue/entries/${key}`)).body.entry;

it('adds a complete pack once when one file identifies two episodes', async () => {
  const series = await setup();
  const complete = pack(COMPLETE, ['Show.Name.S01E01E02.mkv', file(3), 'Sample/sample.mkv', 'info.nfo'], 3);
  advertise([complete]);
  pipe.finder.requestSearch(series.key, { season: 1, manual: true, fresh: true });

  await expect.poll(async () => (await group(series.key)).status).toBe('downloading');
  expect(pipe.acquisition).toEqual([seasonSearch, read(complete), add(complete)]);
});

it('inspects a higher-ranked partial but submits only the later complete pack', async () => {
  const series = await setup();
  const first = partial();
  const complete = full();
  advertise([complete, first]);
  pipe.finder.requestSearch(series.key, { season: 1, manual: true, fresh: true });

  await expect.poll(() => pipe.acquisition).toEqual([seasonSearch, read(first), read(complete), add(complete)]);
  await expect.poll(async () => (await group(series.key)).status).toBe('downloading');
});

it('uses a single already returned with the partial pack instead of asking again', async () => {
  const series = await setup();
  pipe.db.data.qualitySizes.tv['webdl-1080'] = { min: 50, preferred: null, max: null };
  const first = partial();
  const last = single();
  advertise([first, last]);
  pipe.finder.requestSearch(series.key, { season: 1, manual: true, fresh: true });

  await expect.poll(() => pipe.acquisition).toEqual([seasonSearch, read(first), read(last), anyAdd, anyAdd]);
  expect(pipe.acquisition.slice(-2)).toEqual(expect.arrayContaining([add(first), add(last)]));
  await expect.poll(async () => (await group(series.key)).status).toBe('downloading');
});

it('queries only E03, rejects a misleading single and verifies both sources before either add', async () => {
  const series = await setup();
  const first = partial();
  const wrong = pack(WRONG, [file(2)], 1, 100);
  const last = single();
  advertise([first], [last, wrong]);
  pipe.finder.requestSearch(series.key, { season: 1, manual: true, fresh: true });

  await expect.poll(() => pipe.acquisition).toEqual([seasonSearch, read(first), missingSearch, read(wrong), read(last), anyAdd, anyAdd]);
  expect(pipe.acquisition.slice(-2)).toEqual(expect.arrayContaining([add(first), add(last)]));
  await expect.poll(async () => (await group(series.key)).status).toBe('downloading');
});

it.each([
  { packAvailable: true, numbers: [3, 4] },
  { packAvailable: false, numbers: [1, 2, 3, 4] },
])('queries every uncovered old episode with pack available: $packAvailable', async ({ packAvailable, numbers }) => {
  const series = await setup([1, 2, 3, 4]);
  const first = partial();
  const singles = numbers.map(episodeItem);
  pipe.tracker.state.answer = (url) => {
    if (url.searchParams.get('season') !== '1') return [];
    const ep = url.searchParams.get('ep');
    const single = singles[numbers.indexOf(Number(ep))];
    return ep === null ? (packAvailable ? [first] : []) : single ? [single] : [];
  };
  pipe.finder.requestSearch(series.key, { season: 1, fresh: true });

  const selected = packAvailable ? [first, ...singles] : singles;
  const searches = numbers.map(episodeSearch);
  await expect.poll(() => pipe.acquisition.filter((event) => event.type === 'search')).toHaveLength(1 + searches.length);
  await expect.poll(async () => (await group(series.key)).status).toBe('downloading');
  await expect.poll(() => pipe.acquisition.filter((event) => event.type === 'add')).toHaveLength(selected.length);
  expect(pipe.acquisition[0]).toEqual(seasonSearch);
  if (packAvailable) expect(pipe.acquisition[1]).toEqual(read(first));
  const split = pipe.acquisition.findIndex((event) => event.type === 'add');
  expect(pipe.acquisition.slice(1, split)).toHaveLength(searches.length + selected.length);
  expect(pipe.acquisition.slice(1, split)).toEqual(expect.arrayContaining([...searches, ...selected.map(read)]));
  expect(pipe.acquisition.slice(split)).toHaveLength(selected.length);
  expect(pipe.acquisition.slice(split)).toEqual(expect.arrayContaining(selected.map(add)));
});

it('counts empty E03 rounds, not indexer responses, and stops after three rounds', async () => {
  let now = Date.UTC(2026, 10, 26);
  using clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  const series = await setup();
  const first = partial();
  const tracker = pipe.db.data.indexers[1]!;
  pipe.db.data.indexers[2] = { ...structuredClone(tracker), id: 2, baseUrl: `http://127.0.0.1:${pipe.tracker.port}/2/` };
  pipe.tracker.state.answer = (url) => url.pathname.startsWith('/1/') && url.searchParams.get('season') === '1' && !url.searchParams.has('ep') ? [first] : [];
  pipe.finder.requestSearch(series.key, { season: 1, manual: true, fresh: true });

  const trace = [seasonSearch, seasonSearch, read(first), missingSearch, missingSearch];
  for (const round of [1, 2, 3]) {
    await expect.poll(() => pipe.acquisition).toEqual(trace);
    await expect.poll(async () => (await group(series.key)).status).toBe(round === 3 ? 'stuck' : 'not_found');
    if (round < 3) {
      pipe.finder.sweep();
      await expect.poll(async () => (await group(series.key)).status).toBe('not_found');
      expect(pipe.acquisition).toEqual(trace);
      now += 24 * 60 * 60 * 1000;
      trace.push(missingSearch, missingSearch);
      pipe.finder.sweep();
    }
  }

  now += 24 * 60 * 60 * 1000;
  pipe.finder.sweep();
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(await group(series.key)).toMatchObject({ status: 'stuck', tabs: ['stuck'] });
  expect(pipe.acquisition).toEqual(trace);
});

it.each([
  { paused: false, outcome: 'resumes the verified pack' },
  { paused: true, outcome: 'keeps the remaining episode paused' },
])('discards the only uncovered episode from Stuck and $outcome', async ({ paused }) => {
  let now = Date.UTC(2026, 10, 26);
  using clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  const commits: string[] = [];
  const series = await setup([1, 2], {
    afterStep(state, step) {
      if (state === 'committed') commits.push(step.source);
    },
  });
  const partial = pack(PACK, [file(1)], 1);
  const hash = hashOf(partial.title, partial.files);
  const kept = `${series.key}:1x1`;
  const discarded = `${series.key}:1x2`;
  advertise([partial]);
  pipe.finder.requestSearch(series.key, { season: 1, manual: true, fresh: true });
  const turn = pipe.queue.findItem(series.key, 1)!;
  for (const round of [1, 2, 3]) {
    await expect.poll(() => turn.emptySearches).toEqual({ [discarded]: round });
    if (round < 3) {
      now += 24 * 60 * 60 * 1000;
      pipe.finder.sweep();
    }
  }
  expect(await group(series.key)).toMatchObject({
    status: 'stuck', problem: { code: 'no_results' }, total: 2, reached: { matched: 1, completed: 0 },
    torrents: [{ status: 'prepared', release: { title: partial.title } }],
  });
  expect(turn.selected[hash]).toMatchObject({ status: 'prepared', matches: { [kept]: `${PACK}/${file(1)}` } });
  const trace = [seasonSearch, read(partial), episodeSearch(2), episodeSearch(2), episodeSearch(2)];
  expect(pipe.acquisition).toEqual(trace);

  if (paused) expect((await api!.post('/queue/actions', { action: 'pause', ids: [kept] })).status).toBe(200);
  const beforeDiscard = structuredClone(pipe.queue.get(kept)!.state);
  if (paused) expect(beforeDiscard.kind).toBe('paused');
  expect((await api!.del(`/library/${series.key}/episodes/1/2`)).status).toBe(200);
  expect(series.episodes[1]).toMatchObject({ override: 'unmonitored', fileId: null });
  expect(pipe.queue.get(discarded)).toBeUndefined();
  pipe.finder.sweep();

  if (paused) {
    await pipe.worker.drain();
    expect(pipe.queue.get(kept)?.state).toEqual(beforeDiscard);
    expect(Object.values(pipe.db.data.jobs).filter((job) => job.type === 'queue.send')).toEqual([]);
    expect(pipe.acquisition).toEqual(trace);
    expect(commits).toEqual([]);
    return;
  }

  const resumedTrace = [...trace, add(partial)];
  await expect.poll(async () => ({ status: (await group(series.key)).status, trace: pipe.acquisition })).toEqual({
    status: 'downloading', trace: resumedTrace,
  });
  pipe.complete(PACK, { [file(1)]: 'episode-one' }, hash);
  await expect.poll(async () => (await group(series.key)).status).toBe('available');
  await pipe.poller.tick();
  await pipe.worker.drain();
  expect(pipe.acquisition).toEqual(resumedTrace);
  expect(commits).toEqual([`${PACK}/${file(1)}`]);
  expect(Object.values(pipe.db.data.files)).toMatchObject([
    { id: series.episodes[0]!.fileId, episodes: [{ season: 1, number: 1 }], download: { hash } },
  ]);
});

it('stops for manual mapping when the pack contains conflicting episode numbering', async () => {
  const series = await setup([3, 4]);
  const conflicting = pack(PACK, [file(1), file(3)], 2);
  advertise([conflicting]);
  pipe.finder.requestSearch(series.key, { season: 1, manual: true, fresh: true });

  await expect.poll(() => pipe.acquisition).toEqual([seasonSearch, read(conflicting)]);
  await expect.poll(async () => (await group(series.key)).status).toBe('stuck');
  const message = 'The releases available do not contain all the episodes.';
  expect(await group(series.key)).toMatchObject({
    tabs: ['stuck'], reached: { matched: 0 },
    problem: { code: 'file_unmapped', message },
    actions: expect.arrayContaining([expect.objectContaining({ action: 'match', label: 'Map episodes manually' })]),
    torrents: [],
    rejected: [{ release: { title: conflicting.title, reasons: [message] } }],
  });
  const saved = pipe.queue.findItem(series.key, 1)!.search!.rejected[0]!;
  saved.reasons = ['The torrent files do not contain all the requested episodes.'];
  const [{ entryId, release }] = (await group(series.key)).rejected;
  expect(release).toMatchObject({ reasons: [message], selectable: false });
  expect(await api!.post(`/queue/entries/${entryId}/releases/grab`, { indexerId: release.indexerId, guid: release.guid })).toMatchObject({
    status: 409, body: { error: 'release_rejected', rejections: [{ code: 'file_unmapped', message }] },
  });
  expect(pipe.acquisition).toEqual([seasonSearch, read(conflicting)]);
});

it('continues to a complete alternative when the first pack has conflicting numbering', async () => {
  const series = await setup([3, 4]);
  const conflicting = pack(PACK, [file(1), file(3)], 2, 100);
  const complete = pack(COMPLETE, [file(3), file(4)], 2);
  advertise([complete, conflicting]);
  pipe.finder.requestSearch(series.key, { season: 1, manual: true, fresh: true });

  await expect.poll(() => pipe.acquisition).toEqual([seasonSearch, read(conflicting), read(complete), add(complete)]);
});

it('reads torrent metadata without a client and resumes submission when one is configured', async () => {
  const series = await setup();
  const [client] = pipe.db.data.downloadClients.splice(0);
  const complete = full();
  advertise([complete]);
  pipe.finder.requestSearch(series.key, { season: 1, manual: true, fresh: true });

  await expect.poll(() => pipe.acquisition).toEqual([seasonSearch, read(complete)]);
  expect((await group(series.key)).status).toBe('fetching');
  expect(pipe.acquisition).toEqual([seasonSearch, read(complete)]);

  const { id: _, ...config } = client!;
  expect((await api!.post('/clients', config)).status).toBe(201);
  pipe.finder.sweep();
  await expect.poll(async () => (await group(series.key)).status, { timeout: 3_000 }).toBe('downloading');
  expect(pipe.acquisition).toEqual([seasonSearch, read(complete), add(complete)]);
});

it('does not add a torrent if the client disappears during the metadata read', async () => {
  const complete = full();
  let clients: ClientConfig[] | undefined;
  const series = await setup(undefined, {
    onAcquisition: (event) => {
      if (!clients && event.type === 'torrent' && event.title === complete.title) {
        clients = pipe.db.data.downloadClients;
        pipe.db.data.downloadClients = [];
      }
    },
  });
  advertise([complete]);
  pipe.finder.requestSearch(series.key, { season: 1, manual: true, fresh: true });

  await expect.poll(() => pipe.acquisition).toEqual([seasonSearch, read(complete)]);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect.soft((await group(series.key)).status).toBe('fetching');
  expect(pipe.acquisition).toEqual([seasonSearch, read(complete)]);

  pipe.db.data.downloadClients = clients!;
  pipe.finder.sweep();
  await expect.poll(async () => (await group(series.key)).status, { timeout: 3_000 }).toBe('downloading');
  expect(pipe.acquisition).toEqual([seasonSearch, read(complete), add(complete)]);
});

it('holds a verified selection in Fetching while the client is full', async () => {
  const series = await setup();
  const m = movie({ rootId: 'movie', manualRelease: true });
  pipe.db.data.titles[m.key] = m;
  pipe.db.data.downloadClients[0]!.maxDownloads = 1;
  const complete = full();
  pipe.tracker.state.answer = (url) => url.searchParams.get('season') === '1' ? [complete] : [film];
  pipe.finder.requestSearch(m.key);
  await expect.poll(async () => (await entry(m.key))?.status).toBe('downloading');
  const start = pipe.acquisition.length;

  pipe.finder.requestSearch(series.key, { season: 1, manual: true, fresh: true });
  await expect.poll(() => pipe.acquisition.slice(start)).toEqual([seasonSearch, read(complete)]);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect.soft((await group(series.key)).status).toBe('fetching');
  expect(pipe.acquisition.slice(start)).toEqual([seasonSearch, read(complete)]);

  pipe.qbit.progress(hashOf(MOVIE), 1);
  await expect.poll(async () => (await group(series.key)).status, { timeout: 5_000 }).toBe('downloading');
  expect(pipe.acquisition.slice(start)).toEqual([seasonSearch, read(complete), add(complete)]);
});

it('submits a two-torrent selection one hash at a time when there is one slot', async () => {
  const series = await setup();
  pipe.db.data.downloadClients[0]!.maxDownloads = 1;
  const first = partial();
  const last = single();
  advertise([first, last]);
  pipe.finder.requestSearch(series.key, { season: 1, manual: true, fresh: true });

  await expect.poll(async () => (await group(series.key)).status).toBe('downloading');
  const prepared = [seasonSearch, read(first), read(last)];
  const sent = pipe.acquisition.at(-1);
  expect(pipe.acquisition).toEqual([...prepared, anyAdd]);
  expect([add(first), add(last)]).toContainEqual(sent);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(pipe.acquisition).toEqual([...prepared, sent]);

  const [acceptedHash] = pipe.qbit.torrents.keys();
  pipe.qbit.progress(acceptedHash!, 1);
  await expect.poll(() => pipe.acquisition).toEqual([...prepared, anyAdd, anyAdd]);
  expect(pipe.acquisition.slice(-2)).toEqual(expect.arrayContaining([add(first), add(last)]));
});
