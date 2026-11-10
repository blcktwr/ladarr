import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Title } from '../../src/library/library.ts';
import { episode, indexer as indexerFixture, movie, title } from '../helpers/test-fixtures.ts';
import { BULK_SEARCH_JOB } from '../../src/library/calendar/calendar-search.ts';
import { librarySearchHandler } from '../../src/jobs/library-search.ts';
import { closeLog, logToFile, recentLogs } from '../../src/core/log.ts';
import { enqueue } from '../../src/core/jobs.ts';
import { hashOf, MIB, startPipeline, until } from '../helpers/test-pipeline.ts';

let pipe: Awaited<ReturnType<typeof startPipeline>> | undefined;
let api: Awaited<ReturnType<Awaited<ReturnType<typeof startPipeline>>['api']>> | undefined;
afterEach(async () => {
  api?.close();
  await pipe?.stop();
  pipe = api = undefined;
});

const signal = () => AbortSignal.timeout(5_000);
const queries = () => pipe!.tracker.state.searches.filter((u) => u.searchParams.get('t') !== 'caps');
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60_000).toISOString().slice(0, 10);

// A library with one movie and its file, as if an earlier import or a scan had made them.
async function libraryWithFile(source: 'webdl' | 'webrip' | 'bluray' | 'hdtv' | 'unknown', options: Parameters<typeof startPipeline>[0] = {}, resolution = 1080) {
  pipe = await startPipeline(options);
  const film = movie({ rootId: 'movie', manualRelease: true, folder: 'Movie Name (2019)', fileId: 'old' });
  const path = 'Movie Name (2019)/Movie Name (2019).mkv';
  mkdirSync(join(pipe.folders.movies, 'Movie Name (2019)'));
  writeFileSync(join(pipe.folders.movies, path), 'old-data');
  pipe.db.data.titles[film.key] = film;
  pipe.db.data.files.old = { id: 'old', titleKey: film.key, path, sizeBytes: 8, mtimeMs: 1, episodes: [], missing: false, addedAt: 1, source, resolution };
  return { film, path };
}

const WEBDL = 'Movie.Name.2019.1080p.WEB-DL-GRP';
const webdlSize = 60 * 100 * MIB;

