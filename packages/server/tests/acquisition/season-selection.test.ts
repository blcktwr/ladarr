import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { episode, movie, title } from '../helpers/test-fixtures.ts';
import { hashOf, MIB, startFakeTracker, startPipeline, type FakeItem } from '../helpers/test-pipeline.ts';
import type { ClientConfig, Title } from '../../src/types.ts';

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
const file = (n: number) => `Show.Name.S01E${String(n).padStart(2, '0')}.mkv`;
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
const DAY = 24 * 60 * 60 * 1000;

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
const adds = () => pipe.acquisition.filter(({ type }) => type === 'add');
const queueJobs = () => Object.values(pipe.db.data.jobs).filter(({ type }) => type === 'queue.search' || type === 'queue.send');

// Episodes that have a file in the library already.
function inLibrary(series: Title, numbers: number[]) {
  for (const item of series.episodes.filter(({ number }) => numbers.includes(number))) {
    item.fileId = `file-${item.number}`;
    pipe.db.data.files[item.fileId] = {
      id: item.fileId, titleKey: series.key, path: `Show Name/${file(item.number)}`, sizeBytes: 1000, mtimeMs: 0, addedAt: 1,
      missing: false, episodes: [{ season: 1, number: item.number }],
    };
  }
}

// The season is stuck for the episodes without a source. Nothing goes to the client, and no later sweep searches again.
async function expectStoppedByPartialPack(key: string, missing: number[]) {
  await expect.poll(async () => (await group(key)).status, { timeout: 3_000 }).toBe('stuck');
  expect(await group(key)).toMatchObject({ tabs: ['stuck'], problem: { code: 'pack_partial' }, counts: { stuck: missing.length }, nextAt: null });
  for (const n of missing) expect(await entry(`${key}:1x${n}`)).toMatchObject({ status: 'stuck', reason: { code: 'pack_partial' } });
  await expect.poll(queueJobs).toEqual([]);
  const trace = [...pipe.acquisition];
  const now = Date.now();
  for (const days of [1, 3, 30]) {
    using _clock = vi.spyOn(Date, 'now').mockImplementation(() => now + days * DAY);
    pipe.finder.sweep();
    expect(queueJobs()).toEqual([]);
  }
  expect(pipe.acquisition).toEqual(trace);
  expect(adds()).toEqual([]);
  expect(pipe.qbit.torrents.size).toBe(0);
}

it('adds a complete pack once when one file identifies two episodes', async () => {
  const series = await setup();
  const complete = pack(COMPLETE, ['Show.Name.S01E01E02.mkv', file(3), 'Sample/sample.mkv', 'info.nfo'], 3);
  advertise([complete]);
  pipe.finder.requestSearch(series.key, { season: 1, manual: true, fresh: true });

  await expect.poll(async () => (await group(series.key)).status).toBe('downloading');
  expect(pipe.acquisition).toEqual([seasonSearch, read(complete), add(complete)]);
});

it.each([
  { catalog: [63, 64, 65], source: [1, 2, 3] },
  { catalog: [1, 2, 3], source: [63, 64, 65] },
  { catalog: [2, 3, 4], source: [1, 2, 3] },
])('matches a complete season with catalog numbers $catalog and torrent numbers $source', async ({ catalog, source }) => {
  const series = await setup(catalog);
  const complete = pack(PACK, [...source].reverse().map(file), catalog.length);
  advertise([complete]);
  pipe.finder.requestSearch(series.key, { season: 1, fresh: true });

  await expect.poll(async () => (await group(series.key)).counts.downloading).toBe(catalog.length);
  expect(pipe.acquisition).toEqual([seasonSearch, read(complete), add(complete)]);
  const hash = hashOf(PACK, complete.files);
  expect(pipe.queue.findItem(series.key, 1)!.selected[hash]?.matches).toEqual(Object.fromEntries(
    catalog.map((n, i) => [`${series.key}:1x${n}`, `${PACK}/${file(source[i]!)}`]),
  ));
  pipe.complete(PACK, Object.fromEntries(source.map((n) => [file(n), `episode-${n}`])), hash);
  await expect.poll(async () => (await group(series.key)).counts.available).toBe(catalog.length);
  for (const [i, episode] of series.episodes.entries()) {
    expect(pipe.db.data.files[episode.fileId!]).toMatchObject({
      episodes: [{ season: 1, number: episode.number }], download: { file: file(source[i]!), hash },
    });
  }
});

