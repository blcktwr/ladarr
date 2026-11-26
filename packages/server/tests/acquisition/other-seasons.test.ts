import { needsOtherSeasons } from '@ladarr/shared/queue';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { reasonOfEntry, stageOf } from '../../src/library/downloads/queue.ts';
import { episode, title } from '../helpers/test-fixtures.ts';
import { move } from '../helpers/test-queue.ts';
import { hashOf, MIB, startPipeline, until } from '../helpers/test-pipeline.ts';
import type { MediaFile, QueueEntry, Title } from '../../src/types.ts';
import type { Numbering, NumberingRange } from '@ladarr/shared/types';

let pipe: Awaited<ReturnType<typeof startPipeline>> | undefined;
let api: Awaited<ReturnType<Awaited<ReturnType<typeof startPipeline>>['api']>> | undefined;
afterEach(async () => {
  api?.close();
  await pipe?.stop();
  pipe = api = undefined;
});

const FIRST = 'Show.Name.S01.1080p.WEB-DL-GRP';
const SECOND = 'Show.Name.S02.1080p.WEB-DL-GRP';
const THIRD = 'Show.Name.S03.1080p.WEB-DL-GRP';
const MIB_PER_EPISODE = 600 * MIB;

const pad = (number: number) => String(number).padStart(2, '0');
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => from + index);
// The video files of a release season, as the torrent file of a pack lists them.
const filesOf = (season: number, count: number) => range(1, count).map((number) => `Show.Name.S${pad(season)}E${pad(number)}.mkv`);
const dataOf = (file: string) => `data-of-${file}`;
const contentsOf = (files: string[]) => Object.fromEntries(files.map((file) => [file, dataOf(file)]));
// The name that the app gives the file of an episode of TMDB in the library.
const pathOf = (season: number, number: number) => `Show Name (2020)/Season ${pad(season)}/Show Name - S${pad(season)}E${pad(number)} - Episode ${number}.mkv`;

// A title of the library with these episodes of TMDB. Every episode is old, so a search asks for the season only.
function addTitle(episodes: { season: number; number: number }[]) {
  const item = title({ rootId: 'tv', episodes: episodes.map(({ season, number }) => episode(season, number, '2020-01-01')) });
  pipe!.db.data.titles[item.key] = item;
  return item;
}

// The episodes that an earlier import left in the library, with a file each.
function inLibrary(item: Title, season: number, numbers: number[]) {
  for (const number of numbers) {
    const id = `file-${season}x${number}`;
    const path = pathOf(season, number);
    mkdirSync(dirname(join(pipe!.folders.tv, path)), { recursive: true });
    writeFileSync(join(pipe!.folders.tv, path), `library-data-${season}x${number}`);
    pipe!.db.data.files[id] = { id, titleKey: item.key, path, sizeBytes: 1, mtimeMs: 0, episodes: [{ season, number }], missing: false, addedAt: 1 };
    item.episodes.find((one) => one.season === season && one.number === number)!.fileId = id;
  }
}

// The file of a target in the library after its import, or undefined when it has none.
function importedFile(item: Title, entry: QueueEntry): MediaFile | undefined {
  const one = item.episodes.find((candidate) => candidate.season === entry.season && candidate.number === entry.number);
  return one?.fileId ? pipe!.db.data.files[one.fileId] : undefined;
}

const readInLibrary = (path: string) => readFileSync(join(pipe!.folders.tv, path), 'utf8');

// A target that a partial pack left stuck, with the attempt counter that an older version of the app wrote.
function stuck(item: Title, season: number, number: number, problem: { code: string; detail?: string }, attempt: number) {
  const entry = pipe!.queue.ensure(item.key, season, number);
  pipe!.queue.request(entry, 'search requested');
  move(pipe!.queue, entry, { stage: 'fetching', reason: problem }, 'the pack does not hold every episode of the season');
  entry.attempt = attempt;
  entry.attempts = [{ n: attempt, startedAt: Date.now(), endedAt: Date.now(), reason: 'search requested', release: null, outcome: 'failed', detail: problem.detail }];
  return entry;
}