describe('upgrades', () => {
  it('does not replace a file when RSS finds a better release', async () => {
    const { film } = await libraryWithFile('bluray');
    pipe!.tracker.state.items = [{ title: WEBDL, size: webdlSize }];
    await pipe!.finder.rss(signal());
    await wait(100);
    expect(pipe!.queue.get(film.key)).toBeUndefined();
    expect(pipe!.tracker.state.downloads).toEqual([]);
  });

  it('previews the files below the chosen resolution, and starts the search', async () => {
    // The file is 720p, so the 1080p release is the chosen upgrade.
    const { film } = await libraryWithFile('webdl', { handlers: ({ db, finder }) => ({ [BULK_SEARCH_JOB]: librarySearchHandler({ db, finder, enqueue: (input) => enqueue(input) }) }) }, 720);
    pipe!.tracker.state.items = [{ title: WEBDL, size: webdlSize }];
    api = await pipe!.api();

    // A plan for missing files finds nothing: the movie has a file.
    expect((await api.post('/library/search/preview', { kind: 'search', keys: [film.key] })).body).toMatchObject({ planId: null });
    const plan = (await api.post('/library/search/preview', { kind: 'upgrades', keys: [film.key], resolution: 1080 })).body;
    expect(plan).toMatchObject({ titles: 1, targets: 1 });
    expect((await api.post('/library/search', { planId: plan.planId })).status).toBe(202);
    const job = Object.values(pipe!.db.data.jobs).find((item) => item.type === BULK_SEARCH_JOB)!;
    expect(job.payload).toMatchObject({ kind: 'upgrades', resolution: 1080 });
    expect(job.payload).not.toHaveProperty('manual');
    await until(() => pipe!.queue.get(film.key)?.stage === 'downloading');
    expect(pipe!.queue.get(film.key)!.attempts[0]!.reason).toBe('upgrade search');
    expect(pipe!.tracker.state.downloads).toEqual([WEBDL]);
  });

  it.each([{}, { resolution: null }, { resolution: '1080' }, { resolution: 1080.5 }])('refuses the resolution %j', async (resolution) => {
    const { film } = await libraryWithFile('webdl');
    api = await pipe!.api();
    const res = await api.post('/library/search/preview', { kind: 'upgrades', keys: [film.key], ...resolution });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_resolution' });
  });

  it('answers 409 when no requested title can reach the resolution', async () => {
    const { film } = await libraryWithFile('webdl', {}, 2160);
    api = await pipe!.api();
    const res = await api.post('/library/search/preview', { kind: 'upgrades', keys: [film.key], resolution: 2160 });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'no_better_qualities' });
  });

  it('refuses the upgrades filter that the library had before', async () => {
    await libraryWithFile('webdl', {}, 720);
    api = await pipe!.api();
    const res = await api.post('/library/search/preview', { kind: 'upgrades', filter: 'upgrades', resolution: 1080 });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_filter' });
  });

  it.each([
    ['higher', 'Movie.Name.2019.2160p.WEB-DL-GRP', 100 * 150 * MIB],
    ['lower', 'Movie.Name.2019.480p.WEB-DL-GRP', 100 * 30 * MIB],
  ])('does not take a %s resolution than the chosen one', async (_name, name, size) => {
    const { film } = await libraryWithFile('webdl', { handlers: ({ db, finder }) => ({ [BULK_SEARCH_JOB]: librarySearchHandler({ db, finder, enqueue: (input) => enqueue(input) }) }) }, 720);
    // The chain takes every WEB-DL resolution, so the release has a known quality.
    pipe!.db.data.profiles = { p: { id: 'p', name: 'All', items: [['webdl-2160'], ['webdl-1080'], ['webdl-720'], ['webdl-480']] } };
    pipe!.db.data.profileOrder = ['p'];
    pipe!.tracker.state.items = [{ title: name, size }];
    api = await pipe!.api();

    const plan = (await api.post('/library/search/preview', { kind: 'upgrades', keys: [film.key], resolution: 1080 })).body;
    expect(plan).toMatchObject({ titles: 1, targets: 1 });
    expect((await api.post('/library/search', { planId: plan.planId })).status).toBe(202);
    await wait(150);
    expect(pipe!.queue.get(film.key)).toBeUndefined();
    expect(pipe!.tracker.state.downloads).toEqual([]);
  });

  it('gives the resolutions that the title can upgrade to', async () => {
    const { film } = await libraryWithFile('webdl', {}, 720);
    api = await pipe!.api();
    expect((await api.get(`/library/${film.key}/upgrades`)).body).toEqual({ resolutions: [1080, 2160] });
    expect((await api.get('/library/movie:99/upgrades')).status).toBe(404);
  });

  it('refuses the upgrades filter of the library', async () => {
    await libraryWithFile('webdl');
    api = await pipe!.api();
    const res = await api.get('/library?filter=upgrades');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_filter' });
  });
});

