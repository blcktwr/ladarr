import { move, branchOf } from './helpers/test-queue.ts';
import { itemFor, stageOf, reasonOfEntry } from '../src/library/downloads/queue.ts';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeLog, logToFile, recentLogs } from '../src/core/log.ts';
import { queueInitialHandler } from '../src/jobs/queue-initial.ts';
import { episode, movie, title } from './helpers/test-fixtures.ts';
import { hashOf, MIB, startPipeline, until } from './helpers/test-pipeline.ts';

let pipe: Awaited<ReturnType<typeof startPipeline>> | undefined;
let api: Awaited<ReturnType<Awaited<ReturnType<typeof startPipeline>>['api']>> | undefined;
afterEach(async () => {
  api?.close();
  await pipe?.stop();
  pipe = api = undefined;
});

const stagesOf = (entry: { history: { stage: string }[] }) => entry.history.map((event) => event.stage).filter((stage, i, all) => stage !== all[i - 1]);

describe('movie journey', () => {
  it('goes from a search to a file in the library, and keeps the seeding source', async () => {
    pipe = await startPipeline();
    const film = movie({ rootId: 'movie', meta: { ...movie().meta, date: '2019-06-01', releaseDates: [{ region: 'US', kind: 'digital', date: '2019-06-01' }] } });
    pipe.db.data.titles[film.key] = film;
    const name = 'Movie.Name.2019.1080p.BluRay.x264-GRP';
    const files = { [`${name}.mkv`]: 'video-data', 'Sample/sample.mkv': 'x', 'info.nfo': 'n' };
    const paths = Object.keys(files);
    const hash = hashOf(name, paths);
    pipe.tracker.state.items = [
      { title: 'Movie.Name.2019.CAM-BAD', size: 800 * MIB },
      { title: name, size: 100 * 120 * MIB, files: paths },
    ];

    const [entry] = pipe.finder.requestSearch(film.key);
    expect(entry!.id).toBe('movie:2');
    await until(() => stageOf(entry!) === 'downloading');
    expect(entry!.release).toMatchObject({ title: name, kind: 'single' });
    expect(entry!.transferHash).toBe(hash);
    expect(pipe.qbit.torrents.get(hash)).toMatchObject({ tags: expect.stringMatching(/^ladarr-/), save_path: pipe.folders.downloads });

    pipe.complete(name, files, hash);
    await until(() => stageOf(entry!) === 'available');

    const file = Object.values(pipe.db.data.files)[0]!;
    expect(file.path).toBe('Movie Name (2019)/Movie Name (2019).mkv');
    expect(readFileSync(join(pipe.folders.movies, file.path), 'utf8')).toBe('video-data');
    // A hard link: both names are the same file, so the seeding source is untouched.
    const source = statSync(join(pipe.folders.downloads, name, `${name}.mkv`));
    expect(statSync(join(pipe.folders.movies, file.path)).ino).toBe(source.ino);
    expect(entry!.importResult).toMatchObject({ ok: true, method: 'hardlink' });
    expect(pipe.db.data.titles[film.key]!.fileId).toBe(file.id);
    expect(pipe.db.data.titles[film.key]!.folder).toBe('Movie Name (2019)');
    expect(pipe.db.data.imports).toEqual({});
    expect(stagesOf(entry!)).toEqual(['queued', 'searching', 'fetching', 'downloading', 'importing', 'available']);
    expect(pipe.qbit.torrents.has(hash)).toBe(true);
  });

  it('stops when every candidate is rejected, and says why', async () => {
    pipe = await startPipeline();
    const film = movie({ rootId: 'movie', manualRelease: true });
    pipe.db.data.titles[film.key] = film;
    pipe.tracker.state.items = [{ title: 'Movie.Name.2018.1080p.BluRay-GRP', size: 100 * 120 * MIB }, { title: 'Movie.Name.2019.CAM-GRP', size: 500 * MIB }];
    const [entry] = pipe.finder.requestSearch(film.key);
    await until(() => itemFor(entry!)?.state.kind === 'blocked');
    expect(itemFor(entry!)?.state).toMatchObject({ kind: 'blocked', problem: { code: 'all_rejected' } });
    expect(reasonOfEntry(entry!)?.code).toBe('all_rejected');
    expect(entry!.search).toMatchObject({ result: 'all_rejected', candidates: 2, accepted: 0, indexers: [{ state: 'done', count: 2 }] });
    expect(entry!.search!.nextAt).toBeNull();
    expect(entry!.search!.topRejections).toContain('year_mismatch');
    expect(pipe.qbit.torrents.size).toBe(0);
  });

  it('does not search a movie that is not released', async () => {
    pipe = await startPipeline();
    const film = movie({ rootId: 'movie' });
    pipe.db.data.titles[film.key] = film;
    expect(pipe.finder.requestSearch(film.key)).toEqual([]);
    expect(pipe.tracker.state.searches).toHaveLength(0);
  });
});

describe('release comment', () => {
  const comment = 'A comment from the tracker';
  const film = () => movie({ rootId: 'movie', meta: { ...movie().meta, date: '2019-06-01', releaseDates: [{ region: 'US', kind: 'digital', date: '2019-06-01' }] } });

  it('keeps the comment of the torrent file', async () => {
    pipe = await startPipeline();
    const item = film();
    pipe.db.data.titles[item.key] = item;
    pipe.tracker.state.items = [{ title: 'Movie.Name.2019.1080p.BluRay-GRP', size: 100 * 120 * MIB, comment }];

    const [entry] = pipe.finder.requestSearch(item.key);
    await until(() => stageOf(entry!) === 'downloading');
    expect(entry!.release?.comment).toBe(comment);
  });

  it('has no comment when the release comes without one', async () => {
    pipe = await startPipeline();
    const item = film();
    pipe.db.data.titles[item.key] = item;
    pipe.tracker.state.items = [{ title: 'Movie.Name.2019.1080p.BluRay-GRP', size: 100 * 120 * MIB }];

    const [entry] = pipe.finder.requestSearch(item.key);
    await until(() => stageOf(entry!) === 'downloading');
    expect(entry!.release?.comment).toBeUndefined();
  });
});