// TMDB season 1 of 20 episodes. The tracker has one pack of that season, and the pack holds the ten episodes that the
// library has already. The other ten targets find no file in it.
async function partial(available = range(1, 10), legacy = false) {
  pipe = await startPipeline();
  const item = addTitle(range(1, 20).map((number) => ({ season: 1, number })));
  inLibrary(item, 1, available);
  const files = filesOf(1, 10);
  pipe.tracker.state.items = [{ title: FIRST, size: files.length * MIB_PER_EPISODE, files }];
  if (legacy) return { item, targets: range(1, 20).filter((n) => !available.includes(n)).map((n) => stuck(item, 1, n, { code: 'pack_partial' }, 1)) };
  const targets = pipe.finder.requestSearch(item.key);
  await until(() => targets.every((entry) => entry.state.kind === 'blocked' || entry.state.kind === 'waiting'));
  return { item, targets };
}

const affectedIds = (body: unknown) => ((body as { affected?: { id: string }[] }).affected ?? []).map((item) => item.id);
const searchJobs = (otherSeasons: boolean) =>
  Object.values(pipe!.db.data.jobs).filter((job) => job.type === 'queue.search' && Boolean((job.payload as { otherSeasons?: boolean } | null)?.otherSeasons) === otherSeasons);
const askOtherSeasons = (item: Title, season: number) => ({
  action: 'search_other_seasons',
  group: { titleKey: item.key, season },
});
// The map of the releases: the catalog episodes of each range and the release episodes that they name.
function mapReleases(item: Title, ranges: NumberingRange[]): Numbering {
  item.numbering = { revision: 1, ranges };
  return item.numbering;
}
// The rest of catalog season 1 is release season 2 from its first episode.
const REST_OF_SEASON: NumberingRange = { season: 1, from: 11, to: 20, releaseSeason: 2, releaseFrom: 1 };
// A query that does not name the season of the target. A search of other seasons names another season, or none.
const otherSeasonQueries = () => pipe!.tracker.state.searches.filter((url) => url.searchParams.get('season') !== '1');

const legacyPartial = (available = range(1, 10)) => partial(available, true);

describe('a partial pack', () => {
  it('does not add a pack that only contains episodes already in the library', async () => {
    await partial();
    expect(pipe!.tracker.state.downloads).toContain(FIRST);
    expect(pipe!.acquisition.filter((event) => event.type === 'add')).toEqual([]);
  });

  it('sends no query for another season of the releases before the action', async () => {
    await partial();
    const asked = pipe!.tracker.state.searches;
    expect(asked.length).toBeGreaterThan(0);
    expect(otherSeasonQueries()).toEqual([]);
  });

  it('starts no other-season search on a sweep or on a second search', async () => {
    const { item, targets } = await legacyPartial();
    const before = pipe!.tracker.state.searches.length;
    pipe!.finder.sweep();
    await pipe!.finder.search({ titleKey: item.key, season: 1, entryIds: targets.map((entry) => entry.id), fresh: true }, AbortSignal.timeout(5_000));
    expect(pipe!.tracker.state.searches).toHaveLength(before);
    expect(targets.every((entry) => reasonOfEntry(entry)?.code === 'pack_partial')).toBe(true);
    expect(searchJobs(true)).toEqual([]);
  });
});

