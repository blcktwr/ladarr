import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { withDefaults } from '../../src/core/db.ts';
import { episode, movie, title } from '../helpers/test-fixtures.ts';
import { hashOf, MIB, startFakeTracker, startPipeline, type FakeItem } from '../helpers/test-pipeline.ts';
import type { ClientConfig, QueueTurn, Title } from '../../src/types.ts';

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
// The reason text of the rejection code `pack_partial`.
const PARTIAL = 'The torrent does not contain all the requested episodes.';
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
  api = await pipe.api({ indexers: pipe.indexers });
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

const hashes = (items: FakeItem[]) => items.map((item) => hashOf(item.title, item.files));

// The files of each rejected release of the season: the path in the release of each episode that it holds.
async function matchesOf(key: string) {
  const { rejected } = await group(key);
  return Object.fromEntries((rejected as { release: { title: string; matches?: Record<string, string> } }[])
    .map(({ release }) => [release.title, release.matches]));
}

// A stuck season holds no release. Every episode stops with the problem and the phase of the season. Each release that
// the search found for a part of the season is a rejected release that the user can map. `kept` names the releases that
// wait for the user to map their files.
async function expectNoRelease(key: string, problem: string, found: FakeItem[], kept: FakeItem[] = []) {
  await expect.poll(async () => (await group(key)).status, { timeout: 3_000 }).toBe('stuck');
  const turn = pipe.queue.findItem(key, 1)!;
  expect(turn.state).toMatchObject({ kind: 'blocked', problem: { code: problem } });
  expect(Object.keys(turn.selected)).toEqual(hashes(kept));
  for (const id of turn.entryIds) {
    const member = pipe.queue.get(id)!;
    expect(member.state).toEqual(turn.state);
    expect(member).toMatchObject({ release: null, transferHash: null });
  }
  const { rejected, actions } = await group(key);
  for (const item of found) {
    expect(turn.search!.rejected.filter(({ title }) => title === item.title)).toMatchObject([{ reasons: [PARTIAL], manifestProblem: 'pack_partial' }]);
    expect(rejected).toContainEqual(expect.objectContaining({ release: expect.objectContaining({ title: item.title, reasons: [PARTIAL], selectable: true }) }));
    expect(pipe.db.data.torrents[hashOf(item.title, item.files)]).toBeUndefined();
  }
  const matched = (actions as { action: string; ids: string[] }[]).filter(({ action }) => action === 'match');
  expect(matched.flatMap(({ ids }) => ids).sort()).toEqual([...turn.entryIds].sort());
}