describe('series journey', () => {
  const aired = (n: number) => episode(1, n, '2020-01-0' + n);
  const show = () => title({ rootId: 'tv', episodes: [aired(1), aired(2), aired(3)] });

  it('takes one season pack for three episodes: one transfer, three targets', async () => {
    pipe = await startPipeline();
    const series = show();
    pipe.db.data.titles[series.key] = series;
    const pack = 'Show.Name.S01.1080p.WEB-DL.DDP5.1-GRP';
    const files = {
      'Show.Name.S01E01.mkv': 'one', 'Show.Name.S01E02.mkv': 'two',
      'extras/Show.Name.S01E03.mkv': 'bonus', 'episodes/Show.Name.S01E03.mkv': 'three-data',
    };
    const hash = hashOf(pack, Object.keys(files));
    pipe.tracker.state.items = [
      { title: pack, size: 3 * 60 * 45 * MIB, files: Object.keys(files) },
      { title: 'Show.Name.S01E01.1080p.WEB-DL-GRP', size: 60 * 45 * MIB },
    ];
    const entries = pipe.finder.requestSearch(series.key);
    expect(entries.map((e) => e.id)).toEqual(['tv:1:1x1', 'tv:1:1x2', 'tv:1:1x3']);
    await until(() => entries.every((e) => stageOf(e) === 'downloading'));
    expect(pipe.qbit.torrents.size).toBe(1);
    expect(new Set(entries.map((e) => e.transferHash))).toEqual(new Set([hash]));
    // One query for the whole season, not one for each episode.
    expect(pipe.tracker.state.searches.filter((u) => u.searchParams.get('t') === 'tvsearch')).toHaveLength(1);
    expect(pipe.tracker.state.searches[0]!.searchParams.get('ep')).toBeNull();

    pipe.complete(pack, files, hash);
    await until(() => entries.every((e) => stageOf(e) === 'available'));
    const paths = Object.values(pipe.db.data.files).map((f) => f.path).sort();
    expect(paths).toEqual(['Show Name (2020)/Season 01/Show Name - S01E01 - Episode 1.mkv', 'Show Name (2020)/Season 01/Show Name - S01E02 - Episode 2.mkv', 'Show Name (2020)/Season 01/Show Name - S01E03 - Episode 3.mkv']);
    expect(readFileSync(join(pipe.folders.tv, paths[2]!), 'utf8')).toBe('three-data');
    expect(series.episodes.every((e) => e.fileId)).toBe(true);
  });

  it('maps the numbers of a relative season pack to the numbers of the title', async () => {
    pipe = await startPipeline();
    const series = title({ rootId: 'tv', episodes: [episode(2, 33, '2020-01-01'), episode(2, 34, '2020-01-02'), episode(2, 35, '2020-01-03')] });
    series.numbering = { revision: 1, ranges: [{ season: 2, from: 33, to: 35, releaseSeason: 2, releaseFrom: 1 }] };
    pipe.db.data.titles[series.key] = series;
    const pack = 'Show.Name.S02.1080p.WEB-DL.GRP';
    const files = ['Show.Name.S02E01.mkv', 'Show.Name.S02E02.mkv', 'Show.Name.S02E03.mkv'];
    pipe.tracker.state.items = [{ title: pack, size: 3 * 60 * 45 * MIB, files }];
    const entries = pipe.finder.requestSearch(series.key);
    await until(() => entries.every((e) => stageOf(e) === 'downloading'));
    expect(pipe.qbit.torrents.size).toBe(1);

    pipe.complete(pack, { 'Show.Name.S02E01.mkv': 'one', 'Show.Name.S02E02.mkv': 'two', 'Show.Name.S02E03.mkv': 'three' }, hashOf(pack, files));
    await until(() => entries.every((e) => stageOf(e) === 'available'));
    const paths = Object.values(pipe.db.data.files).map((f) => f.path).sort();
    expect(paths).toEqual(['Show Name (2020)/Season 02/Show Name - S02E33 - Episode 33.mkv', 'Show Name (2020)/Season 02/Show Name - S02E34 - Episode 34.mkv', 'Show Name (2020)/Season 02/Show Name - S02E35 - Episode 35.mkv']);
    expect(series.episodes.every((e) => e.fileId)).toBe(true);
  });

  it('imports a pack whose files name the episode but not the season', async () => {
    pipe = await startPipeline();
    const series = title({ rootId: 'tv', episodes: [episode(2, 1, '2020-01-01'), episode(2, 2, '2020-01-02')] });
    pipe.db.data.titles[series.key] = series;
    const pack = 'Show.Name.S02.1080p.BluRay-GRP';
    const files = { 'Show E01.mkv': 'one', 'Show E02.mkv': 'two' };
    pipe.tracker.state.items = [{ title: pack, size: 2 * 60 * 45 * MIB, files: Object.keys(files) }];
    const entries = pipe.finder.requestSearch(series.key);
    await until(() => entries.every((e) => stageOf(e) === 'downloading'));

    // The name of each file gives the episode only. The targets of the pack give the season.
    pipe.complete(pack, files, hashOf(pack, Object.keys(files)));
    await expect.poll(() => entries.map((entry) => ({ stage: stageOf(entry), problem: reasonOfEntry(entry) })), { timeout: 5_000 })
      .toEqual(entries.map(() => ({ stage: 'available', problem: null })));
    const paths = Object.values(pipe.db.data.files).map((f) => f.path).sort();
    expect(paths).toEqual(['Show Name (2020)/Season 02/Show Name - S02E01 - Episode 1.mkv', 'Show Name (2020)/Season 02/Show Name - S02E02 - Episode 2.mkv']);
    expect(series.episodes.every((e) => e.fileId)).toBe(true);
  }, 20_000);

  it('links every query of a series to one request per indexer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ladarr-pipe-requests-'));
    logToFile(join(dir, 'ladarr.log'));
    try {
      pipe = await startPipeline();
      const series = title({ rootId: 'tv', episodes: [aired(1), aired(2), aired(3)], meta: { ...title().meta, aliases: ['Show Alias'] } });
      pipe.db.data.titles[series.key] = series;
      pipe.tracker.state.items = [];
      const entries = pipe.finder.requestSearch(series.key);
      await until(() => entries.every((entry) => stageOf(entry) === 'queued' && branchOf(entry) === 'waiting'));
      const queries = pipe.tracker.state.searches.filter((url) => url.searchParams.get('t') === 'tvsearch');
      expect(queries.map((url) => url.searchParams.get('season'))).toEqual(['1', '1', '1', '1', '1']);
      expect(queries.filter((url) => !url.searchParams.has('ep')).map((url) => url.searchParams.get('q')).sort()).toEqual(['Show Alias', 'Show Name']);
      expect(queries.flatMap((url) => url.searchParams.has('ep') ? [url.searchParams.get('ep')] : [])).toEqual(['1', '2', '3']);
      await closeLog();

      const lines = (await recentLogs(500)).filter((line) => line.itemType === 'tv' && String(line.itemId ?? '').startsWith('tv:1'));
      const requests = lines.flatMap((line) => (Array.isArray(line.requests) ? (line.requests as { indexer?: string; system?: string; requestId?: string }[]) : []));
      expect(requests.length).toBeGreaterThan(1);
      // A log line shows one button per indexer, not one for each query of the same indexer. The client inventory of
      // the preflight has an id of its own, and its system name keeps it apart.
      const indexers = requests.filter((item) => item.indexer);
      expect(new Set(indexers.map((item) => item.requestId)).size).toBe(1);
    } finally {
      await closeLog();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('imports the covered episodes and keeps the missing episode blocked with its source', async () => {
    pipe = await startPipeline();
    const series = show();
    pipe.db.data.titles[series.key] = series;
    const pack = 'Show.Name.S01.1080p.WEB-DL-GRP';
    pipe.tracker.state.items = [{ title: pack, size: 3 * 60 * 45 * MIB }];
    const entries = pipe.finder.requestSearch(series.key);
    await until(() => entries.every((e) => stageOf(e) === 'downloading'));
    const searches = pipe.tracker.state.searches.length;
    pipe.tracker.state.items = [];
    pipe.complete(pack, { 'Show.Name.S01E01.mkv': 'one', 'Show.Name.S01E03.mkv': 'three' });
    await until(() => entries.filter((e) => stageOf(e) === 'available').length === 2 && entries[1]!.state.kind === 'blocked' && entries[1]!.state.at === 'importing');
    await until(() => !Object.values(pipe!.db.data.jobs).some((job) => job.type === 'import.run'));
    expect(entries.map((e) => stageOf(e))).toEqual(['available', 'importing', 'available']);
    expect(entries[1]).toMatchObject({ state: { kind: 'blocked', at: 'importing' }, transferHash: hashOf(pack), release: { title: pack }, clientId: 'client-1', attempt: 1 });
    expect(['pack_partial', 'file_not_found']).toContain(reasonOfEntry(entries[1]!)?.code);
    expect(entries[1]!.attempts).toHaveLength(1);
    expect(entries[1]!.attempts[0]).toMatchObject({ n: 1, outcome: 'failed', reason: 'search requested' });
    expect(series.episodes.map((episode) => Boolean(episode.fileId))).toEqual([true, false, true]);
    expect(Object.values(pipe.db.data.files).flatMap((file) => file.episodes).sort((a, b) => a.number - b.number)).toEqual([{ season: 1, number: 1 }, { season: 1, number: 3 }]);
    expect(pipe.db.data.releaseCoverage[`1:${pack}`]).toMatchObject({ titleKey: series.key, season: 1, numbers: [1, 3] });
    expect(pipe.tracker.state.searches).toHaveLength(searches);
    expect(pipe.tracker.state.downloads).toEqual([pack]);
    expect(pipe.qbit.torrents.size).toBe(1);
    expect(Object.values(pipe.db.data.jobs).some((job) => job.type === 'queue.search' && (job.payload as { entryIds: string[] }).entryIds.includes(entries[1]!.id))).toBe(false);
  });

  it('holds a partial season and accepts both packs after the user corrects the numbering', async () => {
    pipe = await startPipeline();
    // TMDB counts 23 episodes in season 1, and no season 2. The releases count the first 13 in season 1.
    const series = title({ rootId: 'tv', episodes: Array.from({ length: 23 }, (_, index) => episode(1, index + 1, '2020-01-01')) });
    pipe.db.data.titles[series.key] = series;
    const first = 'Show.Name.S01.1080p.WEB-DL-GRP';
    const second = 'Show.Name.S02.1080p.WEB-DL-GRP';
    const named = (season: number, count: number) => Array.from({ length: count }, (_, index) => `Show.Name.S0${season}E${String(index + 1).padStart(2, '0')}.mkv`);
    const firstFiles = named(1, 13);
    const secondFiles = named(2, 10);
    const content = (files: string[]) => Object.fromEntries(files.map((file) => [file, `data-of-${file}`]));
    pipe.tracker.state.items = [{ title: first, size: 13 * 600 * MIB, files: firstFiles }];

    const entries = pipe.finder.requestSearch(series.key);
    const turn = itemFor(entries[0]!)!;
    await expect.poll(() => turn.state, { timeout: 8_000 }).toMatchObject({ kind: 'blocked', problem: { code: 'pack_partial' } });
    expect(entries.slice(13).map((entry) => reasonOfEntry(entry)?.code)).toEqual(Array(10).fill('pack_partial'));
    expect(turn.search).toMatchObject({ rejected: [] });
    expect(pipe.qbit.torrents.size).toBe(0);
    expect(turn.selected[hashOf(first, firstFiles)]).toMatchObject({ status: 'prepared', numberingRevision: 0 });
    expect(pipe.tracker.state.downloads).toEqual([first]);
    // The record of the files of the pack keeps the episodes that it holds.
    expect(pipe.db.data.releaseCoverage[`1:${first}`]).toMatchObject({ titleKey: series.key, season: 1, numbers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13] });

    // The releases count the rest of the season as their season 2. The user saves the map and starts the action.
    pipe.tracker.state.items = [
      { title: first, size: 13 * 600 * MIB, files: firstFiles },
      { title: second, size: 10 * 600 * MIB, files: secondFiles },
    ];
    api = await pipe.api();
    expect((await api.patch(`/library/${series.key}`, { episodeSeasons: {
      revision: 0, edits: entries.slice(13).map(({ number }) => ({ season: 1, number, releaseSeason: 2, search: true })),
    } })).status).toBe(200);
    await expect.poll(() => ({
      turn: turn.state.kind,
      stages: entries.map(stageOf),
      metadata: pipe!.tracker.state.downloads,
      added: pipe!.acquisition.flatMap((event) => event.type === 'add' ? [event.hash] : []).sort(),
    }), { timeout: 10_000 }).toMatchObject({
      turn: 'downloading',
      stages: entries.map(() => 'downloading'),
      metadata: expect.arrayContaining([first, second]),
      added: [hashOf(first, firstFiles), hashOf(second, secondFiles)].sort(),
    });

    pipe.complete(first, content(firstFiles), hashOf(first, firstFiles));
    pipe.complete(second, content(secondFiles), hashOf(second, secondFiles));
    await until(() => entries.every((entry) => stageOf(entry) === 'available'), 20_000);
    const paths = Object.values(pipe.db.data.files).map((file) => file.path);
    expect(paths).toHaveLength(23);
    // The files of the second pack take the numbers of the season of the title.
    expect(paths).toContain('Show Name (2020)/Season 01/Show Name - S01E14 - Episode 14.mkv');
    expect(paths).toContain('Show Name (2020)/Season 01/Show Name - S01E23 - Episode 23.mkv');
    expect(series.episodes.every((episode) => episode.fileId)).toBe(true);
  }, 30_000);

  // A title that TMDB counts as one season of 23 episodes. The first `available` episodes are in the library, and a pack
  // of 12 episodes of the season holds them, so the record of the pack says what it holds. `regular` names other pending
  // episodes of the season that the pack holds too. The other pending episodes are the rest of the season: the pack did
  // not hold them, so they are stuck with `pack_partial`, and they store the numbering that an older version wrote.
  function seasonSplit({ available = 12, alsoAvailable = [] as number[], regular = [] as number[] } = {}) {
    const episodes = Array.from({ length: 23 }, (_, index) => episode(1, index + 1, '2020-01-01'));
    const series = title({ rootId: 'tv', episodes });
    // The releases count the last eleven episodes of the season as their season 2.
    series.numbering = { revision: 1, ranges: [{ season: 1, from: 13, to: 23, releaseSeason: 2, releaseFrom: 1 }] };
    pipe!.db.data.titles[series.key] = series;
    const hasFile = (number: number) => number <= available || alsoAvailable.includes(number);
    for (const item of episodes.filter((item) => hasFile(item.number))) {
      const id = `file-${item.number}`;
      pipe!.db.data.files[id] = { id, titleKey: series.key, path: `Show Name (2020)/Season 01/Show Name - S01E${String(item.number).padStart(2, '0')} - Episode ${item.number}.mkv`, sizeBytes: 1, mtimeMs: 0, episodes: [{ season: 1, number: item.number }], missing: false, addedAt: Date.now() };
      item.fileId = id;
    }
    const named = (season: number, count: number) => Array.from({ length: count }, (_, index) => `Show.Name.S0${season}E${String(index + 1).padStart(2, '0')}.mkv`);
    const first = { title: 'Show.Name.S01.1080p.WEB-DL-GRP', size: 12 * 600 * MIB, files: named(1, 12) };
    const second = { title: 'Show.Name.S02.1080p.WEB-DL-GRP', size: 11 * 600 * MIB, files: named(2, 11) };
    // The record of the partial pack: its files are the first 12 episodes of the release season.
    pipe!.db.data.releaseCoverage[`1:${first.title}`] = { titleKey: series.key, season: 1, numbers: Array.from({ length: 12 }, (_, index) => index + 1), numberingRevision: 1 };
    const entries = episodes
      .filter((item) => !hasFile(item.number) && !regular.includes(item.number))
      .map((item) => {
        const entry = pipe!.queue.ensure(series.key, 1, item.number);
        pipe!.queue.request(entry, 'search requested');
        move(pipe!.queue, entry, { stage: 'fetching', reason: { code: 'pack_partial' } }, 'pack does not hold every episode');
        return entry;
      });
    return { series, entries, named, first, second };
  }

  const laterEpisodes = Array.from({ length: 10 }, (_, index) => 14 + index);

  it('keeps the target of the title season and the rest of the season apart, and searches only the rest', async () => {
    pipe = await startPipeline();
    const { series, entries, first, second } = seasonSplit({ available: 11, regular: [12] });
    const single = 'Show.Name.S01E12.1080p.WEB-DL-GRP';
    const episode = { title: single, size: 60 * 45 * MIB };
    pipe.tracker.state.items = [first, episode, second];
    pipe.tracker.state.answer = (url) => {
      const season = url.searchParams.get('season');
      const number = url.searchParams.get('ep');
      if (season === '1') return number === '12' ? [episode] : number === null ? [first] : [];
      return season === '2' && number === null ? [second] : [];
    };

    // Episode 12 belongs to the numbering of the title. Its own search takes the release of its own season.
    const [regular] = pipe.finder.requestSearch(series.key, { season: 1, number: 12 });
    const turn = itemFor(regular!)!;
    await expect.poll(() => turn.selected[hashOf(single)]).toMatchObject({ status: 'prepared', release: { title: single } });
    expect(pipe.acquisition.filter(({ type }) => type === 'add')).toEqual([]);
    expect(regular!.numbering).toEqual(series.numbering);
    // The rest of the season is the part of the saved range, and it is stuck.
    expect(entries.every((entry) => series.numbering!.ranges.some((range) => entry.number! >= range.from && entry.number! <= range.to))).toBe(true);
    expect(entries.every((entry) => reasonOfEntry(entry)?.code === 'pack_partial')).toBe(true);

    // The action covers the targets of the rest only.
    api = await pipe.api();
    const group = { titleKey: series.key, season: 1 };
    const preview = await api.post('/queue/actions', { action: 'search_other_seasons', group, preview: true });
    expect(preview.body.affected.map((item: { id: string }) => item.id)).toEqual(entries.map((entry) => entry.id));
    expect((await api.post('/queue/actions', { action: 'search_other_seasons', group })).status).toBe(200);
    await expect.poll(() => turn.selected[hashOf(second.title, second.files)], { timeout: 10_000 }).toMatchObject({ status: 'accepted', release: { title: second.title } });
    expect(entries.every((entry) => entry.release?.title === second.title && stageOf(entry) === 'downloading')).toBe(true);
    // The two numberings stay apart: the target of the title season keeps its own release.
    expect(regular!.release?.title).toBe(single);
    expect(stageOf(regular!)).toBe('downloading');
  }, 30_000);

  it('finds a single file of another release season for a target that stores its numbering', async () => {
    pipe = await startPipeline();
    const { series, entries } = seasonSplit({ alsoAvailable: laterEpisodes });
    const target = entries.find((entry) => entry.number === 13)!;
    const single = 'Show.Name.S02E01.1080p.WEB-DL-GRP';
    // The release season 2 numbers episode 13 of the title as its first file. No pack answers.
    pipe.tracker.state.answer = (url) => (url.searchParams.get('season') === '2' && url.searchParams.get('ep') === '1' ? [{ title: single, size: 60 * 45 * MIB }] : []);
    api = await pipe.api();

    expect((await api.post('/queue/actions', { action: 'search_other_seasons', group: { titleKey: series.key, season: 1 } })).status).toBe(200);
    await expect.poll(() => ({ stage: stageOf(target), release: target.release?.title }), { timeout: 8_000 }).toEqual({ stage: 'downloading', release: single });
    pipe.complete(single, { [`${single}.mkv`]: 'data' }, hashOf(single));
    await until(() => stageOf(target) === 'available', 20_000);

    const file = Object.values(pipe.db.data.files).find((item) => item.episodes.some((one) => one.season === 1 && one.number === 13));
    expect(file?.path).toBe('Show Name (2020)/Season 01/Show Name - S01E13 - Episode 13.mkv');
  }, 30_000);

  it('finds the file of another release season under an alias', async () => {
    pipe = await startPipeline();
    const { series, entries } = seasonSplit({ alsoAvailable: laterEpisodes });
    series.meta.aliases = ['Show Alias'];
    const target = entries.find((entry) => entry.number === 13)!;
    const single = 'Show.Name.S02E01.1080p.WEB-DL-GRP';
    pipe.tracker.state.answer = (url) =>
      url.searchParams.get('q') === 'Show Alias' && url.searchParams.get('season') === '2' && url.searchParams.get('ep') === '1' ? [{ title: single, size: 60 * 45 * MIB }] : [];
    api = await pipe.api();

    expect((await api.post('/queue/actions', { action: 'search_other_seasons', group: { titleKey: series.key, season: 1 } })).status).toBe(200);
    await expect.poll(() => ({
      release: target.release?.title,
      queries: pipe!.tracker.state.searches.filter((url) => url.searchParams.get('ep') === '1').map((url) => url.searchParams.get('q')),
    }), { timeout: 8_000 }).toMatchObject({ release: single, queries: expect.arrayContaining(['Show Alias']) });
    await until(() => stageOf(target) === 'downloading');
    pipe.complete(single, { [`${single}.mkv`]: 'data' }, hashOf(single));
    await until(() => stageOf(target) === 'available', 20_000);

    const file = Object.values(pipe.db.data.files).find((item) => item.episodes.some((one) => one.season === 1 && one.number === 13));
    expect(file?.path).toBe('Show Name (2020)/Season 01/Show Name - S01E13 - Episode 13.mkv');
  }, 30_000);

  it('keeps the rest of the season stuck when no release of another season fits', async () => {
    pipe = await startPipeline();
    const { series, entries, first } = seasonSplit();
    pipe.tracker.state.items = [first];
    api = await pipe.api();

    expect((await api.post('/queue/actions', { action: 'search_other_seasons', group: { titleKey: series.key, season: 1 } })).status).toBe(200);
    // The run records its own result, and the targets stay stuck with the pack as the reason.
    await until(() => entries.every((entry) => entry.search !== null && entry.search.result !== null && entry.search.result !== 'grabbed'), 20_000);
    expect(entries.every((entry) => reasonOfEntry(entry)?.code === 'pack_partial')).toBe(true);
    // The pack of the title season does not come back for the rest of the season.
    expect(pipe.tracker.state.downloads).not.toContain(first.title);
    // The run leaves no search of another season in the queue.
    expect(Object.values(pipe.db.data.jobs).filter((job) => job.type === 'queue.search' && Boolean((job.payload as { otherSeasons?: boolean } | null)?.otherSeasons))).toEqual([]);
  }, 30_000);

  it('never sends the 12-episode torrent for a 23-episode request', async () => {
    pipe = await startPipeline();
    const series = title({ rootId: 'tv', episodes: Array.from({ length: 23 }, (_, index) => episode(1, index + 1, '2020-01-01')) });
    pipe.db.data.titles[series.key] = series;
    const named = (season: number, count: number) => Array.from({ length: count }, (_, index) => `Show.Name.S0${season}E${String(index + 1).padStart(2, '0')}.mkv`);
    const firstFiles = named(1, 12);
    const secondFiles = named(2, 11);
    const first = 'Show.Name.S01.1080p.WEB-DL-GRP';
    const second = 'Show.Name.S02.1080p.WEB-DL-GRP';
    const content = (files: string[]) => Object.fromEntries(files.map((file) => [file, `data-of-${file}`]));
    pipe.tracker.state.items = [{ title: first, size: 12 * 600 * MIB, files: firstFiles }];

    const entries = pipe.finder.requestSearch(series.key);
    const turn = itemFor(entries[0]!)!;
    await expect.poll(() => turn.state, { timeout: 8_000 }).toMatchObject({ kind: 'blocked', problem: { code: 'pack_partial' } });
    expect(entries.slice(12).map((entry) => reasonOfEntry(entry)?.code)).toEqual(Array(11).fill('pack_partial'));
    expect(turn.search).toMatchObject({ rejected: [] });
    expect(Object.keys(turn.selected[hashOf(first, firstFiles)]?.matches ?? {})).toEqual(entries.slice(0, 12).map(({ id }) => id));
    expect(pipe.qbit.calls.filter((call) => call.path === 'torrents/add')).toHaveLength(0);
    expect(entries.every((entry) => !entry.history.some((event) => event.stage === 'downloading'))).toBe(true);
    expect(pipe.db.data.releaseCoverage[`1:${first}`]).toMatchObject({ titleKey: series.key, season: 1, numbers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] });

    // The releases number the rest of the season as their season 2. The user saves the map and starts the action.
    pipe.tracker.state.items = [
      { title: first, size: 12 * 600 * MIB, files: firstFiles },
      { title: second, size: 11 * 600 * MIB, files: secondFiles },
    ];
    api = await pipe.api();
    expect((await api.patch(`/library/${series.key}`, { episodeSeasons: {
      revision: 0, edits: entries.slice(12).map(({ number }) => ({ season: 1, number, releaseSeason: 2, search: true })),
    } })).status).toBe(200);
    await expect.poll(() => ({
      turn: turn.state.kind,
      stages: entries.map(stageOf),
      metadata: pipe!.tracker.state.downloads,
      added: pipe!.acquisition.flatMap((event) => event.type === 'add' ? [event.hash] : []).sort(),
    }), { timeout: 10_000 }).toMatchObject({
      turn: 'downloading',
      stages: entries.map(() => 'downloading'),
      metadata: expect.arrayContaining([first, second]),
      added: [hashOf(first, firstFiles), hashOf(second, secondFiles)].sort(),
    });
    expect(pipe.qbit.torrents.size).toBe(2);

    pipe.complete(first, content(firstFiles), hashOf(first, firstFiles));
    pipe.complete(second, content(secondFiles), hashOf(second, secondFiles));
    await until(() => entries.every((entry) => stageOf(entry) === 'available'), 20_000);
    const paths = Object.values(pipe.db.data.files).map((file) => file.path);
    expect(paths).toHaveLength(23);
    expect(paths).toContain('Show Name (2020)/Season 01/Show Name - S01E13 - Episode 13.mkv');
    expect(paths).toContain('Show Name (2020)/Season 01/Show Name - S01E23 - Episode 23.mkv');
  }, 30_000);

  it('searches an episode on its own when no pack fits, and takes a fallback after a bad file', async () => {
    pipe = await startPipeline();
    const series = title({ rootId: 'tv', episodes: [aired(1)] });
    pipe.db.data.titles[series.key] = series;
    const bad = 'Show.Name.S01E01.1080p.WEB-DL-AAA';
    const good = 'Show.Name.S01E01.1080p.WEBRip-BBB';
    pipe.tracker.state.items = [{ title: bad, size: 60 * 45 * MIB }, { title: good, size: 55 * 45 * MIB }];
    const [entry] = pipe.finder.requestSearch(series.key);
    await until(() => stageOf(entry!) === 'downloading');
    // The best release is the WEB-DL.
    expect(entry!.release!.title).toBe(bad);
    expect(pipe.tracker.state.searches[0]!.searchParams.get('ep')).toBe('1');

    // The client reports a fault: this is a problem of the client, not a bad release, so the entry keeps its attempt.
    pipe.qbit.progress(hashOf(bad), 0.4, 'missingFiles');
    await until(() => reasonOfEntry(entry!)?.code === 'client_error');
    expect(reasonOfEntry(entry!)).toMatchObject({ code: 'client_error' });
  });
});