describe('the action of the user', () => {
  it('previews the stuck targets of the season and starts nothing', async () => {
    const { item, targets } = await legacyPartial();
    mapReleases(item, [REST_OF_SEASON]);
    api = await pipe!.api();
    const before = pipe!.tracker.state.searches.length;

    const preview = await api.post('/queue/actions', { ...askOtherSeasons(item, 1), preview: true });
    expect(preview.status).toBe(200);
    expect(affectedIds(preview.body).sort()).toEqual(targets.map((entry) => entry.id).sort());
    expect((preview.body as { unsupported: unknown[] }).unsupported).toEqual([]);

    // The preview starts no job and sends no request.
    expect(pipe!.tracker.state.searches).toHaveLength(before);
    expect(searchJobs(true)).toEqual([]);
    expect(targets.every((entry) => reasonOfEntry(entry)?.code === 'pack_partial')).toBe(true);
  });

  it('starts the search for the targets of the action', async () => {
    const { item, targets } = await legacyPartial();
    mapReleases(item, [REST_OF_SEASON]);
    pipe!.tracker.state.items = [
      { title: FIRST, size: 10 * MIB_PER_EPISODE, files: filesOf(1, 10) },
      { title: SECOND, size: 10 * MIB_PER_EPISODE, files: filesOf(2, 10) },
    ];
    api = await pipe!.api();

    const started = await api.post('/queue/actions', askOtherSeasons(item, 1));
    expect(started.status).toBe(200);
    expect(affectedIds(started.body).sort()).toEqual(targets.map((entry) => entry.id).sort());

    // The action opens the targets with its own reason, and the run asks for another season of the releases.
    await until(() => targets.every((entry) => entry.history.some((event) => event.cause === 'search other seasons')));
    await until(() => pipe!.tracker.state.searches.some((url) => url.searchParams.get('season') === '2'));
    await until(() => targets.every((entry) => stageOf(entry) === 'downloading'));
    expect(targets.every((entry) => entry.release?.title === SECOND)).toBe(true);
  }, 20_000);

  it('refuses a second request for the same targets', async () => {
    const { item } = await legacyPartial();
    mapReleases(item, [REST_OF_SEASON]);
    pipe!.tracker.state.items = [
      { title: FIRST, size: 10 * MIB_PER_EPISODE, files: filesOf(1, 10) },
      { title: SECOND, size: 10 * MIB_PER_EPISODE, files: filesOf(2, 10) },
    ];
    api = await pipe!.api();

    expect((await api.post('/queue/actions', askOtherSeasons(item, 1))).status).toBe(200);
    const again = await api.post('/queue/actions', askOtherSeasons(item, 1));
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ error: 'action_not_supported' });
  });

  it('refuses the action when the season has no saved range', async () => {
    const { item, targets } = await legacyPartial();
    api = await pipe!.api();
    const before = pipe!.tracker.state.searches.length;

    const refused = await api.post('/queue/actions', askOtherSeasons(item, 1));

    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({ error: 'numbering_required' });
    // The action starts no query of another season, and the targets keep the reason of the pack.
    expect(pipe!.tracker.state.searches).toHaveLength(before);
    expect(otherSeasonQueries()).toEqual([]);
    expect(searchJobs(true)).toEqual([]);
    expect(targets.every((entry) => reasonOfEntry(entry)?.code === 'pack_partial')).toBe(true);
  });

  it('takes the states that an older version left, with their attempt counters', async () => {
    pipe = await startPipeline();
    const item = addTitle(range(1, 20).map((number) => ({ season: 1, number })));
    inLibrary(item, 1, range(1, 10));
    // Lupin and Jujutsu have this shape of the reason today, and their attempt counters are 3 or more.
    const targets = [
      stuck(item, 1, 11, { code: 'too_many_attempts', detail: 'pack_partial' }, 3),
      stuck(item, 1, 12, { code: 'too_many_attempts', detail: 'pack_partial' }, 4),
      stuck(item, 1, 13, { code: 'too_many_attempts', detail: 'pack_partial' }, 5),
    ];
    expect(targets.every((entry) => needsOtherSeasons(entry.state))).toBe(true);
    mapReleases(item, [REST_OF_SEASON]);
    pipe.tracker.state.items = [{ title: SECOND, size: 10 * MIB_PER_EPISODE, files: filesOf(2, 10) }];
    api = await pipe.api();

    const preview = await api.post('/queue/actions', { ...askOtherSeasons(item, 1), preview: true });
    expect(preview.status).toBe(200);
    expect(affectedIds(preview.body)).toEqual(targets.map((entry) => entry.id));

    expect((await api.post('/queue/actions', askOtherSeasons(item, 1))).status).toBe(200);
    await until(() => targets.every((entry) => stageOf(entry) === 'downloading'));
    // The manual action is not used up by the counter of the history.
    expect(targets.map((entry) => entry.attempt)).toEqual([4, 5, 6]);
  }, 20_000);
});