describe('queries for aliases', () => {
  const NAME = 'Third.Alias.Name.2019.1080p.BluRay-GRP';
  const aliased = (aliases: string[]): Title => movie({ rootId: 'movie', manualRelease: true, meta: { ...movie().meta, aliases } });
  const aliases = ['Le Nom du Film', 'Film Alias Two', 'Third Alias Name', 'Fourth Alias Name', 'XY', 'Мой фильм'];
  const asked = () => queries().map((u) => u.searchParams.get('q'));

  it('asks for the aliases one by one only when the names before gave nothing, and takes the release of an alias', async () => {
    pipe = await startPipeline();
    const film = aliased(aliases);
    pipe.db.data.titles[film.key] = film;
    pipe.tracker.state.answer = (url) => (url.searchParams.get('q') === 'Third Alias Name' ? [{ title: NAME, size: 100 * 120 * MIB }] : []);
    const [entry] = pipe.finder.requestSearch(film.key);
    await until(() => entry!.stage === 'downloading');
    // The title and the original title are the same name. Then two aliases give nothing, and the third gives the release.
    expect(asked()).toEqual(['Movie Name', 'Le Nom du Film', 'Film Alias Two', 'Third Alias Name']);
    expect(entry!.release!.title).toBe(NAME);
  });

  it('tries every alias until one returns a result, and skips a name that is too short or in another script', async () => {
    pipe = await startPipeline();
    const film = aliased(['XY', 'Мой фильм', 'Alias One', 'Alias Two', 'Alias Three', 'Alias Four', 'Alias Five', 'Alias Six']);
    pipe.db.data.titles[film.key] = film;
    pipe.tracker.state.answer = (url) => (url.searchParams.get('q') === 'Alias Five' ? [{ title: 'Alias.Five.2019.1080p.BluRay-GRP', size: 100 * 120 * MIB }] : []);
    const [entry] = pipe.finder.requestSearch(film.key);
    await until(() => entry!.stage === 'downloading' || entry!.branch === 'waiting');
    expect(asked()).toEqual(['Movie Name', 'Alias One', 'Alias Two', 'Alias Three', 'Alias Four', 'Alias Five']);
    expect(entry!.release?.title).toBe('Alias.Five.2019.1080p.BluRay-GRP');
  });

  it('stops at the name that returns releases, even when the quality profile rejects all of them', async () => {
    pipe = await startPipeline();
    const film = aliased(['Alias Better']);
    pipe.db.data.titles[film.key] = film;
    pipe.tracker.state.answer = (url) => {
      const name = url.searchParams.get('q');
      if (name === 'Movie Name') return [{ title: 'Movie.Name.2019.480p.WEB-DL-GRP', size: 100 * 30 * MIB }];
      if (name === 'Alias Better') return [{ title: 'Alias.Better.2019.1080p.BluRay-GRP', size: 100 * 120 * MIB }];
      return [];
    };
    const [entry] = pipe.finder.requestSearch(film.key);
    await until(() => entry!.branch === 'waiting' || entry!.stage === 'downloading');
    expect(entry!.branch).toBe('waiting');
    expect(asked()).toEqual(['Movie Name']);
    expect(entry!.release).toBeNull();
    expect(entry!.reason).toMatchObject({ code: 'all_rejected' });
  });

  it('does not ask for an alias when the title gave a release', async () => {
    pipe = await startPipeline();
    const film = aliased(aliases);
    pipe.db.data.titles[film.key] = film;
    pipe.tracker.state.items = [{ title: 'Movie.Name.2019.1080p.BluRay-GRP', size: 100 * 120 * MIB }];
    const [entry] = pipe.finder.requestSearch(film.key);
    await until(() => entry!.stage === 'downloading');
    expect(asked()).toEqual(['Movie Name']);
  });

  it('shows the releases of an alias in the interactive search', async () => {
    pipe = await startPipeline();
    api = await pipe.api();
    const film = aliased(aliases);
    pipe.db.data.titles[film.key] = film;
    pipe.tracker.state.answer = (url) => (url.searchParams.get('q') === 'Film Alias Two' ? [{ title: 'Film.Alias.Two.2019.1080p.BluRay-GRP', size: 100 * 120 * MIB }] : []);
    const { body } = await api.get(`/queue/releases?titleKey=${film.key}`);
    expect(body.releases.map((r: { title: string }) => r.title)).toEqual(['Film.Alias.Two.2019.1080p.BluRay-GRP']);
    expect(asked()).toEqual(['Movie Name', 'Le Nom du Film', 'Film Alias Two']);
  });
});