it.each([true, false])('checks the accepted file of a renumbered download on retry (file present: %s)', async (present) => {
  const series = await setup([63, 64]);
  const complete = pack(PACK, [file(1), file(2)], 2);
  advertise([complete]);
  pipe.finder.requestSearch(series.key, { season: 1, fresh: true });
  await expect.poll(async () => (await group(series.key)).counts.downloading).toBe(2);
  pipe.poller.stop();
  const target = pipe.queue.get(`${series.key}:1x63`)!;
  const hash = hashOf(PACK, complete.files);
  pipe.qbit.setFiles(hash, [{ name: file(present ? 1 : 63), size: 1000, progress: 0.5 }]);
  pipe.queue.block(target, { code: 'client_error' }, 'download interrupted');
  expect((await api!.post('/queue/actions', { action: 'check_download', ids: [target.id] })).status).toBe(200);
  await expect.poll(() => target.state).toMatchObject(present
    ? { kind: 'downloading' }
    : { kind: 'blocked', problem: { code: 'pack_partial' } });
  expect(pipe.acquisition).toEqual([seasonSearch, read(complete), add(complete)]);
});

it('rechecks a rejected pack when the full catalog season now matches its numbering', async () => {
  const series = await setup([3, 4, 5]);
  const complete = pack(PACK, [file(1), file(2), file(3), file(4)], 4);
  advertise([complete]);
  pipe.finder.requestSearch(series.key, { season: 1, fresh: true });
  await expect.poll(async () => (await group(series.key)).problem?.code).toBe('file_unmapped');
  const [{ entryId, release }] = (await group(series.key)).rejected;
  series.episodes.push(episode(1, 6));
  expect(await api!.post(`/queue/entries/${entryId}/releases/grab`, { indexerId: release.indexerId, guid: release.guid, scope: 'season' })).toMatchObject({ status: 202 });
  await expect.poll(async () => (await group(series.key)).counts.downloading).toBe(3);
  expect(pipe.acquisition).toEqual([seasonSearch, read(complete), add(complete)]);
});