describe('the mapping of the release numbering', () => {
  it('gives each release episode of another season to its own episode of TMDB', async () => {
    const { item, targets } = await legacyPartial();
    mapReleases(item, [REST_OF_SEASON]);
    const files = filesOf(2, 10);
    pipe!.tracker.state.items = [
      { title: FIRST, size: 10 * MIB_PER_EPISODE, files: filesOf(1, 10) },
      { title: SECOND, size: files.length * MIB_PER_EPISODE, files },
    ];
    api = await pipe!.api();

    expect((await api.post('/queue/actions', askOtherSeasons(item, 1))).status).toBe(200);
    await until(() => targets.every((entry) => entry.release?.title === SECOND && stageOf(entry) === 'downloading'));
    pipe!.complete(SECOND, contentsOf(files), hashOf(SECOND, files));
    await until(() => targets.every((entry) => stageOf(entry) === 'available'), 20_000);

    // Release episode 1 is TMDB episode 11, release episode 2 is TMDB episode 12, and so on.
    for (const [index, entry] of targets.entries()) {
      const file = importedFile(item, entry)!;
      expect(file.path).toBe(pathOf(1, entry.number!));
      expect(file.episodes).toEqual([{ season: 1, number: entry.number }]);
      expect(readInLibrary(file.path)).toBe(dataOf(files[index]!));
    }
    // No target got the file of another episode: the library holds the ten files before and the ten new ones.
    expect(Object.values(pipe!.db.data.files).map((file) => file.path).sort()).toEqual(range(1, 20).map((number) => pathOf(1, number)).sort());
  }, 20_000);

  it('keeps the numbers of the block when some of its episodes are in the library already', async () => {
    // Episodes 12 to 15 have their files. The pack of the next release season holds 1 to 10 of its own numbering.
    const { item, targets } = await legacyPartial([...range(1, 10), ...range(12, 15)]);
    expect(targets.map((entry) => entry.number)).toEqual([11, 16, 17, 18, 19, 20]);
    mapReleases(item, [REST_OF_SEASON]);
    const files = filesOf(2, 10);
    pipe!.tracker.state.items = [
      { title: FIRST, size: 10 * MIB_PER_EPISODE, files: filesOf(1, 10) },
      { title: SECOND, size: files.length * MIB_PER_EPISODE, files },
    ];
    api = await pipe!.api();

    expect((await api.post('/queue/actions', askOtherSeasons(item, 1))).status).toBe(200);
    await until(() => targets.every((entry) => entry.release?.title === SECOND && stageOf(entry) === 'downloading'));
    pipe!.complete(SECOND, contentsOf(files), hashOf(SECOND, files));
    await until(() => targets.every((entry) => stageOf(entry) === 'available'), 20_000);

    // Episode 11 is the first file of the pack, and episode 16 is its sixth file. The available episodes take none.
    const expected = new Map([
      [11, 'Show.Name.S02E01.mkv'],
      [16, 'Show.Name.S02E06.mkv'],
      [17, 'Show.Name.S02E07.mkv'],
      [18, 'Show.Name.S02E08.mkv'],
      [19, 'Show.Name.S02E09.mkv'],
      [20, 'Show.Name.S02E10.mkv'],
    ]);
    for (const entry of targets) {
      const file = importedFile(item, entry)!;
      expect(file.path).toBe(pathOf(1, entry.number!));
      expect(readInLibrary(file.path)).toBe(dataOf(expected.get(entry.number!)!));
    }
    // The files of the episodes that the library holds are untouched.
    for (const number of range(12, 15)) {
      const one = item.episodes.find((candidate) => candidate.number === number)!;
      expect(one.fileId).toBe(`file-1x${number}`);
      expect(readInLibrary(pathOf(1, number))).toBe(`library-data-1x${number}`);
    }
    // The pack gave six files. The other four are episodes that the library holds, so they are not imported.
    expect(Object.values(pipe!.db.data.files)).toHaveLength(20);
  }, 20_000);
});