describe('safety of the grab', () => {
  it('makes one attempt for one target when searches run at the same time', async () => {
    pipe = await startPipeline();
    const film = movie({ rootId: 'movie', manualRelease: true });
    pipe.db.data.titles[film.key] = film;
    const name = 'Movie.Name.2019.1080p.BluRay-GRP';
    pipe.tracker.state.items = [{ title: name, size: 100 * 120 * MIB }];
    pipe.finder.requestSearch(film.key);
    pipe.finder.requestSearch(film.key);
    pipe.finder.requestSearch(film.key);
    const entry = pipe.queue.get(film.key)!;
    await until(() => stageOf(entry) === 'downloading');
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(pipe.qbit.torrents.size).toBe(1);
    expect(entry.attempts).toHaveLength(1);
    expect(pipe.tracker.state.downloads).toEqual([name]);
  });

  it('does not add a second torrent when the add times out', async () => {
    pipe = await startPipeline();
    const film = movie({ rootId: 'movie', manualRelease: true });
    pipe.db.data.titles[film.key] = film;
    const name = 'Movie.Name.2019.1080p.BluRay-GRP';
    pipe.tracker.state.items = [{ title: name, size: 100 * 120 * MIB }];
    pipe.qbit.control.swallowAdds = 1;
    const [entry] = pipe.finder.requestSearch(film.key);
    await until(() => stageOf(entry!) === 'downloading');
    expect(pipe.qbit.torrents.size).toBe(1);
    expect(pipe.qbit.calls.filter((c) => c.path === 'torrents/add')).toHaveLength(1);
  });

  it('waits for the client to list the torrent that it accepted', async () => {
    pipe = await startPipeline();
    const film = movie({ rootId: 'movie', manualRelease: true });
    pipe.db.data.titles[film.key] = film;
    const name = 'Movie.Name.2019.1080p.BluRay-GRP';
    pipe.tracker.state.items = [{ title: name, size: 100 * 120 * MIB }];
    pipe.qbit.control.listDelayMs = 30;
    const [entry] = pipe.finder.requestSearch(film.key);
    await until(() => stageOf(entry!) === 'downloading');
    expect(reasonOfEntry(entry!)).toBeNull();
    expect(branchOf(entry!)).toBeNull();
    expect(entry!.attempts).toHaveLength(1);
    // The try does not fail while the client lists the torrent.
    expect(entry!.history.filter((event) => event.cause === 'grab will be tried again')).toEqual([]);
    expect(pipe.qbit.calls.filter((c) => c.path === 'torrents/add')).toHaveLength(1);
  });

  it('never sends a release that fails before the add', async () => {
    pipe = await startPipeline();
    const film = movie({ rootId: 'movie', manualRelease: true });
    pipe.db.data.titles[film.key] = film;
    const bad = 'Movie.Name.2019.1080p.WEB-DL-BAD';
    const good = 'Movie.Name.2019.1080p.WEB-DL-GOOD';
    pipe.tracker.state.items = [{ title: bad, size: 100 * 60 * MIB, bad: true, seeders: 50 }, { title: good, size: 100 * 60 * MIB, seeders: 10 }];
    const [entry] = pipe.finder.requestSearch(film.key);
    await until(() => itemFor(entry!)?.state.kind === 'downloading');
    expect(pipe.tracker.state.downloads).toEqual([bad, good]);
    const first = entry!.history.filter((event) => event.attempt === 1).map((event) => event.stage);
    expect(first).toContain('fetching');
    expect(first).not.toContain('sending');
    expect(pipe.acquisition.filter(({ type }) => type === 'add')).toEqual([{ type: 'add', hash: hashOf(good) }]);
  });

  it('keeps the entry and its progress while the client is down, and does not blame the release', async () => {
    pipe = await startPipeline();
    const film = movie({ rootId: 'movie', manualRelease: true });
    pipe.db.data.titles[film.key] = film;
    const name = 'Movie.Name.2019.1080p.BluRay-GRP';
    pipe.tracker.state.items = [{ title: name, size: 100 * 120 * MIB }];
    const [entry] = pipe.finder.requestSearch(film.key);
    await until(() => stageOf(entry!) === 'downloading');
    pipe.qbit.progress(hashOf(name), 0.5);
    await until(() => pipe!.poller.transfer(hashOf(name))?.progress === 0.5);

    pipe.qbit.control.down = true;
    await until(() => pipe!.poller.status().state === 'unreachable');
    expect(pipe.poller.transfer(hashOf(name))).toMatchObject({ progress: 0.5, stale: true });
    expect(stageOf(entry!)).toBe('downloading');
    expect(branchOf(entry!)).toBeNull();

    pipe.qbit.control.down = false;
    pipe.qbit.progress(hashOf(name), 0.7);
    await until(() => pipe!.poller.transfer(hashOf(name))?.progress === 0.7);
    expect(pipe.poller.transfer(hashOf(name))!.stale).toBe(false);
  });

  it('records a failed indexer and still takes the result of a healthy one', async () => {
    pipe = await startPipeline();
    const film = movie({ rootId: 'movie', manualRelease: true });
    pipe.db.data.titles[film.key] = film;
    const second = pipe.db.data.indexers[1]!;
    pipe.db.data.indexers[2] = { ...structuredClone(second), id: 2, baseUrl: 'http://127.0.0.1:1/2/' };
    const name = 'Movie.Name.2019.1080p.BluRay-GRP';
    pipe.tracker.state.items = [{ title: name, size: 100 * 120 * MIB }];
    const [entry] = pipe.finder.requestSearch(film.key);
    await until(() => stageOf(entry!) === 'downloading');
    expect(entry!.search!.indexers.map((i) => i.state).sort()).toEqual(['done', 'failed']);
    expect(pipe.db.data.indexers[2]!.health.failures).toBe(1);
  });
});