describe('the languages of the aliases', () => {
  it('writes the language of each alias in the search log', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ladarr-language-log-'));
    logToFile(join(dir, 'ladarr.log'));
    try {
      pipe = await startPipeline();
      const film = movie({
        rootId: 'movie',
        manualRelease: true,
        meta: { ...movie().meta, title: 'English Name', originalTitle: 'Japanese Original', originalLanguage: 'ja', aliases: ['Alias ES'], aliasRegions: { 'Alias ES': ['ES'] } },
      });
      pipe.db.data.titles[film.key] = film;
      pipe.tracker.state.answer = (url) => (url.searchParams.get('q') === 'Alias ES' ? [{ title: 'Alias.ES.2019.1080p.BluRay-GRP', size: 100 * 120 * MIB }] : []);

      const [entry] = pipe.finder.requestSearch(film.key);
      await until(() => entry!.release !== null);

      await closeLog();
      const lines = (await recentLogs(200, { itemId: entry!.id })).filter((line) => line.event === 'search');
      expect(lines.find((line) => line.scope === '"English Name"')).not.toHaveProperty('languages');
      expect(lines.find((line) => line.scope === '"Japanese Original"')).not.toHaveProperty('languages');
      expect(lines.find((line) => line.scope === '"Alias ES"')).toMatchObject({ languages: ['es'] });
    } finally {
      await closeLog();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the languages of the indexers', () => {
  const film = () =>
    movie({
      rootId: 'movie',
      manualRelease: true,
      meta: {
        ...movie().meta,
        title: 'English Name',
        originalTitle: 'Japanese Original',
        originalLanguage: 'ja',
        aliases: ['Alias ES', 'Alias Unknown'],
        aliasRegions: { 'Alias ES': ['ES'] },
      },
    });
  const names = (key: string) => queries().filter((url) => url.searchParams.get('apikey') === key).map((url) => url.searchParams.get('q'));

  const search = async (first: string[], second: string[]) => {
    pipe = await startPipeline();
    pipe.db.data.indexers[1]!.preferredLanguages = first;
    pipe.db.data.indexers[2] = indexerFixture({ id: 2, baseUrl: pipe.db.data.indexers[1]!.baseUrl, apiKey: 'ja-key', preferredLanguages: second });
    const movieTitle = film();
    pipe.db.data.titles[movieTitle.key] = movieTitle;
    pipe.tracker.state.items = [];
    const [entry] = pipe.finder.requestSearch(movieTitle.key);
    await until(() => entry!.branch === 'waiting');
    return entry!;
  };

  it('sends only an alias to the indexers that take its language', async () => {
    const entry = await search(['es'], ['ja']);
    expect(names('key')).toEqual(['English Name', 'Japanese Original', 'Alias ES', 'Alias Unknown']);
    expect(names('ja-key')).toEqual(['English Name', 'Japanese Original', 'Alias Unknown']);
    // A query that an indexer does not receive is not a failure or a skip of the search.
    expect(entry.search!.indexers).toHaveLength(2);
    expect(entry.search!.indexers.every((indexer) => indexer.state === 'done')).toBe(true);
  });

  it('sends every name to an indexer with no preferred language', async () => {
    await search([], ['ja']);
    expect(names('key')).toEqual(['English Name', 'Japanese Original', 'Alias ES', 'Alias Unknown']);
  });

  it('sends the original title to every indexer', async () => {
    pipe = await startPipeline();
    pipe.db.data.indexers[1]!.preferredLanguages = ['es'];
    pipe.db.data.indexers[2] = indexerFixture({ id: 2, baseUrl: pipe.db.data.indexers[1]!.baseUrl, apiKey: 'ja-key', preferredLanguages: ['ja'] });
    const movieTitle = movie({ rootId: 'movie', manualRelease: true, meta: { ...movie().meta, title: 'English Name', originalTitle: 'Unknown Original', originalLanguage: '', aliases: [] } });
    pipe.db.data.titles[movieTitle.key] = movieTitle;
    pipe.tracker.state.items = [];
    const [entry] = pipe.finder.requestSearch(movieTitle.key);
    await until(() => entry!.branch === 'waiting');
    expect(names('key')).toEqual(['English Name', 'Unknown Original']);
    expect(names('ja-key')).toEqual(['English Name', 'Unknown Original']);
  });

  it('does not report an indexer as skipped when a language leaves it out of later names', async () => {
    pipe = await startPipeline();
    pipe.db.data.indexers[1]!.preferredLanguages = ['es'];
    pipe.db.data.indexers[2] = indexerFixture({ id: 2, baseUrl: pipe.db.data.indexers[1]!.baseUrl, apiKey: 'ja-key', preferredLanguages: ['ja'] });
    const movieTitle = movie({ rootId: 'movie', manualRelease: true, meta: { ...movie().meta, title: 'English Name', originalTitle: 'Japanese Original', originalLanguage: 'ja', aliases: ['Alias JA'], aliasRegions: { 'Alias JA': ['JP'] } } });
    pipe.db.data.titles[movieTitle.key] = movieTitle;
    pipe.tracker.state.items = [];
    const [entry] = pipe.finder.requestSearch(movieTitle.key);
    await until(() => entry!.branch === 'waiting');
    expect(names('key')).toEqual(['English Name', 'Japanese Original']);
    expect(entry!.search!.indexers.find((indexer) => indexer.id === 1)).toMatchObject({ state: 'done' });
  });
});

describe('the log of a series', () => {
  it('writes a final series line when every target of the run ends', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ladarr-series-log-'));
    logToFile(join(dir, 'ladarr.log'));
    try {
      pipe = await startPipeline();
      const series = title({ rootId: 'tv', episodes: [episode(1, 1, '2020-01-01'), episode(1, 2, '2020-01-02')] });
      pipe.db.data.titles[series.key] = series;
      pipe.tracker.state.items = [];
      const entries = pipe.finder.requestSearch(series.key);
      await until(() => entries.every((entry) => entry.branch === 'waiting'));
      await closeLog();

      const last = (await recentLogs(100, { itemId: series.key, itemType: 'tv' })).at(-1);
      expect(last).toMatchObject({ event: 'finished', target: 'Series', scope: 'series', targets: 2, accepted: 0, waiting: 2 });
      expect(last?.message).toContain('Series search finished');
    } finally {
      await closeLog();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the content of a pack', () => {
  const PACK = 'Show.Name.S01.1080p.WEB-DL-GRP';
  const season = () => title({ rootId: 'tv', episodes: [1, 2, 3].map((n) => episode(1, n, `2020-01-0${n}`)) });
  const packSize = 3 * 60 * 45 * MIB;

  it('takes a pack that holds every episode, and skips the sample and the other files', async () => {
    pipe = await startPipeline();
    const series = season();
    pipe.db.data.titles[series.key] = series;
    const files = [`${PACK}/Show.Name.S01E01.mkv`, `${PACK}/Show.Name.S01E02.mkv`, `${PACK}/Show.Name.S01E03.mkv`, `${PACK}/Sample/sample.mkv`, `${PACK}/info.nfo`];
    pipe.tracker.state.items = [{ title: PACK, size: packSize, files: files.map((file) => file.slice(PACK.length + 1)) }];
    const entries = pipe.finder.requestSearch(series.key);
    await until(() => entries.every((e) => e.stage === 'downloading'));
    expect(pipe.qbit.torrents.size).toBe(1);
    expect(pipe.db.data.blocklist).toEqual({});
  });

  it('keeps the pack for the episodes that it holds, and searches the missing episode on its own', async () => {
    pipe = await startPipeline();
    const series = season();
    pipe.db.data.titles[series.key] = series;
    const files = ['Show.Name.S01E01.mkv', 'Show.Name.S01E02.mkv', 'info.nfo'];
    const single = 'Show.Name.S01E03.1080p.WEB-DL-SGL';
    pipe.tracker.state.items = [{ title: PACK, size: packSize, files }, { title: single, size: 60 * 45 * MIB }];
    const entries = pipe.finder.requestSearch(series.key);
    await until(() => entries.every((e) => e.stage === 'downloading'));

    expect(entries[0]!.transferHash).toBe(hashOf(PACK, files));
    expect(entries[1]!.transferHash).toBe(hashOf(PACK, files));
    expect(entries[2]!.release!.title).toBe(single);
    expect(pipe.qbit.torrents.size).toBe(2);
    // The pack stays out of later searches, and the blocklist says why.
    expect(Object.values(pipe.db.data.blocklist)).toMatchObject([{ title: PACK, reason: 'pack_missing_episodes', season: 1 }]);
    expect(entries[2]!.attempts.map((a) => [a.n, a.outcome, a.reason])).toEqual([[1, 'failed', 'search requested'], [2, 'running', 'fallback: pack_missing_episodes']]);
    expect(entries[0]!.attempts).toHaveLength(1);
  });

  it('blocks a pack that holds none of its episodes, before the client gets any data', async () => {
    pipe = await startPipeline();
    const series = season();
    pipe.db.data.titles[series.key] = series;
    pipe.tracker.state.items = [{ title: PACK, size: packSize, files: ['Show.Name.S01.part1.rar', 'Show.Name.S01.part2.rar'] }];
    const entries = pipe.finder.requestSearch(series.key);
    await until(() => entries.every((e) => e.branch === 'waiting'));
    expect(pipe.qbit.torrents.size).toBe(0);
    expect(pipe.qbit.calls.filter((c) => c.path === 'torrents/add')).toEqual([]);
    expect(Object.values(pipe.db.data.blocklist)).toMatchObject([{ title: PACK, reason: 'pack_missing_episodes', season: 1 }]);
  });

  it('does not check a torrent that has one file', async () => {
    pipe = await startPipeline();
    const series = season();
    pipe.db.data.titles[series.key] = series;
    pipe.tracker.state.items = [{ title: PACK, size: packSize }];
    const entries = pipe.finder.requestSearch(series.key);
    await until(() => entries.every((e) => e.stage === 'downloading'));
    expect(pipe.db.data.blocklist).toEqual({});
  });
});

describe('the pace of the indexer', () => {
  it('spaces every request of a season search by the delay, and asks once for each episode', async () => {
    pipe = await startPipeline({ indexer: { delaySeconds: 0.12 } });
    const recent = daysAgo(1);
    const series = title({ rootId: 'tv', episodes: [1, 2, 3].map((n) => episode(1, n, recent)).concat([1, 2, 3].map((n) => episode(2, n, recent))) });
    pipe.db.data.titles[series.key] = series;
    // The fake tracker keeps the time of each request that arrives, so the test measures the pace of the requests.
    const starts: { at: number; season: string | null; ep: string | null }[] = [];
    const push = pipe.tracker.state.searches.push.bind(pipe.tracker.state.searches);
    pipe.tracker.state.searches.push = (url: URL) => {
      starts.push({ at: Date.now(), season: url.searchParams.get('season'), ep: url.searchParams.get('ep') });
      return push(url);
    };

    const entries = pipe.finder.requestSearch(series.key);
    await until(() => entries.every((entry) => entry.branch === 'waiting'), 20_000);

    // Two seasons: one query for the season, and one for each episode that the season query did not settle.
    expect(starts).toHaveLength(8);
    expect(starts.filter((item) => item.ep === null).map((item) => item.season).sort()).toEqual(['1', '2']);
    expect(starts.filter((item) => item.ep !== null)).toHaveLength(6);
    // The delay holds for the series, also with two season searches at the same time.
    for (let i = 1; i < starts.length; i++) expect(starts[i]!.at - starts[i - 1]!.at).toBeGreaterThanOrEqual(100);
  });
});

describe('what the indexer manager pushes with an indexer', () => {
  const NAME = 'Movie.Name.2019.1080p.BluRay-GRP';
  const film = () => movie({ rootId: 'movie', manualRelease: true });
  const addBody = () => JSON.parse(pipe!.qbit.calls.find((c) => c.path === 'torrents/add')!.body!);

  it('gives the seed criteria of the indexer to the client with the torrent', async () => {
    pipe = await startPipeline();
    pipe.db.data.indexers[1]!.push.radarr!.fields = { 'seedCriteria.seedRatio': 1.5, 'seedCriteria.seedTime': 1440 };
    pipe.db.data.titles[film().key] = film();
    pipe.tracker.state.items = [{ title: NAME, size: 100 * 120 * MIB }];
    const [entry] = pipe.finder.requestSearch('movie:2');
    await until(() => entry!.stage === 'downloading');
    expect(entry!.release!.seed).toEqual({ ratio: 1.5, minutes: 1440 });
    expect(addBody()).toMatchObject({ ratioLimit: '1.5', seedingTimeLimit: '1440' });
  });

  it('uses the season pack time for a pack', async () => {
    pipe = await startPipeline();
    pipe.db.data.indexers[1]!.push.sonarr!.fields = { 'seedCriteria.seedTime': 60, 'seedCriteria.seasonPackSeedTime': 4320 };
    const series = title({ rootId: 'tv', episodes: [1, 2].map((n) => episode(1, n, `2020-01-0${n}`)) });
    pipe.db.data.titles[series.key] = series;
    pipe.tracker.state.items = [{ title: 'Show.Name.S01.1080p.WEB-DL-GRP', size: 2 * 60 * 45 * MIB }];
    const entries = pipe.finder.requestSearch(series.key);
    await until(() => entries.every((e) => e.stage === 'downloading'));
    expect(addBody()).toMatchObject({ seedingTimeLimit: '4320' });
    expect(addBody().ratioLimit).toBeUndefined();
  });

  it('sets no limit when the indexer asks for none', async () => {
    pipe = await startPipeline();
    pipe.db.data.titles[film().key] = film();
    pipe.tracker.state.items = [{ title: NAME, size: 100 * 120 * MIB }];
    const [entry] = pipe.finder.requestSearch('movie:2');
    await until(() => entry!.stage === 'downloading');
    expect(entry!.release!.seed).toBeNull();
    expect(addBody().ratioLimit).toBeUndefined();
    expect(addBody().seedingTimeLimit).toBeUndefined();
  });

  it.each([
    ['tags', (push: { tags: number[]; downloadClientId?: number | null }) => (push.tags = [3])],
    ['a download client that ladarr does not have', (push: { tags: number[]; downloadClientId?: number | null }) => (push.downloadClientId = 9)],
  ])('does not search or read the RSS feed of an indexer with %s', async (_name, change) => {
    pipe = await startPipeline();
    for (const push of Object.values(pipe.db.data.indexers[1]!.push)) change(push);
    pipe.db.data.titles[film().key] = film();
    pipe.tracker.state.items = [{ title: NAME, size: 100 * 120 * MIB }];
    await pipe.finder.rss(signal());
    expect(pipe.queue.get('movie:2')).toBeUndefined();
    const [entry] = pipe.finder.requestSearch('movie:2');
    await until(() => entry!.reason?.code === 'no_indexers' && entry!.stage === 'queued');
    expect(entry!.reason!.code).toBe('no_indexers');
    expect(pipe.tracker.state.searches).toHaveLength(0);
  });

  it('goes on when the user adds the indexer that was missing', async () => {
    pipe = await startPipeline();
    delete pipe.db.data.indexers[1];
    pipe.db.data.titles[film().key] = film();
    pipe.tracker.state.items = [{ title: NAME, size: 100 * 120 * MIB }];
    const [entry] = pipe.finder.requestSearch('movie:2');
    await until(() => entry!.reason?.code === 'no_indexers');
    const api = await pipe.api();
    try {
      const added = await api.post('/indexers', { name: 'Tracker', type: 'torznab', baseUrl: `http://127.0.0.1:${pipe.tracker.port}/1/`, apiKey: 'indexer-key', delaySeconds: 0 });
      expect(added.status).toBe(201);
      await until(() => entry!.stage === 'downloading');
      expect(entry!.reason).toBeNull();
      expect(pipe.published.some((event) => event.type === 'indexers.changed')).toBe(true);
    } finally {
      api.close();
    }
  });

  it('does not use a Usenet indexer', async () => {
    pipe = await startPipeline();
    pipe.db.data.indexers[1]!.protocol = 'usenet';
    pipe.db.data.titles[film().key] = film();
    pipe.tracker.state.items = [{ title: NAME, size: 100 * 120 * MIB }];
    await pipe.finder.rss(signal());
    const [entry] = pipe.finder.requestSearch('movie:2');
    await until(() => entry!.reason !== null);
    expect(pipe.tracker.state.searches).toHaveLength(0);
    expect(pipe.qbit.torrents.size).toBe(0);
  });
});

describe('a chain of quality profiles', () => {
  it('takes a 480p release in the second profile when the first profile takes only 1080p', async () => {
    pipe = await startPipeline();
    const series = title({ rootId: 'tv', episodes: [episode(1, 1, '2020-01-01')] });
    pipe.db.data.titles[series.key] = series;
    pipe.db.data.profiles.p480 = { id: 'p480', name: '480p', items: [['webdl-480'], ['webrip-480'], ['bluray-480']] };
    pipe.db.data.profileOrder = ['p1080', 'p480'];
    const releaseName = 'Show.Name.S01E01.480p.WEB-DL-GRP';
    pipe.tracker.state.items = [{ title: releaseName, size: 30 * 45 * MIB }];

    const [entry] = pipe.finder.requestSearch(series.key);
    await until(() => entry!.stage === 'downloading');
    expect(entry!.release!.title).toBe(releaseName);
  });
});