describe('Lupin', () => {
  it('maps the season 3 of the releases onto the missing episodes of TMDB season 2', async () => {
    pipe = await startPipeline();
    // TMDB season 2 has 7 episodes, and it has a season 3 of its own.
    const item = addTitle([...range(1, 7).map((number) => ({ season: 2, number })), ...range(1, 8).map((number) => ({ season: 3, number }))]);
    inLibrary(item, 2, range(1, 5));
    // The last episodes of TMDB season 2 are release season 3, from its sixth episode.
    mapReleases(item, [{ season: 2, from: 6, to: 7, releaseSeason: 3, releaseFrom: 6 }]);
    // The pack of season 2 held episodes 1 to 5, and the app wrote the record of what it holds.
    const heldBySeason2 = filesOf(2, 5);
    pipe.db.data.releaseCoverage[`1:${SECOND}`] = { titleKey: item.key, season: 2, numbers: range(1, 5), numberingRevision: 1 };
    const targets = [
      stuck(item, 2, 6, { code: 'too_many_attempts', detail: 'pack_partial' }, 3),
      stuck(item, 2, 7, { code: 'too_many_attempts', detail: 'pack_partial' }, 3),
    ];
    const files = filesOf(3, 7);
    pipe.tracker.state.items = [
      { title: SECOND, size: heldBySeason2.length * MIB_PER_EPISODE, files: heldBySeason2 },
      { title: THIRD, size: files.length * MIB_PER_EPISODE, files },
    ];
    api = await pipe!.api();

    const preview = await api.post('/queue/actions', { ...askOtherSeasons(item, 2), preview: true });
    expect(preview.status).toBe(200);
    expect(affectedIds(preview.body)).toEqual(targets.map((entry) => entry.id));

    expect((await api.post('/queue/actions', askOtherSeasons(item, 2))).status).toBe(200);
    await until(() => targets.every((entry) => entry.release?.title === THIRD && stageOf(entry) === 'downloading'), 20_000);
    // The action asks for the release season of the saved range only, and takes no file from the pack of the catalog
    // season.
    expect(pipe!.tracker.state.searches.some((url) => url.searchParams.get('season') === '3')).toBe(true);
    expect(pipe!.tracker.state.searches.some((url) => url.searchParams.get('season') === '2')).toBe(false);
    expect(pipe!.tracker.state.downloads).toEqual([THIRD]);

    pipe!.complete(THIRD, contentsOf(files), hashOf(THIRD, files));
    await until(() => targets.every((entry) => stageOf(entry) === 'available'), 20_000);

    // Release episode 6 is TMDB episode 6, because the packs of the releases continue the season of TMDB here.
    const sixth = importedFile(item, targets[0]!)!;
    const seventh = importedFile(item, targets[1]!)!;
    expect(sixth.path).toBe(pathOf(2, 6));
    expect(seventh.path).toBe(pathOf(2, 7));
    expect(readInLibrary(sixth.path)).toBe(dataOf('Show.Name.S03E06.mkv'));
    expect(readInLibrary(seventh.path)).toBe(dataOf('Show.Name.S03E07.mkv'));
    // The five episodes that the library had keep their files, and no file went to season 3.
    for (const number of range(1, 5)) expect(item.episodes.find((candidate) => candidate.season === 2 && candidate.number === number)!.fileId).toBe(`file-2x${number}`);
    expect(Object.values(pipe!.db.data.files).filter((file) => file.path.includes('Season 03'))).toEqual([]);
    expect(Object.values(pipe!.db.data.files)).toHaveLength(7);
  }, 20_000);
});