describe('import safety', () => {
  const setup = async (options: Parameters<typeof startPipeline>[0] = {}) => {
    pipe = await startPipeline(options);
    const film = movie({ rootId: 'movie', manualRelease: true });
    pipe.db.data.titles[film.key] = film;
    const name = 'Movie.Name.2019.1080p.BluRay-GRP';
    pipe.tracker.state.items = [{ title: name, size: 100 * 120 * MIB }];
    const [entry] = pipe.finder.requestSearch(film.key);
    await until(() => stageOf(entry!) === 'downloading');
    return { film, name, entry: entry! };
  };

  const noLink = (code: string) => async (source: import('node:fs').PathLike, target: import('node:fs').PathLike) => {
    if (String(target).includes('.ladarr-')) throw Object.assign(new Error('no link'), { code });
    return link(source, target);
  };

  it('copies when a hard link is not possible, and leaves the source as it is', async () => {
    const { name, entry, film } = await setup({ fs: { link: noLink('EXDEV') } });
    pipe!.complete(name, { [`${name}.mkv`]: 'video-data' });
    await until(() => stageOf(entry) === 'available');
    const file = pipe!.db.data.files[pipe!.db.data.titles[film.key]!.fileId!]!;
    expect(entry.importResult).toMatchObject({ method: 'copy' });
    const source = join(pipe!.folders.downloads, name, `${name}.mkv`);
    expect(readFileSync(join(pipe!.folders.movies, file.path), 'utf8')).toBe('video-data');
    expect(readFileSync(source, 'utf8')).toBe('video-data');
    expect(statSync(source).ino).not.toBe(statSync(join(pipe!.folders.movies, file.path)).ino);
  });

  it.each([
    ['ENOSPC', 'disk_full'],
    ['EACCES', 'permission_denied'],
  ])('leaves the library as it is when the copy fails with %s', async (code, reason) => {
    const { name, entry } = await setup({
      fs: {
        link: noLink('EXDEV'),
        copyFile: async () => {
          throw Object.assign(new Error('copy'), { code });
        },
      },
    });
    pipe!.complete(name, { [`${name}.mkv`]: 'video-data' });
    await until(() => reasonOfEntry(entry)?.code === reason);
    expect(reasonOfEntry(entry)?.code).toBe(reason);
    expect(readdirSync(join(pipe!.folders.movies, 'Movie Name (2019)'))).toEqual([]);
    expect(Object.values(pipe!.db.data.files)).toHaveLength(0);
    expect(pipe!.db.data.imports).toEqual({});
    expect(readFileSync(join(pipe!.folders.downloads, name, `${name}.mkv`), 'utf8')).toBe('video-data');
  });

  it('does not replace a file that the library does not know', async () => {
    const { name, entry, film } = await setup();
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(join(pipe!.folders.movies, 'Movie Name (2019)'));
    writeFileSync(join(pipe!.folders.movies, 'Movie Name (2019)', 'Movie Name (2019).mkv'), 'someone else');
    pipe!.complete(name, { [`${name}.mkv`]: 'video-data' });
    await until(() => reasonOfEntry(entry)?.code === 'destination_exists');
    expect(reasonOfEntry(entry)?.code).toBe('destination_exists');
    expect(readFileSync(join(pipe!.folders.movies, 'Movie Name (2019)', 'Movie Name (2019).mkv'), 'utf8')).toBe('someone else');
    expect(pipe!.db.data.titles[film.key]!.fileId).toBeNull();
    expect(readdirSync(join(pipe!.folders.movies, 'Movie Name (2019)'))).toEqual(['Movie Name (2019).mkv']);
  });

  it('takes the destination when it is the same file as the download', async () => {
    const { name, entry, film } = await setup();
    // An import published the destination and stopped before it wrote the record of the file.
    const source = join(pipe!.folders.downloads, name, `${name}.mkv`);
    mkdirSync(dirname(source), { recursive: true });
    writeFileSync(source, 'video-data');
    const folder = join(pipe!.folders.movies, 'Movie Name (2019)');
    mkdirSync(folder, { recursive: true });
    await link(source, join(folder, 'Movie Name (2019).mkv'));
    pipe!.complete(name, { [`${name}.mkv`]: 'video-data' });

    await until(() => stageOf(entry) === 'available');
    const file = Object.values(pipe!.db.data.files)[0]!;
    expect(file.path).toBe('Movie Name (2019)/Movie Name (2019).mkv');
    expect(pipe!.db.data.titles[film.key]!.fileId).toBe(file.id);
    expect(statSync(join(pipe!.folders.movies, file.path)).ino).toBe(statSync(source).ino);
    expect(pipe!.db.data.imports).toEqual({});
  });

  it('keeps the file and the journal when a write fails after the file is published', async () => {
    // The write fails once, after the destination has its final name.
    let armed = false;
    const { name, entry, film } = await setup({
      afterStep: (state) => {
        if (state === 'staged') armed = true;
      },
      save: async () => {
        if (!armed) return;
        if (!existsSync(join(pipe!.folders.movies, 'Movie Name (2019)', 'Movie Name (2019).mkv'))) return;
        armed = false;
        throw new Error('the disk is full');
      },
    });
    pipe!.poller.stop();
    pipe!.complete(name, { [`${name}.mkv`]: 'video-data' });
    move(pipe!.queue, entry, { stage: 'importing', reason: null }, 'download complete');
    pipe!.worker.enqueue({ type: 'import.run', payload: { hash: hashOf(name) }, dedupeKey: `import:${hashOf(name)}` });

    // The next run of the import finishes the record. The file is not left without one.
    await until(() => stageOf(entry) === 'available', 15_000);
    const file = Object.values(pipe!.db.data.files)[0]!;
    expect(file.path).toBe('Movie Name (2019)/Movie Name (2019).mkv');
    expect(pipe!.db.data.titles[film.key]!.fileId).toBe(file.id);
    expect(readFileSync(join(pipe!.folders.movies, file.path), 'utf8')).toBe('video-data');
    expect(pipe!.db.data.imports).toEqual({});
  }, 20_000);

  it('blocks a file that ffprobe can not read', async () => {
    const { name, entry } = await setup({ probe: async () => ({ ok: false, reason: 'unreadable' }) });
    pipe!.complete(name, { [`${name}.mkv`]: 'broken' });
    await until(() => reasonOfEntry(entry)?.code === 'file_unreadable');
    expect(reasonOfEntry(entry)?.code).toBe('file_unreadable');
    expect(existsSync(join(pipe!.folders.movies, 'Movie Name (2019)'))).toBe(false);
  });

  it('imports only the files of the torrent when the content folder holds another series', async () => {
    pipe = await startPipeline();
    const series = title({ rootId: 'tv', episodes: [episode(1, 1, '2020-01-01'), episode(1, 2, '2020-01-02')] });
    pipe.db.data.titles[series.key] = series;
    const name = 'Show.Name.S01.1080p.WEB-DL-GRP';
    pipe.tracker.state.items = [{ title: name, size: 100 * 120 * MIB }];
    pipe.finder.requestSearch(series.key);
    await until(() => stageOf(pipe!.queue.get('tv:1:1x2')) === 'downloading');
    // The client created no folder for this torrent, so it reports the folder of every download as the content.
    const hash = hashOf(name);
    pipe.qbit.torrents.get(hash)!.content_path = pipe.folders.downloads;
    pipe.qbit.setFiles(hash, [
      { name: 'Show.Name.S01E01.mkv', size: 3, progress: 1 },
      { name: 'Show.Name.S01E02.mkv', size: 3, progress: 1 },
    ]);
    writeFileSync(join(pipe.folders.downloads, 'Show.Name.S01E01.mkv'), 'own one');
    writeFileSync(join(pipe.folders.downloads, 'Show.Name.S01E02.mkv'), 'own two');
    mkdirSync(join(pipe.folders.downloads, 'Other.Show'));
    // The files of the other series are larger, so a walk of the whole folder would take them.
    writeFileSync(join(pipe.folders.downloads, 'Other.Show', 'Show.Name.S01E01.mkv'), 'x'.repeat(50));
    writeFileSync(join(pipe.folders.downloads, 'Other.Show', 'Show.Name.S01E02.mkv'), 'x'.repeat(50));
    pipe.qbit.progress(hash, 1);
    await until(() => ['1x1', '1x2'].every((n) => stageOf(pipe!.queue.get(`tv:1:${n}`)) === 'available'), 15_000);
    const contents = Object.values(pipe!.db.data.files).map((file) => readFileSync(join(pipe!.folders.tv, file.path), 'utf8'));
    expect(contents.sort()).toEqual(['own one', 'own two']);
  }, 20_000);

  it('stays out of a download path that leads outside the download folder', async () => {
    const { name, entry } = await setup();
    pipe!.qbit.torrents.get(hashOf(name))!.content_path = '/etc';
    pipe!.complete(name, { [`${name}.mkv`]: 'x' });
    pipe!.qbit.torrents.get(hashOf(name))!.content_path = '/etc';
    await until(() => reasonOfEntry(entry)?.code === 'path_outside_downloads');
    expect(reasonOfEntry(entry)?.code).toBe('path_outside_downloads');
  });

  // Every step of the journal: stop the import after the step, start again, and check the result.
  it.each(['staged', 'published', 'committed'] as const)('finishes an import that stopped after %s', async (stopAfter) => {
    let armed = true;
    const { name, entry, film } = await setup({
      afterStep: (state) => {
        if (armed && state === stopAfter) {
          armed = false;
          throw new Error('stop');
        }
      },
    });
    pipe!.complete(name, { [`${name}.mkv`]: 'video-data' });
    // The job fails like a crash. A start of the server runs the import again for each unfinished download.
    await until(() => !armed);
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The journal is what remembers the work.
    expect(Object.keys(pipe!.db.data.imports)).toHaveLength(1);
    pipe!.worker.enqueue({ type: 'import.run', payload: { hash: hashOf(name) }, dedupeKey: `import:${hashOf(name)}` });
    await until(() => stageOf(entry) === 'available' && Object.keys(pipe!.db.data.imports).length === 0, 12_000);
    const file = pipe!.db.data.files[pipe!.db.data.titles[film.key]!.fileId!]!;
    expect(readFileSync(join(pipe!.folders.movies, file.path), 'utf8')).toBe('video-data');
    expect(Object.values(pipe!.db.data.files)).toHaveLength(1);
    expect(pipe!.db.data.imports).toEqual({});
    // No staged file stays in the folder.
    expect(readdirSync(join(pipe!.folders.movies, 'Movie Name (2019)'))).toEqual(['Movie Name (2019).mkv']);
    expect(lstatSync(join(pipe!.folders.downloads, name, `${name}.mkv`)).isFile()).toBe(true);
  }, 20_000);
});