// The season is stuck for every episode. Nothing goes to the client, and no later sweep searches again.
async function expectStoppedByPartialPack(key: string, numbers: number[], found: FakeItem[]) {
  await expect.poll(async () => (await group(key)).status, { timeout: 3_000 }).toBe('stuck');
  expect(await group(key)).toMatchObject({ tabs: ['stuck'], problem: { code: 'pack_partial' }, counts: { stuck: numbers.length }, torrents: [], nextAt: null });
  for (const n of numbers) expect(await entry(`${key}:1x${n}`)).toMatchObject({ status: 'stuck', reason: { code: 'pack_partial' } });
  await expectNoRelease(key, 'pack_partial', found);
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

it('discards the rejected partial pack when a stuck season retries its search', async () => {
  const series = await setup();
  const old = partial();
  advertise([old]);
  pipe.finder.requestSearch(series.key, { season: 1, fresh: true });
  await expectStoppedByPartialPack(series.key, [1, 2, 3], [old]);
  expect(pipe.acquisition).toEqual([seasonSearch, read(old)]);

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

// Answers the season search with `season`, and the search of each episode with the releases of `episodes`.
function advertiseEpisodes(season: FakeItem[], episodes: Record<number, FakeItem[]>) {
  pipe.tracker.state.answer = (url) => {
    if (url.searchParams.get('season') !== '1') return [];
    const ep = url.searchParams.get('ep');
    return ep === null ? season : episodes[Number(ep)] ?? [];
  };
}

it('downloads the singles of the season search next to a partial pack, and asks for no episode', async () => {
  const series = await setup();
  const first = partial();
  const wrong = pack(WRONG, [file(2)], 1, 100);
  const singles = [1, 2, 3].map(episodeItem);
  advertise([first, wrong, ...singles]);
  pipe.finder.requestSearch(series.key, { season: 1, manual: true, fresh: true });

  await expect.poll(adds).toHaveLength(3);
  await expect.poll(async () => (await group(series.key)).status).toBe('downloading');
  // The checks read every source before the first add.
  expect(pipe.acquisition.slice(0, 3)).toEqual([seasonSearch, read(first), read(wrong)]);
  expect(pipe.acquisition.slice(3, -3)).toHaveLength(singles.length);
  expect(pipe.acquisition.slice(3, -3)).toEqual(expect.arrayContaining(singles.map(read)));
  expect(adds()).toEqual(expect.arrayContaining(singles.map(add)));
  expect(pipe.queue.findItem(series.key, 1)!.selected[hashOf(first.title, first.files)]).toBeUndefined();
  expect(pipe.db.data.torrents[hashOf(first.title, first.files)]).toBeUndefined();
});

it('searches each episode and sends the singles when the season search returns no pack', async () => {
  const numbers = [1, 2, 3, 4];
  const series = await setup(numbers);
  const singles = numbers.map(episodeItem);
  advertiseEpisodes([], Object.fromEntries(numbers.map((n, i) => [n, [singles[i]!]])));
  pipe.finder.requestSearch(series.key, { season: 1, fresh: true });

  const searches = numbers.map(episodeSearch);
  await expect.poll(adds).toHaveLength(singles.length);
  await expect.poll(async () => (await group(series.key)).status).toBe('downloading');
  expect(pipe.acquisition[0]).toEqual(seasonSearch);
  const split = pipe.acquisition.findIndex((event) => event.type === 'add');
  expect(pipe.acquisition.slice(1, split)).toHaveLength(searches.length + singles.length);
  expect(pipe.acquisition.slice(1, split)).toEqual(expect.arrayContaining([...searches, ...singles.map(read)]));
  expect(pipe.acquisition.slice(split)).toHaveLength(singles.length);
  expect(pipe.acquisition.slice(split)).toEqual(expect.arrayContaining(singles.map(add)));
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
  { source: 'single', rounds: 3, problem: 'no_results', missing: [2], removed: [2] },
  { source: 'pack', rounds: 1, problem: 'pack_partial', missing: [2], removed: [2] },
  { source: 'pack', rounds: 1, problem: 'pack_partial', missing: [2, 3], removed: [2, 3] },
  { source: 'pack', rounds: 1, problem: 'pack_partial', missing: [2, 3], removed: [3, 2] },
])('discards episodes $removed from a $problem season that rejected a $source, then retries the rest', async ({ source, rounds, problem, missing, removed }) => {
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
  await expectNoRelease(series.key, problem, [verified]);
  expect(await group(series.key)).toMatchObject({ total: 1 + missing.length, reached: { matched: 0, completed: 0 }, torrents: [] });
  // A rejected partial pack ends the search, so no episode is searched.
  const searched = source === 'pack' ? [] : missing;
  const trace = [seasonSearch, read(verified), ...Array.from({ length: rounds }, () => searched.map(episodeSearch)).flat()];
  expect(pipe.acquisition).toEqual(trace);

  for (const n of removed) {
    expect((await api!.del(`/library/${series.key}/episodes/1/${n}`)).status).toBe(200);
    expect(series.episodes.find(({ number }) => number === n)).toMatchObject({ override: 'unmonitored', fileId: null });
    expect(pipe.queue.get(`${series.key}:1x${n}`)).toBeUndefined();
    pipe.finder.sweep();
    // The episode that stays has no release, so a removal sends nothing and starts no search.
    expect(await group(series.key)).toMatchObject({ status: 'stuck', problem: { code: problem } });
    expect(queueJobs()).toEqual([]);
    expect(pipe.acquisition).toEqual(trace);
  }

  pipe.tracker.state.answer = (url) => url.searchParams.get('ep') === '1' ? [verified] : [];
  expect((await api!.post('/queue/actions', { action: 'retry', ids: [kept] })).status).toBe(200);
  const resumedTrace = [...trace, episodeSearch(1), read(verified), add(verified)];
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
  { found: 'the pack alone', numbers: [1, 2, 3], others: [] as FakeItem[], listed: [] as FakeItem[] },
  { found: 'the pack and a single for E03', numbers: [1, 2, 3, 4], others: [single()], listed: [single()] },
  { found: 'the pack and a rejected single for E03', numbers: [1, 2, 3], others: [pack(WRONG, [file(2)], 1)], listed: [] as FakeItem[] },
])('stops a season at once when its search rejects a partial pack: $found', async ({ numbers, others, listed }) => {
  const series = await setup(numbers);
  const first = partial();
  // The search of each episode has a release. No search of an episode runs.
  advertiseEpisodes([first, ...others], Object.fromEntries(numbers.map((n) => [n, [episodeItem(n)]])));
  pipe.finder.requestSearch(series.key, { season: 1 });

  await expectStoppedByPartialPack(series.key, numbers, [first, ...listed]);
  expect(pipe.tracker.state.searches.map((url) => url.searchParams.get('ep'))).toEqual([null]);
  const titles = (await group(series.key)).rejected.map(({ release }: { release: { title: string } }) => release.title);
  expect(titles.sort()).toEqual([first, ...others].map(({ title }) => title).sort());
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

  const first = partial();
  advertise([first]);
  now = turn.nextAt!;
  await expectStoppedByPartialPack(series.key, [1, 2, 3], [first]);
  // The empty round searched each episode. The round with the pack asks for the season only.
  expect(pipe.acquisition).toEqual([seasonSearch, ...[1, 2, 3].map(episodeSearch), seasonSearch, read(first)]);
});

it('stops a season when a retried search returns a pack that is known not to hold its episodes', async () => {
  const series = await setup([1, 2, 3, 4]);
  inLibrary(series, [1, 2]);
  const known = partial();
  advertise([known]);
  pipe.finder.requestSearch(series.key, { season: 1 });
  await expectNoRelease(series.key, 'pack_partial', [known]);
  expect(pipe.acquisition).toEqual([seasonSearch, read(known)]);
  expect(pipe.db.data.releaseCoverage[`1:${PACK}`]).toMatchObject({ season: 1, numbers: [1, 2] });

  expect((await api!.post('/queue/actions', { action: 'retry', group: { titleKey: series.key, season: 1 } })).status).toBe(200);
  await expect.poll(() => pipe.tracker.state.searches).toHaveLength(2);
  await expectStoppedByPartialPack(series.key, [3, 4], [known]);
  // The second search does not read the pack again. It lists the pack from its known coverage.
  expect(pipe.tracker.state.downloads).toEqual([PACK]);
  expect(pipe.tracker.state.searches.map((url) => [url.searchParams.get('season'), url.searchParams.get('ep')])).toEqual([['1', null], ['1', null]]);
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
  await expectStoppedByPartialPack(series.key, [3], [known]);
  expect(pipe.tracker.state.downloads).toEqual([]);
  expect(pipe.acquisition.filter(({ type }) => type === 'search')).toEqual([episodeSearch(3)]);
});

describe('the release day', () => {
  const HOUR = 60 * 60 * 1000;
  // Local midnight of 2026-11-26 in a zone west of UTC. Its release day ends at 03:00 UTC of the next date.
  const MIDNIGHT = Date.UTC(2026, 10, 26, 3);
  const HOURS = [0, 1, 2, 3, 23];
  let now = MIDNIGHT;
  const mockClock = () => {
    now = MIDNIGHT;
    return vi.spyOn(Date, 'now').mockImplementation(() => now);
  };

  // A season whose last episode comes out on 2026-11-26.
  async function releaseSeason(numbers = [1, 2, 3]) {
    const series = await setup(numbers);
    Object.assign(pipe.db.data.settings, { timeZone: 'America/Argentina/Buenos_Aires' });
    series.episodes.at(-1)!.airDate = '2026-11-26';
    return series;
  }

  // The search returns a pack with E01 and E02. A known pack comes from an earlier download of those two episodes.
  async function searchWithPartialPack(known: boolean, numbers?: number[]) {
    const series = await releaseSeason(numbers);
    const first = partial();
    if (known) {
      inLibrary(series, [1, 2]);
      pipe.db.data.releaseCoverage[`1:${PACK}`] = { titleKey: series.key, season: 1, numbers: [1, 2], numberingRevision: 0 };
    }
    advertise([first], known ? [first] : []);
    pipe.finder.requestSearch(series.key, { season: 1 });
    return { series, turn: pipe.queue.findItem(series.key, 1)! };
  }

  // Waits for the end of the search that is due now: the season then waits for a later search, or it stops.
  const searched = (turn: QueueTurn) =>
    expect.poll(() => turn.state.kind === 'blocked' || (turn.state.kind === 'waiting' && turn.nextAt! > now)).toBe(true);

  it('does not count empty searches on the release day, and counts three rounds after it', async () => {
    using _clock = mockClock();
    const series = await releaseSeason();
    inLibrary(series, [1, 2]);
    advertise([]);
    pipe.finder.requestSearch(series.key, { season: 1 });
    const turn = pipe.queue.findItem(series.key, 1)!;

    for (const hour of HOURS) {
      now = MIDNIGHT + hour * HOUR;
      await searched(turn);
      expect(await group(series.key)).toMatchObject({ status: 'not_found' });
      expect(turn.emptySearches).toEqual({});
      expect(turn.nextAt).toBe(now + HOUR);
    }
    for (const round of [1, 2, 3]) {
      now = turn.nextAt!;
      await searched(turn);
      expect(turn.emptySearches).toEqual({ [`${series.key}:1x3`]: round });
      expect(await group(series.key)).toMatchObject({ status: round < 3 ? 'not_found' : 'stuck' });
    }
    expect(await group(series.key)).toMatchObject({ tabs: ['stuck'], problem: { code: 'no_results' } });
    // No release was found, so there is nothing to map.
    expect((await group(series.key)).actions).not.toContainEqual(expect.objectContaining({ action: 'match' }));
    expect(pipe.acquisition).toEqual(Array(HOURS.length + 3).fill(missingSearch));
  });

  it.each([
    { pack: 'next to the singles of the other episodes', library: false, known: false, apart: false },
    { pack: 'before the searches of the other episodes find their singles', library: false, known: false, apart: true },
    { pack: 'that does not hold it', library: true, known: false, apart: false },
    { pack: 'known not to hold it', library: true, known: true, apart: false },
  ])('keeps searching on the release day with a pack $pack, and stops after that day', async ({ library, known, apart }) => {
    using _clock = mockClock();
    const series = await releaseSeason();
    const first = partial();
    const singles = library ? [] : [episodeItem(1), episodeItem(2)];
    if (library) inLibrary(series, [1, 2]);
    if (known) pipe.db.data.releaseCoverage[`1:${PACK}`] = { titleKey: series.key, season: 1, numbers: [1, 2], numberingRevision: 0 };
    // With the singles, only the first season search returns the pack. The later rounds search E03 alone.
    if (apart) advertiseEpisodes([first], { 1: [singles[0]!], 2: [singles[1]!] });
    else advertise([first, ...singles], library ? [first] : []);
    pipe.finder.requestSearch(series.key, { season: 1 });
    const turn = pipe.queue.findItem(series.key, 1)!;

    for (const hour of HOURS) {
      now = MIDNIGHT + hour * HOUR;
      await searched(turn);
      expect(await group(series.key)).toMatchObject({ status: 'not_found' });
      expect(turn.nextAt).toBe(now + HOUR);
      expect(turn.search!.rejected.filter(({ title }) => title === PACK)).toMatchObject([{ reasons: [PARTIAL], manifestProblem: 'pack_partial' }]);
      // A season that only waits keeps the singles that it found.
      expect(Object.keys(turn.selected).sort()).toEqual(hashes(singles).sort());
      expect(Object.values(turn.selected).every(({ status }) => status === 'prepared')).toBe(true);
    }
    expect(pipe.acquisition.filter((event) => event.type === 'search' && event.episode === '3')).toHaveLength(HOURS.length);
    // The pack lacks only an episode in its release day, so the search of each other episode runs.
    expect(pipe.acquisition.filter((event) => event.type === 'search' && ['1', '2'].includes(event.episode ?? ''))).toHaveLength(apart ? 2 : 0);
    expect(adds()).toEqual([]);

    now = turn.nextAt!;
    await expectStoppedByPartialPack(series.key, library ? [3] : [1, 2, 3], [first, ...singles]);
  });

  it.each([false, true])('stops with a partial pack on the release day when an older episode is missing too (pack known: %s)', async (known) => {
    using _clock = mockClock();
    const { series } = await searchWithPartialPack(known, [1, 2, 3, 4]);

    await expectStoppedByPartialPack(series.key, known ? [3, 4] : [1, 2, 3, 4], [partial()]);
    expect(pipe.acquisition.filter((event) => event.type === 'search')).toEqual([seasonSearch]);
  });

  it('does not stop a retried search that runs before local midnight of the episode', async () => {
    using _clock = mockClock();
    // The date started in UTC, but not yet in the time zone of the settings.
    now = MIDNIGHT - HOUR;
    const series = await releaseSeason();
    const last = series.episodes.at(-1)!;
    // An older date lets the season stop first.
    last.airDate = '2020-01-01';
    inLibrary(series, [1, 2]);
    pipe.db.data.releaseCoverage[`1:${PACK}`] = { titleKey: series.key, season: 1, numbers: [1, 2], numberingRevision: 0 };
    advertise([], [partial()]);
    pipe.finder.requestSearch(series.key, { season: 1 });
    await expect.poll(async () => (await group(series.key)).status).toBe('stuck');

    last.airDate = '2026-11-26';
    expect((await api!.post('/queue/actions', { action: 'retry', group: { titleKey: series.key, season: 1 } })).status).toBe(200);
    const turn = pipe.queue.findItem(series.key, 1)!;
    await searched(turn);
    expect(pipe.tracker.state.searches).toHaveLength(2);
    expect(await group(series.key)).toMatchObject({ status: 'not_found' });
    expect(turn.emptySearches).toEqual({});
  });

  it('stops on the release day when the checks reject every release', async () => {
    using _clock = mockClock();
    const series = await releaseSeason();
    inLibrary(series, [1, 2]);
    advertise([], [pack('Show.Name.S01E03.480p.WEB-DL-LOW', [file(3)], 1)]);
    pipe.finder.requestSearch(series.key, { season: 1 });

    await expect.poll(async () => (await group(series.key)).status).toBe('stuck');
    expect(await group(series.key)).toMatchObject({ tabs: ['stuck'], problem: { code: 'all_rejected' } });
  });
});

it('does not stop a season with a partial pack while a second indexer does not answer', async () => {
  let now = Date.UTC(2026, 10, 26);
  using clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  const series = await setup();
  const down = await startFakeTracker();
  down.state.fail = true;
  onTestFinished(() => down.close());
  pipe.db.data.indexers[2] = { ...structuredClone(pipe.db.data.indexers[1]!), id: 2, baseUrl: `http://127.0.0.1:${down.port}/2/` };
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
  expect(await group(series.key)).toMatchObject({ status: 'searching', tabs: ['searching'], torrents: [] });
  expect(turn.selected).toEqual({});
  expect(turn.search!.rejected).toMatchObject([{ title: PACK, reasons: [PARTIAL], manifestProblem: 'pack_partial' }]);
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
  await expectNoRelease(series.key, 'pack_partial', [first]);
  expect(await group(series.key)).toMatchObject({ counts: { stuck: 4 } });
  await expect.poll(queueJobs).toEqual([]);
  if (saved === 'after the season stopped') await saveMap();
  expect(adds()).toEqual([]);

  later = [second];
  const action = { action: 'search_other_seasons', group: { titleKey: series.key, season: 1 } };
  expect(await api!.post('/queue/actions', action)).toMatchObject({
    status: 200, body: { affected: [1, 2, 3, 4].map((n) => ({ id: `${series.key}:1x${n}` })) },
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
  const first = pack('Show.Name.S01E01E02.1080p.WEB-DL-DOUBLE', [file(1), file(2)], 2, 100);
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

it('accepts a pack that holds every episode that the library does not have', async () => {
  const series = await setup();
  inLibrary(series, [3]);
  const first = partial();
  advertise([first]);
  pipe.finder.requestSearch(series.key, { season: 1 });

  await expect.poll(async () => (await group(series.key)).counts.downloading).toBe(2);
  expect(pipe.acquisition).toEqual([seasonSearch, read(first), add(first)]);
});

it('accepts a pack that holds every episode that has no release yet', async () => {
  const series = await setup();
  const first = partial();
  const last = single();
  advertiseEpisodes([], { 3: [last] });
  pipe.finder.requestSearch(series.key, { season: 1 });
  const turn = pipe.queue.findItem(series.key, 1)!;
  await expect.poll(() => turn.state.kind).toBe('waiting');
  expect(Object.keys(turn.selected)).toEqual(hashes([last]));

  // The feed of the indexer brings a pack with the two episodes that still wait.
  pipe.tracker.state.answer = (url) => url.searchParams.has('season') ? [] : [first];
  await pipe.finder.rss(AbortSignal.timeout(5_000));

  await expect.poll(async () => (await group(series.key)).status).toBe('downloading');
  await expect.poll(adds).toHaveLength(2);
  expect(adds()).toEqual(expect.arrayContaining([add(first), add(last)]));
});

describe('a search that stops a season', () => {
  const LOW = 'Show.Name.S01E03.480p.WEB-DL-LOW';
  const singles = () => [episodeItem(1), episodeItem(2)];
  const opaque = () => pack(PACK, ['part-alpha.mkv'], 1, 100);

  it.each([
    { problem: 'all_rejected', rounds: 1, season: singles, missing: () => [pack(LOW, [file(3)], 1)], found: singles, kept: () => [] as FakeItem[] },
    { problem: 'no_results', rounds: 3, season: singles, missing: () => [] as FakeItem[], found: singles, kept: () => [] as FakeItem[] },
    // The files of the pack wait for the user. The single that the search prepared goes with the rejected releases.
    { problem: 'file_unmapped', rounds: 1, season: () => [opaque(), episodeItem(1)], missing: () => [] as FakeItem[], found: () => [episodeItem(1)], kept: () => [opaque()] },
  ])('leaves no release on a season that stops with $problem, also after a restart', async ({ problem, rounds, season, missing, found, kept }) => {
    let now = Date.UTC(2026, 10, 26);
    using clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const series = await setup();
    advertise(season(), missing());
    pipe.finder.requestSearch(series.key, { season: 1, manual: true, fresh: true });
    const turn = pipe.queue.findItem(series.key, 1)!;
    for (let round = 1; round < rounds; round++) {
      await expect.poll(() => turn.emptySearches).toEqual({ [`${series.key}:1x3`]: round });
      now += DAY;
      pipe.finder.sweep();
    }

    await expectNoRelease(series.key, problem, found(), kept());
    expect(adds()).toEqual([]);
    if (problem === 'no_results') expect((await group(series.key)).missing).toEqual([{ season: 1, number: 3, rounds: 3 }]);
    const preview = await api!.post('/queue/actions', { action: 'retry', group: { titleKey: series.key, season: 1 }, preview: true });
    expect(preview.body.affected.map(({ id }: { id: string }) => id).sort()).toEqual([...turn.entryIds].sort());

    const loaded = withDefaults(JSON.parse(JSON.stringify(pipe.db.data)));
    expect(loaded.queueItems[turn.id]!.state).toEqual(turn.state);
    for (const id of turn.entryIds) expect(loaded.queue[id]!.state).toEqual(turn.state);
  });

  it('sends the releases that the user maps from the rejected releases of the season', async () => {
    const series = await setup();
    const first = partial();
    const last = single();
    advertise([first, last]);
    pipe.finder.requestSearch(series.key, { season: 1 });
    await expectStoppedByPartialPack(series.key, [1, 2, 3], [first, last]);

    const { rejected } = await group(series.key);
    const choice = (item: FakeItem, numbers: number[]) => {
      const { indexerId, guid } = rejected.find(({ release }: { release: { title: string } }) => release.title === item.title).release;
      return { indexerId, guid, files: numbers.map((n) => ({ file: `${item.title}/${file(n)}`, ids: [`${series.key}:1x${n}`] })) };
    };
    const result = await api!.post(`/queue/entries/${series.key}:1x1/releases/map`, { torrents: [choice(first, [1, 2]), choice(last, [3])] });

    expect(result.status, JSON.stringify(result.body)).toBe(202);
    await expect.poll(async () => (await group(series.key)).counts.downloading).toBe(3);
    expect(adds()).toHaveLength(2);
    expect(adds()).toEqual(expect.arrayContaining([add(first), add(last)]));
  });
});

describe('the files of an incomplete release', () => {
  const filesOf = (item: FakeItem, numbers: number[]) => Object.fromEntries(numbers.map((n) => [`tv:1:1x${n}`, `${item.title}/${file(n)}`]));

  it('lists the file of each episode that a rejected pack or a released single holds, and none for another release', async () => {
    const series = await setup([1, 2, 3, 4]);
    const first = partial();
    const last = single();
    // The checks reject it for its quality.
    const low = pack('Show.Name.S01E04.480p.WEB-DL-LOW', [file(4)], 1);
    advertise([first, last, low]);
    pipe.finder.requestSearch(series.key, { season: 1 });
    await expectStoppedByPartialPack(series.key, [1, 2, 3, 4], [first, last]);

    expect(await matchesOf(series.key)).toEqual({ [first.title]: filesOf(first, [1, 2]), [last.title]: filesOf(last, [3]), [low.title]: undefined });

    // The mapping takes these paths as they are.
    const { rejected } = await group(series.key);
    const torrents = (rejected as { release: { indexerId: number; guid: string; matches?: Record<string, string> } }[]).flatMap(({ release: { indexerId, guid, matches } }) =>
      matches ? [{ indexerId, guid, files: Object.entries(matches).map(([id, path]) => ({ file: path, ids: [id] })) }] : []);
    const result = await api!.post(`/queue/entries/${series.key}:1x1/releases/map`, { torrents });
    expect(result.status, JSON.stringify(result.body)).toBe(202);
    await expect.poll(async () => (await group(series.key)).counts.downloading).toBe(3);
  });

  it('keeps the files of a pack that a retry skips because its coverage is known', async () => {
    const series = await setup();
    const first = partial();
    advertise([first]);
    pipe.finder.requestSearch(series.key, { season: 1 });
    await expectStoppedByPartialPack(series.key, [1, 2, 3], [first]);

    expect((await api!.post('/queue/actions', { action: 'retry', group: { titleKey: series.key, season: 1 } })).status).toBe(200);
    await expect.poll(() => pipe.tracker.state.searches).toHaveLength(2);
    await expectStoppedByPartialPack(series.key, [1, 2, 3], [first]);

    expect(pipe.tracker.state.downloads).toEqual([PACK]);
    expect(await matchesOf(series.key)).toEqual({ [PACK]: filesOf(first, [1, 2]) });
  });
});

describe('a partial release that the user chose', () => {
  const LOW_PACK = 'Show.Name.S01.720p.WEB-DL-LOWPACK';
  const lowPack = () => pack(LOW_PACK, [file(1), file(2)], 2);

  // A season that stops because the checks reject its pack of two episodes.
  async function rejectedPack(missing: FakeItem[] = []) {
    const series = await setup();
    advertise([lowPack()], missing);
    pipe.finder.requestSearch(series.key, { season: 1, manual: true, fresh: true });
    await expect.poll(async () => (await group(series.key)).status).toBe('stuck');
    const { rejected } = await group(series.key);
    const { entryId, release } = rejected.find(({ release }: { release: { title: string } }) => release.title === LOW_PACK);
    return { series, entryId, release };
  }

  it('stays on its episodes when the search for the rest of the season stops', async () => {
    const { series, entryId, release } = await rejectedPack();
    const hash = hashOf(LOW_PACK, lowPack().files);

    expect((await api!.post(`/queue/entries/${entryId}/releases/grab`, { indexerId: release.indexerId, guid: release.guid, scope: 'season' })).status).toBe(202);
    await expect.poll(async () => (await group(series.key)).status).toBe('stuck');

    expect(pipe.queue.findItem(series.key, 1)!.selected[hash]).toMatchObject({
      status: 'prepared', release: { title: LOW_PACK, manual: true },
      matches: { [`${series.key}:1x1`]: `${LOW_PACK}/${file(1)}`, [`${series.key}:1x2`]: `${LOW_PACK}/${file(2)}` },
    });
    for (const n of [1, 2]) expect(pipe.queue.get(`${series.key}:1x${n}`)).toMatchObject({ transferHash: hash, release: { title: LOW_PACK } });
    expect(pipe.db.data.torrents[hash]).toBeDefined();
    expect(adds()).toEqual([]);
  });

  it('stays mapped when a later search of another episode stops', async () => {
    const low = pack('Show.Name.S01E03.480p.WEB-DL-LOW', [file(3)], 1);
    const { series, entryId, release } = await rejectedPack([low]);
    const hash = hashOf(LOW_PACK, lowPack().files);
    const [first, , third] = [1, 2, 3].map((n) => `${series.key}:1x${n}`);
    // Without a client, the mapped torrent waits to be sent.
    pipe.db.data.downloadClients = [];
    const result = await api!.post(`/queue/entries/${entryId}/releases/map`, { torrents: [
      { indexerId: release.indexerId, guid: release.guid, files: [{ file: `${LOW_PACK}/${file(1)}`, ids: [first] }] },
    ] });
    expect(result.status, JSON.stringify(result.body)).toBe(202);

    const searches = pipe.tracker.state.searches.length;
    expect((await api!.post('/queue/actions', { action: 'retry', ids: [third] })).status).toBe(200);
    await expect.poll(() => pipe.tracker.state.searches.length).toBeGreaterThan(searches);
    await expect.poll(() => pipe.queue.get(third!)!.state.kind).toBe('blocked');

    expect(pipe.queue.findItem(series.key, 1)!.selected[hash]).toMatchObject({ status: 'prepared', sendMapped: true, matches: { [first!]: `${LOW_PACK}/${file(1)}` } });
    expect(pipe.queue.get(first!)).toMatchObject({ transferHash: hash, release: { title: LOW_PACK } });
    expect(pipe.db.data.torrents[hash]).toBeDefined();
  });
});

describe('a new release season for episodes of the season', () => {
  const second = () => pack('Show.Name.S02.1080p.WEB-DL-PACK', ['Show.Name.S02E01.mkv', 'Show.Name.S02E02.mkv'], 2);
  const idOf = (n: number) => `tv:1:1x${n}`;

  // Each release season answers with its pack. No search of an episode finds a release.
  function advertiseSeasons() {
    pipe.tracker.state.answer = (url) => {
      if (url.searchParams.has('ep')) return [];
      const season = url.searchParams.get('season');
      return season === '1' ? [partial()] : season === '2' ? [second()] : [];
    };
  }

  // The user says that E03 and E04 are in season 2 of the releases, and asks to search it.
  const saveSeasons = (key: string) => api!.patch(`/library/${key}`, { episodeSeasons: {
    revision: 0, edits: [3, 4].map((number) => ({ season: 1, number, releaseSeason: 2, search: true })),
  } });

  // The pack of season 1 holds E01 and E02 only, so the whole season stops.
  async function stoppedSeason() {
    const series = await setup([1, 2, 3, 4]);
    advertiseSeasons();
    pipe.finder.requestSearch(series.key, { season: 1 });
    await expectStoppedByPartialPack(series.key, [1, 2, 3, 4], [partial()]);
    return series;
  }

  async function expectBothPacks(key: string) {
    await expect.poll(async () => (await group(key)).counts, { timeout: 4_000 }).toEqual({ downloading: 4 });
    for (const [n, item] of [[1, partial()], [2, partial()], [3, second()], [4, second()]] as const) {
      expect(pipe.queue.get(idOf(n))).toMatchObject({ transferHash: hashOf(item.title, item.files), release: { title: item.title } });
    }
    expect(adds()).toHaveLength(2);
    expect(adds()).toEqual(expect.arrayContaining([add(partial()), add(second())]));
  }

  const states = () => [1, 2, 3, 4].map((n) => pipe.queue.get(idOf(n))!.state.kind);

  // Maps the first files of a rejected release to these episodes, as the mapping dialog does.
  async function mapRejected(key: string, item: FakeItem, numbers: number[]) {
    const { rejected } = await group(key);
    const { entryId, release } = rejected.find(({ release }: { release: { title: string } }) => release.title === item.title);
    const result = await api!.post(`/queue/entries/${entryId}/releases/map`, { torrents: [{
      indexerId: release.indexerId, guid: release.guid,
      files: numbers.map((n, index) => ({ file: `${item.title}/${item.files![index]}`, ids: [idOf(n)] })),
    }] });
    expect(result.status, JSON.stringify(result.body)).toBe(202);
  }

  // The release season and episode of each search after the first `from` searches.
  const asked = (from: number) => pipe.tracker.state.searches.slice(from).map((url) => [url.searchParams.get('season'), url.searchParams.get('ep')]);

  it('searches only the edited episodes of a stopped season, then stops it again with the found pack listed', async () => {
    const series = await stoppedSeason();
    const found = second();
    const before = pipe.tracker.state.searches.length;

    expect((await saveSeasons(series.key)).status).toBe(200);

    await expect.poll(() => pipe.tracker.state.searches.length).toBeGreaterThan(before);
    await expect.poll(queueJobs).toEqual([]);
    await expectNoRelease(series.key, 'pack_partial', [found]);
    expect(asked(before)).toEqual([['2', null]]);
    expect(adds()).toEqual([]);

    // The user maps the found pack to the episodes that it holds. The other episodes stay stuck.
    await mapRejected(series.key, found, [3, 4]);
    await expect.poll(states).toEqual(['blocked', 'blocked', 'downloading', 'downloading']);
    expect(adds()).toEqual([add(found)]);
  });

  it('lists the files of each rejected pack by the episodes of the title', async () => {
    const series = await stoppedSeason();
    const first = partial();
    const found = second();

    expect((await saveSeasons(series.key)).status).toBe(200);
    await expect.poll(async () => Object.keys(await matchesOf(series.key)).sort()).toEqual([first.title, found.title].sort());
    await expect.poll(queueJobs).toEqual([]);

    // E03 and E04 of the title are the first two episodes of season 2 of the releases.
    expect(await matchesOf(series.key)).toEqual({
      [first.title]: { [idOf(1)]: `${first.title}/${file(1)}`, [idOf(2)]: `${first.title}/${file(2)}` },
      [found.title]: { [idOf(3)]: `${found.title}/Show.Name.S02E01.mkv`, [idOf(4)]: `${found.title}/Show.Name.S02E02.mkv` },
    });
  });

  it('keeps the earlier rejected pack on a season that stops again, so the user can map both packs', async () => {
    const series = await stoppedSeason();
    const first = partial();
    const found = second();
    const before = pipe.tracker.state.searches.length;

    expect((await saveSeasons(series.key)).status).toBe(200);

    await expect.poll(() => pipe.tracker.state.searches.length).toBeGreaterThan(before);
    await expect.poll(queueJobs).toEqual([]);
    await expectNoRelease(series.key, 'pack_partial', [first, found]);

    await mapRejected(series.key, first, [1, 2]);
    await expect.poll(states).toEqual(['downloading', 'downloading', 'blocked', 'blocked']);
    await mapRejected(series.key, found, [3, 4]);
    await expectBothPacks(series.key);
  });

  it('stops a season again when the search of the edited episodes finds nothing', async () => {
    const series = await stoppedSeason();
    pipe.tracker.state.answer = () => [];
    const before = pipe.tracker.state.searches.length;

    expect((await saveSeasons(series.key)).status).toBe(200);

    await expect.poll(() => asked(before)).toEqual([['2', null], ['2', '1'], ['2', '2']]);
    await expect.poll(queueJobs).toEqual([]);
    const turn = pipe.queue.findItem(series.key, 1)!;
    expect((await group(series.key)).status).toBe('stuck');
    expect(turn.selected).toEqual({});
    for (const id of turn.entryIds) {
      const member = pipe.queue.get(id)!;
      expect(member.state).toEqual(turn.state);
      expect(member).toMatchObject({ release: null, transferHash: null });
    }
    expect((await group(series.key)).rejected).toMatchObject([{ release: { title: PACK, selectable: true } }]);
    pipe.finder.sweep();
    expect(queueJobs()).toEqual([]);
  });

  it('searches only the edited episodes of a season that is not stopped', async () => {
    const series = await setup([1, 2, 3, 4]);
    advertise([]);
    pipe.finder.requestSearch(series.key, { season: 1 });
    const turn = pipe.queue.findItem(series.key, 1)!;
    await expect.poll(() => turn.state.kind).toBe('waiting');
    await pipe.worker.pause();
    const others = () => [1, 2].map((n) => {
      const { state, attempt } = pipe.queue.get(idOf(n))!;
      return { state, attempt };
    });
    const before = structuredClone(others());

    expect((await saveSeasons(series.key)).status).toBe(200);

    const asked = queueJobs().map(({ payload }) => payload as { manual?: boolean; entryIds: string[] }).filter(({ manual }) => manual);
    expect(asked).toMatchObject([{ entryIds: [idOf(3), idOf(4)] }]);
    expect(others()).toEqual(before);
  });

  // The mapping dialog saves the seasons and then sends the mapping of the rejected release, with no wait between them.
  it.each(['before the search starts', 'while the search asks the indexer'])('maps the rejected pack right after the save, %s', async (when) => {
    const series = await stoppedSeason();
    const first = partial();
    const { rejected } = await group(series.key);
    const { entryId, release } = rejected.find(({ release }: { release: { title: string } }) => release.title === first.title);
    let answer!: () => void;
    const held = new Promise<void>((resolve) => { answer = resolve; });
    const search = pipe.indexers.search.bind(pipe.indexers);
    using requests = vi.spyOn(pipe.indexers, 'search').mockImplementation(async (...args) => {
      await held;
      return search(...args);
    });
    const early = when === 'before the search starts';
    try {
      if (early) await pipe.worker.pause();
      expect((await saveSeasons(series.key)).status).toBe(200);
      if (!early) await expect.poll(() => requests.mock.calls.length).toBeGreaterThan(0);
      const result = await api!.post(`/queue/entries/${entryId}/releases/map`, { torrents: [{
        indexerId: release.indexerId, guid: release.guid,
        files: [1, 2].map((n) => ({ file: `${first.title}/${file(n)}`, ids: [idOf(n)] })),
      }] });
      expect(result.status, JSON.stringify(result.body)).toBe(202);
    } finally {
      answer();
      pipe.worker.resume();
    }

    await expectBothPacks(series.key);
    for (const n of [1, 2]) expect(pipe.queue.get(idOf(n))!.release).toMatchObject({ manual: true });
    expect(pipe.queue.findItem(series.key, 1)!.selected[hashOf(first.title, first.files)]).toMatchObject({
      sendMapped: true, matches: { [idOf(1)]: `${first.title}/${file(1)}`, [idOf(2)]: `${first.title}/${file(2)}` },
    });
  });
});