it.each([false, true])('accepts a quality-rejected season pack for all 31 episodes (E01 already prepared: %s)', async (prepared) => {
  const numbers = Array.from({ length: 31 }, (_, i) => i + 1);
  const series = await setup(numbers);
  series.episodes.push(episode(2, 1));
  const otherSeason = pipe.queue.ensure(series.key, 2, 1);
  const low = pack('Show.Name.S01.720p.WEB-DL-PACK', numbers.map(file), numbers.length);
  const hash = hashOf(low.title, low.files);
  const matches = Object.fromEntries(numbers.map((n) => [`${series.key}:1x${n}`, `${low.title}/${file(n)}`]));
  advertise([low]);
  pipe.finder.requestSearch(series.key, { season: 1, manual: true, fresh: true });
  await expect.poll(async () => (await group(series.key)).counts.stuck).toBe(31);
  const first = pipe.queue.get(`${series.key}:1x1`)!;
  const turn = pipe.queue.itemFor(first)!;

  async function choose(scope: { ids: string[] } | { scope: 'season' }) {
    const [{ entryId, release }] = (await group(series.key)).rejected;
    expect(release).toMatchObject({ title: low.title, kind: 'pack', selectable: true,
      reasons: expect.arrayContaining(['The quality of the release is not in the allowed qualities.']) });
    return api!.post(`/queue/entries/${entryId}/releases/grab`, { indexerId: release.indexerId, guid: release.guid, ...scope });
  }

  if (prepared) {
    expect(await choose({ ids: [first.id] })).toMatchObject({ status: 202, body: { started: [first.id] } });
    await expect.poll(async () => (await group(series.key)).status).toBe('stuck');
    expect(turn.selected[hash]?.matches).toEqual({ [first.id]: matches[first.id] });
    expect((await group(series.key)).counts.stuck).toBe(30);
    expect(pipe.acquisition.filter((event) => event.type === 'add')).toEqual([]);
  }

  const attempt = first.attempt;
  expect((await choose({ scope: 'season' })).status).toBe(202);
  await expect.poll(async () => (await group(series.key)).reached.matched).toBe(31);
  await expect.poll(async () => (await group(series.key)).counts.downloading).toBe(31);
  expect(turn.selected[hash]?.matches).toEqual(matches);
  expect(pipe.acquisition.filter((event) => event.type === 'add')).toEqual([add(low)]);
  if (prepared) expect(first.attempt).toBe(attempt);
  expect(otherSeason).toMatchObject({ state: { kind: 'queued' }, release: null, transferHash: null });
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

it('discards an unsent partial pack when a stuck season retries its search', async () => {
  const series = await setup();
  const old = partial();
  advertise([old], [pack(WRONG, [file(2)], 1)]);
  pipe.finder.requestSearch(series.key, { season: 1, fresh: true });
  await expect.poll(() => group(series.key)).toMatchObject({
    status: 'stuck', torrents: [{ status: 'prepared', release: { title: old.title } }],
  });
  expect(pipe.qbit.torrents.size).toBe(0);

  pipe.queue.setPaused(true);
  const action = { action: 'retry', group: { titleKey: series.key, season: 1 } };
  const preview = await api!.post('/queue/actions', { ...action, preview: true });
  expect(preview.body.affected).toHaveLength(3);
  expect((await api!.post('/queue/actions', { ...action, version: preview.body.version })).status).toBe(200);
  expect(await group(series.key)).toMatchObject({ status: 'queued', torrents: [], rejected: [] });
  for (const n of [1, 2, 3]) {
    expect(await entry(`${series.key}:1x${n}`)).toMatchObject({ status: 'queued', release: null, search: null });
  }
  expect(pipe.db.data.torrents[hashOf(old.title, old.files)]).toBeUndefined();

  const complete = full();
  advertise([complete]);
  const before = pipe.acquisition.length;
  pipe.queue.setPaused(false);
  await expect.poll(() => group(series.key)).toMatchObject({ counts: { downloading: 3 } });
  expect(pipe.acquisition.slice(before)).toEqual([seasonSearch, read(complete), add(complete)]);
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

it('keeps searching an absent season and starts counting missing episodes only after a release appears', async () => {
  let now = Date.UTC(2026, 10, 26);
  using clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  const series = await setup();
  advertise([]);
  pipe.finder.requestSearch(series.key, { season: 1 });

  const turn = pipe.queue.findItem(series.key, 1)!;
  const round = [seasonSearch, ...[1, 2, 3].map(episodeSearch)];
  for (let i = 1; i <= 4; i++) {
    await expect.poll(() => turn.nextAt ?? 0).toBeGreaterThan(now);
    expect(await group(series.key)).toMatchObject({ status: 'not_found', counts: { not_found: 3 }, tabs: ['queued'] });
    expect(pipe.acquisition).toEqual(Array.from({ length: i }, () => round).flat());
    now = turn.nextAt!;
  }

  const singles = [episodeItem(1), episodeItem(2)];
  advertise(singles);
  await expect.poll(() => turn.nextAt ?? 0).toBeGreaterThan(now);
  expect(await group(series.key)).toMatchObject({ status: 'not_found' });
  expect(turn.emptySearches).toEqual({ [`${series.key}:1x3`]: 1 });
  const last = single();
  advertise(singles, [last]);
  now = turn.nextAt!;
  await expect.poll(async () => (await group(series.key)).status).toBe('downloading');
  await expect.poll(adds).toHaveLength(3);
  expect(adds()).toEqual(expect.arrayContaining([...singles, last].map(add)));
});

it('counts empty E03 rounds, not indexer responses, and stops after three rounds', async () => {
  let now = Date.UTC(2026, 10, 26);
  using clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  const series = await setup();
  const singles = [episodeItem(1), episodeItem(2)];
  const tracker = pipe.db.data.indexers[1]!;
  pipe.db.data.indexers[2] = { ...structuredClone(tracker), id: 2, baseUrl: `http://127.0.0.1:${pipe.tracker.port}/2/` };
  pipe.tracker.state.answer = (url) => url.pathname.startsWith('/1/') && url.searchParams.get('season') === '1' && !url.searchParams.has('ep') ? singles : [];
  pipe.finder.requestSearch(series.key, { season: 1, manual: true, fresh: true });

  const trace = [seasonSearch, seasonSearch, ...singles.map(read), missingSearch, missingSearch];
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
  expect(await group(series.key)).toMatchObject({ status: 'stuck', tabs: ['stuck'], problem: { code: 'no_results' } });
  expect(pipe.acquisition).toEqual(trace);
});

it.each([
  { source: 'single', rounds: 3, problem: 'no_results', missing: [2], removed: [2], paused: false },
  { source: 'single', rounds: 3, problem: 'no_results', missing: [2], removed: [2], paused: true },
  { source: 'pack', rounds: 1, problem: 'pack_partial', missing: [2], removed: [2], paused: false },
  { source: 'pack', rounds: 1, problem: 'pack_partial', missing: [2], removed: [2], paused: true },
  { source: 'pack', rounds: 1, problem: 'pack_partial', missing: [2, 3], removed: [2, 3], paused: false },
  { source: 'pack', rounds: 1, problem: 'pack_partial', missing: [2, 3], removed: [3, 2], paused: false },
])('discards episodes $removed from a $problem season with a verified $source (paused: $paused)', async ({ source, rounds, problem, missing, removed, paused }) => {
  let now = Date.UTC(2026, 10, 26);
  using clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  const commits: string[] = [];
  const series = await setup([1, ...missing], {
    afterStep(state, step) {
      if (state === 'committed') commits.push(step.source);
    },
  });
  const verified = source === 'pack' ? pack(PACK, [file(1)], 1) : episodeItem(1);
  const hash = hashOf(verified.title, verified.files);
  const kept = `${series.key}:1x1`;
  advertise([verified]);
  pipe.finder.requestSearch(series.key, { season: 1, manual: true, fresh: true });
  const turn = pipe.queue.findItem(series.key, 1)!;
  for (let round = 1; round < rounds; round++) {
    await expect.poll(() => turn.emptySearches).toEqual({ [`${series.key}:1x2`]: round });
    now += DAY;
    pipe.finder.sweep();
  }
  await expect.poll(async () => (await group(series.key)).status).toBe('stuck');
  expect(await group(series.key)).toMatchObject({
    status: 'stuck', problem: { code: problem }, total: 1 + missing.length, reached: { matched: 1, completed: 0 },
    torrents: [{ status: 'prepared', release: { title: verified.title } }],
  });
  expect(turn.selected[hash]).toMatchObject({ status: 'prepared', matches: { [kept]: `${verified.title}/${file(1)}` } });
  const trace = [seasonSearch, read(verified), ...Array.from({ length: rounds }, () => missing.map(episodeSearch)).flat()];
  expect(pipe.acquisition).toEqual(trace);

  if (paused) expect((await api!.post('/queue/actions', { action: 'pause', ids: [kept] })).status).toBe(200);
  const beforeDiscard = structuredClone(pipe.queue.get(kept)!.state);
  if (paused) expect(beforeDiscard.kind).toBe('paused');
  for (const [index, n] of removed.entries()) {
    expect((await api!.del(`/library/${series.key}/episodes/1/${n}`)).status).toBe(200);
    expect(series.episodes.find(({ number }) => number === n)).toMatchObject({ override: 'unmonitored', fileId: null });
    expect(pipe.queue.get(`${series.key}:1x${n}`)).toBeUndefined();
    pipe.finder.sweep();
    if (index === removed.length - 1) continue;
    // Another episode still has no source, so the season stays stuck and sends nothing.
    expect(await group(series.key)).toMatchObject({ status: 'stuck', problem: { code: problem } });
    expect(queueJobs()).toEqual([]);
    expect(pipe.acquisition).toEqual(trace);
  }

  if (paused) {
    await pipe.worker.drain();
    expect(pipe.queue.get(kept)?.state).toEqual(beforeDiscard);
    expect(Object.values(pipe.db.data.jobs).filter((job) => job.type === 'queue.send')).toEqual([]);
    expect(pipe.acquisition).toEqual(trace);
    expect(commits).toEqual([]);
    return;
  }

  const resumedTrace = [...trace, add(verified)];
  await expect.poll(async () => ({ status: (await group(series.key)).status, trace: pipe.acquisition })).toEqual({
    status: 'downloading', trace: resumedTrace,
  });
  pipe.complete(verified.title, { [file(1)]: 'episode-one' }, hash);
  await expect.poll(async () => (await group(series.key)).status).toBe('available');
  await pipe.poller.tick();
  await pipe.worker.drain();
  expect(pipe.acquisition).toEqual(resumedTrace);
  expect(commits).toEqual([`${verified.title}/${file(1)}`]);
  expect(Object.values(pipe.db.data.files)).toMatchObject([
    { id: series.episodes[0]!.fileId, episodes: [{ season: 1, number: 1 }], download: { hash } },
  ]);
});

it.each([
  { found: 'nothing for E03', numbers: [1, 2, 3], singles: [], missing: [3] },
  { found: 'nothing for E03 and E04', numbers: [1, 2, 3, 4], singles: [], missing: [3, 4] },
  { found: 'a single for E03 only', numbers: [1, 2, 3, 4], singles: [single()], missing: [4] },
  { found: 'only a rejected single for E03', numbers: [1, 2, 3], singles: [pack(WRONG, [file(2)], 1)], missing: [3] },
  // The first run reaches the request budget, so the round is complete only after the second run.
  { found: 'nothing in a round of two runs', numbers: Array.from({ length: 20 }, (_, i) => i + 1), singles: [], missing: Array.from({ length: 18 }, (_, i) => i + 3) },
])('stops a season with a partial pack at the first completed round: $found', async ({ numbers, singles, missing }) => {
  const series = await setup(numbers);
  const first = partial();
  advertise([first], singles);
  pipe.finder.requestSearch(series.key, { season: 1 });

  await expectStoppedByPartialPack(series.key, missing);
  expect(pipe.queue.findItem(series.key, 1)!.selected[hashOf(first.title, first.files)]).toMatchObject({
    status: 'prepared',
    matches: { [`${series.key}:1x1`]: `${PACK}/${file(1)}`, [`${series.key}:1x2`]: `${PACK}/${file(2)}` },
  });
  expect(pipe.tracker.state.searches.map((url) => [url.searchParams.get('season'), url.searchParams.get('ep')])).toEqual(
    [['1', null], ...numbers.slice(2).map((n) => ['1', String(n)])],
  );
});

it('stops a season at the first round that finds a partial pack after an empty round', async () => {
  let now = Date.UTC(2026, 10, 26);
  using clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  const series = await setup();
  advertise([]);
  pipe.finder.requestSearch(series.key, { season: 1 });
  const turn = pipe.queue.findItem(series.key, 1)!;
  await expect.poll(() => turn.nextAt ?? 0).toBeGreaterThan(now);
  expect((await group(series.key)).status).toBe('not_found');

  advertise([partial()]);
  now = turn.nextAt!;
  await expectStoppedByPartialPack(series.key, [3]);
});

it('stops a season when a retried search returns a pack that is known not to hold its episodes', async () => {
  const series = await setup([1, 2, 3, 4]);
  inLibrary(series, [1, 2]);
  const known = partial();
  advertise([known]);
  pipe.finder.requestSearch(series.key, { season: 1 });
  const round = [seasonSearch, episodeSearch(3), episodeSearch(4)];
  await expect.poll(() => pipe.acquisition).toEqual([seasonSearch, read(known), ...round.slice(1)]);
  await expect.poll(async () => (await group(series.key)).status).toBe('stuck');
  expect(pipe.db.data.releaseCoverage[`1:${PACK}`]).toMatchObject({ season: 1, numbers: [1, 2] });

  expect((await api!.post('/queue/actions', { action: 'retry', group: { titleKey: series.key, season: 1 } })).status).toBe(200);
  await expect.poll(() => pipe.tracker.state.searches).toHaveLength(2 * round.length);
  await expectStoppedByPartialPack(series.key, [3, 4]);
  expect(pipe.tracker.state.searches.every((url) => url.searchParams.get('season') === '1')).toBe(true);
});

it('stops an episode when its search returns a pack that is known not to hold it', async () => {
  const series = await setup();
  inLibrary(series, [1, 2]);
  // An earlier download of this pack recorded the episodes that its files hold.
  pipe.db.data.releaseCoverage[`1:${PACK}`] = { titleKey: series.key, season: 1, numbers: [1, 2], numberingRevision: 0 };
  const known = partial();
  pipe.tracker.state.answer = () => [known];
  pipe.finder.requestSearch(series.key, { season: 1 });

  await expect.poll(() => pipe.tracker.state.searches).toHaveLength(1);
  await expectStoppedByPartialPack(series.key, [3]);
  expect(pipe.acquisition.filter(({ type }) => type === 'search')).toEqual([episodeSearch(3)]);
});

it.each([
  { silent: 'a second indexer', second: true },
  { silent: 'the indexer of the pack, after the pack,', second: false },
])('does not stop a season with a partial pack while $silent does not answer', async ({ second }) => {
  let now = Date.UTC(2026, 10, 26);
  using clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  const series = await setup(undefined, {
    onAcquisition: (event) => {
      if (!second && event.type === 'torrent') pipe.tracker.state.fail = true;
    },
  });
  if (second) {
    const down = await startFakeTracker();
    down.state.fail = true;
    onTestFinished(() => down.close());
    pipe.db.data.indexers[2] = { ...structuredClone(pipe.db.data.indexers[1]!), id: 2, baseUrl: `http://127.0.0.1:${down.port}/2/` };
  }
  advertise([partial()]);
  pipe.finder.requestSearch(series.key, { season: 1 });
  const turn = pipe.queue.findItem(series.key, 1)!;

  for (const attempts of [1, 2, 3, 4, 5]) {
    await expect.poll(queueJobs).toMatchObject([{ type: 'queue.search', state: 'waiting', attempts }]);
    expect((await group(series.key)).status).toBe('searching');
    now = queueJobs()[0]!.runAt;
  }
  // The last attempt of the job ends without an answer. The season waits for its next search.
  await expect.poll(() => turn.state).toEqual({ kind: 'waiting', outcome: 'indexers_failed' });
  await expect.poll(queueJobs).toMatchObject([{ type: 'queue.search', state: 'waiting', attempts: 0 }]);
  expect(queueJobs()[0]!.runAt).toBeGreaterThan(now);
  expect(await group(series.key)).toMatchObject({
    status: 'searching', tabs: ['searching'], torrents: [{ status: 'prepared', release: { title: PACK } }],
  });
  expect(await entry(`${series.key}:1x3`)).toMatchObject({ status: 'searching', reason: { code: 'indexers_failed' } });
  expect(adds()).toEqual([]);
});

it.each(['before the first search', 'after the season stopped'])('searches another release season on request and adds both packs (map saved %s)', async (saved) => {
  const series = await setup([1, 2, 3, 4]);
  const first = partial();
  const second = pack('Show.Name.S02.1080p.WEB-DL-PACK', ['Show.Name.S02E01.mkv', 'Show.Name.S02E02.mkv'], 2);
  let later: FakeItem[] = [];
  pipe.tracker.state.answer = (url) => {
    if (url.searchParams.has('ep')) return [];
    const season = url.searchParams.get('season');
    return season === '1' ? [first] : season === '2' ? later : [];
  };
  const saveMap = async () => expect((await api!.patch(`/library/${series.key}`, {
    numbering: { revision: 0, ranges: [{ season: 1, from: 3, to: 4, releaseSeason: 2, releaseFrom: 1 }] },
  })).status).toBe(200);
  if (saved === 'before the first search') await saveMap();
  pipe.finder.requestSearch(series.key, { season: 1 });
  await expect.poll(async () => (await group(series.key)).status).toBe('stuck');
  expect(await group(series.key)).toMatchObject({ problem: { code: 'pack_partial' }, counts: { stuck: 2 } });
  await expect.poll(queueJobs).toEqual([]);
  if (saved === 'after the season stopped') await saveMap();
  expect(adds()).toEqual([]);

  later = [second];
  const action = { action: 'search_other_seasons', group: { titleKey: series.key, season: 1 } };
  expect(await api!.post('/queue/actions', action)).toMatchObject({
    status: 200, body: { affected: [{ id: `${series.key}:1x3` }, { id: `${series.key}:1x4` }] },
  });
  await expect.poll(async () => (await group(series.key)).counts.downloading, { timeout: 5_000 }).toBe(4);
  expect(adds()).toHaveLength(2);
  expect(adds()).toEqual(expect.arrayContaining([add(first), add(second)]));
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
  expect(release).toMatchObject({ reasons: [message], selectable: true });
  expect(await api!.post(`/queue/entries/${entryId}/releases/grab`, { indexerId: release.indexerId, guid: release.guid, scope: 'season' })).toMatchObject({ status: 202 });
  await expect.poll(async () => (await group(series.key)).status).toBe('stuck');
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