describe('item logs', () => {
  it('tags each step of a movie journey with the item', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ladarr-pipe-steps-'));
    logToFile(join(dir, 'ladarr.log'));
    try {
      pipe = await startPipeline();
      const film = movie({ rootId: 'movie', manualRelease: true });
      pipe.db.data.titles[film.key] = film;
      const name = 'Movie.Name.2019.1080p.BluRay.x264-GRP';
      pipe.tracker.state.items = [{ title: name, size: 100 * 120 * MIB }];
      const [entry] = pipe.finder.requestSearch(film.key);
      await until(() => stageOf(entry!) === 'downloading');
      pipe.complete(name, { [`${name}.mkv`]: 'video-data' });
      await until(() => stageOf(entry!) === 'available');
      await closeLog();
      const lines = await recentLogs(200, { itemId: entry!.id, itemType: 'movie' });
      const events = lines.map((line) => line.event);
      expect(events).toEqual(
        expect.arrayContaining([
          'queued',
          'started',
          'moved',
          'search',
          'release_chosen',
          'download_started',
          'download_added',
          'download_completed',
          'import_started',
          'import_planned',
          'import_staged',
          'import_published',
          'import_committed',
          'import_retired',
          'import_completed',
        ]),
      );
      expect(lines.every((line) => line.type === 'catalog' && line.itemId === entry!.id && line.itemType === 'movie')).toBe(true);
      const chosen = lines.find((line) => line.event === 'release_chosen');
      expect(chosen).toMatchObject({ type: 'catalog', title: film.meta.title, target: 'Movie' });
      const attempt = lines.find((line) => line.event === 'started');
      expect(attempt?.message).toBe('Attempt 1 to find "Movie Name (2019)"');
      const indexed = lines.find((line) => line.event === 'search' && line.message.startsWith('Indexer returned')) as { message?: string; requestId?: unknown } | undefined;
      expect(indexed?.message).toBe('Indexer returned 1 release for "Movie Name"');
      expect(typeof indexed?.requestId).toBe('string');
      const requests = await recentLogs(200, { kind: 'requests', requestId: indexed!.requestId as string });
      expect(requests.some((entry) => entry.message === 'outbound request')).toBe(true);
    } finally {
      await closeLog();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('says what the search found and why each release did not match', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ladarr-pipe-reasons-'));
    logToFile(join(dir, 'ladarr.log'));
    try {
      pipe = await startPipeline();
      const film = movie({ rootId: 'movie', manualRelease: true });
      pipe.db.data.titles[film.key] = film;
      pipe.tracker.state.items = [
        { title: 'Movie.Name.2019.720p.WEB-DL-GRP', size: 30 * 60 * MIB },
        { title: 'Other.Movie.2019.1080p.WEB-DL-GRP', size: 60 * 100 * MIB },
      ];
      const [entry] = pipe.finder.requestSearch(film.key);
      await until(() => reasonOfEntry(entry!)?.code === 'all_rejected');
      await until(() => !Object.values(pipe!.db.data.jobs).some((job) => job.type === 'queue.search'));
      await closeLog();
      const lines = await recentLogs(200, { itemId: entry!.id, itemType: 'movie' });
      const finished = lines.find((line) => line.event === 'finished');
      expect(finished).toMatchObject({ type: 'catalog' });
      expect((finished as { message: string }).message).toBe('No release selected: 2 releases, all rejected');
      const fields = finished as unknown as {
        result: string;
        profiles: { name: string; qualities: string[] }[];
        reasons: { code: string; text: string; count: number }[];
        candidates: { title: string; quality: string; reasons: { code: string; detail?: string }[] }[];
      };
      expect(fields.result).toBe('all_rejected');
      expect(fields.profiles.some((profile) => profile.qualities.includes('WEB-DL 1080p'))).toBe(true);
      expect(fields.reasons.map((reason) => reason.code)).toContain('quality_not_in_profile');
      expect(fields.reasons.every((reason) => reason.text.length > 0)).toBe(true);
      const lowQuality = fields.candidates.find((candidate) => candidate.reasons.some((reason) => reason.code === 'quality_not_in_profile'));
      expect(lowQuality).toMatchObject({ quality: 'WEB-DL 720p' });
      expect(lowQuality!.reasons.find((reason) => reason.code === 'quality_not_in_profile')!.detail).toContain('WEB-DL 1080p');
      const otherTitle = fields.candidates.find((candidate) => candidate.reasons.some((reason) => reason.code === 'wrong_title'));
      expect(otherTitle!.reasons.find((reason) => reason.code === 'wrong_title')!.detail).toContain('Other Movie');
    } finally {
      await closeLog();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('tags the log of a failed grab with the item', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ladarr-pipe-logs-'));
    logToFile(join(dir, 'ladarr.log'));
    try {
      pipe = await startPipeline();
      pipe.qbit.control.failAdds = true;
      const film = movie({ rootId: 'movie', manualRelease: true });
      pipe.db.data.titles[film.key] = film;
      pipe.tracker.state.items = [{ title: 'Movie.Name.2019.1080p.BluRay-GRP', size: 100 * 120 * MIB }];
      const [entry] = pipe.finder.requestSearch(film.key);
      await until(() => entry!.history.some((event) => event.cause === 'send will be tried again'));
    expect(itemFor(entry!)?.state.kind).toBe('fetching');
      expect(reasonOfEntry(entry!)).toBeNull();
      await closeLog();
      const entries = await recentLogs(200, { itemId: entry!.id, itemType: 'movie' });
      expect(entries.map((line) => line.event)).toContain('download_failed');
      expect(entries.every((line) => line.type === 'catalog' && line.itemId === entry!.id && line.itemType === 'movie')).toBe(true);
    } finally {
      await closeLog();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('paused queue', () => {
  it('adds the target to the queue, and searches only after the resume', async () => {
    pipe = await startPipeline({ handlers: ({ db, queue, finder }) => ({ 'queue.initial': queueInitialHandler({ queue, finder }) }) });
    const film = movie({ rootId: 'movie', manualRelease: true });
    pipe.db.data.titles[film.key] = film;
    pipe.tracker.state.items = [{ title: 'Movie.Name.2019.1080p.BluRay-GRP', size: 100 * 120 * MIB }];

    pipe.queue.setPaused(true);
    pipe.worker.enqueue({ type: 'queue.initial', payload: { key: film.key }, dedupeKey: `initial:${film.key}` });

    // The row exists while the queue is paused, and no search goes out.
    await until(() => pipe!.db.data.queue[film.key]?.attempt === 1);
    expect(pipe.db.data.queue[film.key]).toMatchObject({ state: { kind: 'queued' } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(pipe.tracker.state.searches).toEqual([]);

    pipe.queue.setPaused(false);
    await until(() => pipe!.tracker.state.searches.length > 0);
  }, 20_000);
});