describe('Jujutsu Kaisen', () => {
  // TMDB season 1 of 59 episodes. The first 47 are in the library. The rest are stuck until the user declares the
  // release season that holds them.
  function jujutsu(ranges: NumberingRange[]) {
    const item = addTitle(range(1, 59).map((number) => ({ season: 1, number })));
    inLibrary(item, 1, range(1, 47));
    if (ranges.length) mapReleases(item, ranges);
    const files = filesOf(2, 12);
    const targets = range(48, 59).map((number) => stuck(item, 1, number, { code: 'pack_partial', detail: 'pack_partial' }, number <= 52 ? 4 : 5));
    pipe!.tracker.state.items = [{ title: SECOND, size: files.length * MIB_PER_EPISODE, files }];
    return { item, targets, files };
  }

  it('gives the pack of the next release season to the last episodes of the season', async () => {
    pipe = await startPipeline();
    const { item, targets, files } = jujutsu([{ season: 1, from: 48, to: 59, releaseSeason: 2, releaseFrom: 1 }]);
    api = await pipe.api();

    expect((await api.post('/queue/actions', askOtherSeasons(item, 1))).status).toBe(200);
    await until(() => targets.every((entry) => entry.release?.title === SECOND && stageOf(entry) === 'downloading'), 20_000);
    pipe!.complete(SECOND, contentsOf(files), hashOf(SECOND, files));
    await until(() => targets.every((entry) => stageOf(entry) === 'available'), 20_000);

    for (const [index, entry] of targets.entries()) {
      const file = importedFile(item, entry)!;
      expect(file.path).toBe(pathOf(1, entry.number!));
      expect(file.episodes).toEqual([{ season: 1, number: entry.number }]);
      expect(readInLibrary(file.path)).toBe(dataOf(files[index]!));
    }
    expect(Object.values(pipe!.db.data.files)).toHaveLength(59);
  }, 20_000);

  it('does not invent a range from the files of the pack', async () => {
    pipe = await startPipeline();
    const { item, targets } = jujutsu([]);
    api = await pipe.api();
    const before = pipe.tracker.state.searches.length;

    const refused = await api.post('/queue/actions', askOtherSeasons(item, 1));

    // Without a saved range the action asks for no other season, and the targets stay stuck.
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({ error: 'numbering_required' });
    expect(pipe.tracker.state.searches).toHaveLength(before);
    expect(searchJobs(true)).toEqual([]);
    expect(targets.every((entry) => reasonOfEntry(entry)?.code === 'pack_partial')).toBe(true);
    expect(targets.every((entry) => entry.continuation == null)).toBe(true);
    expect(item.numbering?.ranges ?? []).toEqual([]);
  }, 20_000);
});

describe('no solution', () => {
  it('keeps the targets stuck, records the search, and leaves no search in the queue', async () => {
    const { item, targets } = await legacyPartial();
    mapReleases(item, [REST_OF_SEASON]);
    api = await pipe!.api();

    expect((await api.post('/queue/actions', askOtherSeasons(item, 1))).status).toBe(200);
    // The run records its own result, and the targets keep the reason of the pack.
    await until(() => targets.every((entry) => entry.search !== null && entry.search.result !== null && entry.search.result !== 'grabbed'));
    for (const entry of targets) {
      expect(reasonOfEntry(entry)).toMatchObject({ code: 'pack_partial' });
    }
    expect(searchJobs(true)).toEqual([]);

    // A later sweep starts no other-season search either.
    const before = pipe!.tracker.state.searches.length;
    pipe!.finder.sweep();
    expect(searchJobs(true)).toEqual([]);
    expect(pipe!.tracker.state.searches).toHaveLength(before);
  }, 20_000);
});

describe('recovery', () => {
  it('keeps the mode of the run when the sweep recovers a lost search', async () => {
    pipe = await startPipeline();
    const item = addTitle(range(1, 20).map((number) => ({ season: 1, number })));
    const entry = pipe.queue.ensure(item.key, 1, 11);
    pipe.queue.request(entry, 'search requested');
    // The app stopped while the run of the user was open, and the job that held it is gone.
    pipe.queue.endAttempt(entry, 'failed', 'pack_partial');
    pipe.queue.startAttempt(entry, 'search other seasons');
    expect(entry.state).toEqual({ kind: 'queued' });

    pipe.finder.sweep();

    const jobs = Object.values(pipe.db.data.jobs).filter((job) => job.type === 'queue.search' && ((job.payload as { entryIds?: string[] }).entryIds ?? []).includes(entry.id));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload).toMatchObject({ titleKey: item.key, season: 1, otherSeasons: true });
  });
});
