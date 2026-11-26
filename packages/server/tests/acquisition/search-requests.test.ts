import { stageOf, reasonOfEntry } from '../../src/library/downloads/queue.ts';
import { branchOf } from '../helpers/test-queue.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeLog, logToFile, recentLogs } from '../../src/core/log.ts';
import { episode, title } from '../helpers/test-fixtures.ts';
import { MIB, startPipeline, until } from '../helpers/test-pipeline.ts';
import type { QueueEntry } from '../../src/types.ts';

let pipe: Awaited<ReturnType<typeof startPipeline>> | undefined;
let api: Awaited<ReturnType<Awaited<ReturnType<typeof startPipeline>>['api']>> | undefined;
afterEach(async () => {
  api?.close();
  await pipe?.stop();
  pipe = api = undefined;
});

const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60_000).toISOString().slice(0, 10);
const queries = () => pipe!.tracker.state.searches.filter((url) => url.searchParams.get('t') !== 'caps');
const seasonQueries = () => queries().filter((url) => url.searchParams.get('ep') === null);
const episodeQueries = () => queries().filter((url) => url.searchParams.get('ep') !== null);
const grabbed = (entry: QueueEntry) => stageOf(entry) === 'fetching' || stageOf(entry) === 'sending' || stageOf(entry) === 'downloading';
const named = (extra: Parameters<typeof title>[0] = {}) =>
  title({ rootId: 'tv', meta: { ...title().meta, title: 'Show Name', originalTitle: 'Original Show Name', aliases: ['Alias One', 'Alias Two', 'Alias Three'] }, ...extra });

describe('search requests', () => {
  it('takes the single releases from the season answer without individual queries', async () => {
    pipe = await startPipeline();
    const series = title({ rootId: 'tv', episodes: [1, 2, 3].map((number) => episode(1, number, '2020-01-01')) });
    pipe.db.data.titles[series.key] = series;
    const singles = [1, 2, 3].map((number) => ({ title: `Show.Name.S01E0${number}.1080p.WEB-DL-GRP`, size: 60 * 45 * MIB }));
    pipe.tracker.state.items = [
      { title: 'Show.Name.S01.480p.WEB-DL-GRP', size: 3 * 30 * 45 * MIB },
      { title: 'Show.Name.S01.720p.WEB-DL-GRP', size: 3 * 40 * 45 * MIB },
      ...singles,
    ];

    pipe.finder.requestSearch(series.key);
    await expect.poll(() => pipe!.acquisition.filter((event) => event.type === 'add')).toHaveLength(3);

    expect(seasonQueries()).toHaveLength(1);
    expect(episodeQueries()).toHaveLength(0);
    expect(pipe.tracker.state.downloads.toSorted()).toEqual(singles.map((item) => item.title));
  });

  it('shows the rejected season releases in the title log and in each episode log', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ladarr-season-log-'));
    logToFile(join(dir, 'ladarr.log'));
    try {
      pipe = await startPipeline();
      const series = title({ rootId: 'tv', episodes: [1, 2, 3].map((number) => episode(1, number, '2020-01-01')) });
      pipe.db.data.titles[series.key] = series;
      pipe.tracker.state.items = [
        { title: 'Show.Name.S01.480p.WEB-DL-GRP', size: 3 * 30 * 45 * MIB },
        { title: 'Show.Name.S01.720p.WEB-DL-GRP', size: 3 * 40 * 45 * MIB },
      ];

      const entries = pipe.finder.requestSearch(series.key);
      await until(() => entries.every((entry) => reasonOfEntry(entry)?.code === 'all_rejected'));
      expect(seasonQueries()).toHaveLength(1);

      await closeLog();
      const titleLog = await recentLogs(200, { itemId: series.key });
      const season = titleLog.find((line) => line.event === 'search' && line.message.startsWith('Search season "Show Name"'))!;
      expect(season).toMatchObject({ releases: 2, accepted: 0 });
      expect(JSON.stringify(season)).toMatch(/quality_not_in_profile|not in the quality profile|quality outside the profile/i);

      for (const entry of entries) {
        const lines = await recentLogs(200, { itemId: entry.id });
        const own = lines.find((line) => line.event === 'search' && line.message.startsWith('Search season "Show Name"'));
        expect(own).toMatchObject({ releases: 2, accepted: 0 });
      }
    } finally {
      await closeLog();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('names an alias query in the log and shows the alias that it used', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ladarr-alias-log-'));
    logToFile(join(dir, 'ladarr.log'));
    try {
      pipe = await startPipeline();
      const series = named({
        episodes: [episode(1, 1, '2020-01-01'), episode(1, 2, '2020-01-01')],
        meta: { ...title().meta, title: 'Show Name', originalTitle: 'Original Show Name', aliases: ['Alias One', 'Alias Two', 'Alias Three'], aliasRegions: { 'Alias One': ['FR'], 'Alias Two': ['TH'] } },
      });
      pipe.db.data.titles[series.key] = series;

      const entries = pipe.finder.requestSearch(series.key);
      await until(() => entries.every((entry) => branchOf(entry) === 'waiting'));

      await closeLog();
      const titleLines = (await recentLogs(200, { itemId: series.key })).filter((line) => line.event === 'search');
      expect(titleLines.filter((line) => line.message.startsWith('Search season'))).toHaveLength(2);
      expect(titleLines.filter((line) => line.message.startsWith('Search alias'))).toHaveLength(3);
      expect(titleLines.map((line) => line.message)).toEqual(
        expect.arrayContaining([
          'Search season "Show Name": 0 results found, 0 matched quality',
          'Search alias "Alias One": 0 results found, 0 matched quality',
          'Search alias "Alias Two": 0 results found, 0 matched quality',
          'Search alias "Alias Three": 0 results found, 0 matched quality',
        ]),
      );
      expect(titleLines.find((line) => line.message.startsWith('Search alias "Alias One"'))).toMatchObject({ name: 'Alias One', source: 'season', languages: ['fr'] });
      expect(titleLines.find((line) => line.message.startsWith('Search alias "Alias Two"'))).toMatchObject({ languages: ['th'] });
      expect(titleLines.find((line) => line.message.startsWith('Search alias "Alias Three"'))).toMatchObject({ languages: [] });
      expect(titleLines.find((line) => line.message.startsWith('Search season "Original Show Name"'))).not.toHaveProperty('languages');
      expect(titleLines.find((line) => line.message.startsWith('Search season "Show Name"'))).not.toHaveProperty('languages');

      const own = (await recentLogs(200, { itemId: entries[0]!.id })).filter((line) => line.event === 'search');
      expect(own.map((line) => line.message)).toEqual(
        expect.arrayContaining([
          'Search season "Show Name" for S01E01: 0 results found, 0 matched quality',
          'Search alias "Alias One" for S01E01: 0 results found, 0 matched quality',
        ]),
      );
    } finally {
      await closeLog();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses 26 requests for a recent season with 5 names and 21 episodes', async () => {
    pipe = await startPipeline();
    const recent = daysAgo(1);
    const series = named({ episodes: Array.from({ length: 21 }, (_, index) => episode(1, index + 1, recent)) });
    pipe.db.data.titles[series.key] = series;
    pipe.tracker.state.items = [];

    const entries = pipe.finder.requestSearch(series.key);
    await until(
      () => entries.every((entry) => branchOf(entry) === 'waiting' && entry.search !== null && entry.search.result !== null && entry.search.result !== 'deferred'),
      20_000,
    );

    expect(queries()).toHaveLength(26);
    expect(seasonQueries()).toHaveLength(5);
    const individual = episodeQueries();
    expect(individual).toHaveLength(21);
    expect(individual.every((url) => url.searchParams.get('q') === 'Show Name')).toBe(true);
  });

  it('asks every season name before it searches old episodes individually', async () => {
    pipe = await startPipeline();
    const series = named({ episodes: [episode(1, 1, '2020-01-01'), episode(1, 2, '2020-01-01')] });
    pipe.db.data.titles[series.key] = series;
    pipe.tracker.state.items = [];

    const entries = pipe.finder.requestSearch(series.key);
    await until(() => entries.every((entry) => branchOf(entry) === 'waiting'));

    expect(seasonQueries().map((url) => url.searchParams.get('q')).sort()).toEqual(['Alias One', 'Alias Three', 'Alias Two', 'Original Show Name', 'Show Name']);
    expect(queries().slice(0, 5)).toEqual(seasonQueries());
    expect(episodeQueries().map((url) => Number(url.searchParams.get('ep'))).sort()).toEqual([1, 2]);
  });

  it('stops the season search at the first name that returns releases, even when none matches the profile', async () => {
    pipe = await startPipeline();
    const series = named({ episodes: [episode(1, 1, '2020-01-01'), episode(1, 2, '2020-01-01')] });
    pipe.db.data.titles[series.key] = series;
    pipe.tracker.state.answer = (url) => url.searchParams.has('ep') ? [] : [{ title: 'Show.Name.S01.480p.WEB-DL-GRP', size: 2 * 30 * 45 * MIB }];

    const entries = pipe.finder.requestSearch(series.key);
    await until(() => entries.every((entry) => reasonOfEntry(entry)?.code === 'all_rejected'));

    expect(seasonQueries()).toHaveLength(1);
    expect(seasonQueries()[0]!.searchParams.get('q')).toBe('Show Name');
    expect(episodeQueries().map((url) => Number(url.searchParams.get('ep'))).sort()).toEqual([1, 2]);
    expect(entries.every((entry) => entry.release === null && reasonOfEntry(entry)?.code === 'all_rejected')).toBe(true);
  });

  it('takes a full pack for the episodes that the library does not have', async () => {
    pipe = await startPipeline();
    const series = title({
      rootId: 'tv',
      episodes: [
        episode(1, 1, '2020-01-01', { fileId: 'e1' }),
        episode(1, 2, '2020-01-02', { fileId: 'e2' }),
        episode(1, 3, '2020-01-03'),
        episode(1, 4, daysAgo(1)),
        episode(1, 5, '2020-01-05'),
      ],
    });
    pipe.db.data.titles[series.key] = series;
    const file = (number: number) => ({ id: `e${number}`, titleKey: series.key, path: `Show Name (2020)/Season 01/Show Name - S01E0${number}.mkv`, sizeBytes: 1, mtimeMs: 1, episodes: [{ season: 1, number }], missing: false, addedAt: 1, source: 'webdl' as const });
    pipe.db.data.files.e1 = file(1);
    pipe.db.data.files.e2 = file(2);
    const pack = 'Show.Name.S01.1080p.WEB-DL-GRP';
    const single = 'Show.Name.S01E04.1080p.WEB-DL-GRP';
    const files = [1, 2, 3, 4, 5].map((number) => `Show.Name.S01E0${number}.mkv`);
    pipe.tracker.state.answer = (url) => (url.searchParams.get('ep') === '4' ? [{ title: single, size: 60 * 45 * MIB }] : [{ title: pack, size: 5 * 60 * 45 * MIB, files }]);

    pipe.finder.requestSearch(series.key);
    const third = pipe.queue.get('tv:1:1x3')!;
    const fourth = pipe.queue.get('tv:1:1x4')!;
    const fifth = pipe.queue.get('tv:1:1x5')!;
    await until(() => [third, fourth, fifth].every((entry) => stageOf(entry) === 'downloading'));
    // The pack covers every episode without a file, so the three take it and no episode query runs.
    expect([third, fourth, fifth].map((entry) => entry.release!.title)).toEqual([pack, pack, pack]);
    expect(episodeQueries()).toEqual([]);
    expect(pipe.qbit.torrents.size).toBe(1);
    expect(series.episodes.slice(0, 2).map(({ fileId }) => fileId)).toEqual(['e1', 'e2']);
  });

  it('searches the last old episode on its own after the season answer settles the others', async () => {
    pipe = await startPipeline();
    const series = title({ rootId: 'tv', episodes: [episode(1, 1, '2020-01-01'), episode(1, 2, '2020-01-01')] });
    pipe.db.data.titles[series.key] = series;
    const fromSeason = 'Show.Name.S01E01.1080p.WEB-DL-GRP';
    const fromEpisode = 'Show.Name.S01E02.1080p.WEB-DL-GRP';
    pipe.tracker.state.answer = (url) => {
      const ep = url.searchParams.get('ep');
      if (ep === null) return [{ title: fromSeason, size: 60 * 45 * MIB }];
      if (ep === '2') return [{ title: fromEpisode, size: 60 * 45 * MIB }];
      return [];
    };

    pipe.finder.requestSearch(series.key);
    const first = pipe.queue.get('tv:1:1x1')!;
    const second = pipe.queue.get('tv:1:1x2')!;
    await until(() => grabbed(first) && grabbed(second));

    expect(seasonQueries()).toHaveLength(1);
    expect(episodeQueries()).toHaveLength(1);
    expect(episodeQueries()[0]!.searchParams.get('ep')).toBe('2');
    expect(first.release!.title).toBe(fromSeason);
    expect(second.release!.title).toBe(fromEpisode);
  });

  it('sends the individual query for a manual search of an old episode', async () => {
    pipe = await startPipeline();
    api = await pipe.api();
    const series = title({ rootId: 'tv', episodes: [episode(1, 1, '2020-01-01'), episode(1, 2, '2020-01-02')] });
    pipe.db.data.titles[series.key] = series;
    pipe.tracker.state.items = [{ title: 'Show.Name.S01E01.1080p.WEB-DL-GRP', size: 60 * 45 * MIB }];

    const response = await api.post('/queue/search', { titleKey: series.key, season: 1, number: 1 });
    expect(response.status).toBe(202);
    const entry = pipe.queue.get('tv:1:1x1')!;
    await until(() => grabbed(entry));

    expect(episodeQueries().filter((url) => url.searchParams.get('ep') === '1')).toHaveLength(1);
    expect(seasonQueries()).toHaveLength(0);
  });

  it('stops the manual episode search at the first name that returns releases, even when none matches the profile', async () => {
    pipe = await startPipeline();
    api = await pipe.api();
    const series = named({ episodes: [episode(1, 1, '2020-01-01'), episode(1, 2, '2020-01-02')] });
    pipe.db.data.titles[series.key] = series;
    pipe.tracker.state.answer = (url) => {
      const name = url.searchParams.get('q');
      if (name === 'Show Name') return [{ title: 'Show.Name.S01E01.480p.WEB-DL-GRP', size: 60 * 30 * MIB }];
      if (name === 'Alias One') return [{ title: 'Alias.One.S01E01.1080p.WEB-DL-GRP', size: 60 * 45 * MIB }];
      return [];
    };

    expect((await api.post('/queue/search', { titleKey: series.key, season: 1, number: 1 })).status).toBe(202);
    const entry = pipe.queue.get('tv:1:1x1')!;
    await until(() => reasonOfEntry(entry)?.code === 'all_rejected');
    expect(entry.state.kind).toBe('blocked');
    expect(episodeQueries().map((url) => url.searchParams.get('q'))).toEqual(['Show Name']);
    expect(entry.release).toBeNull();
    expect(reasonOfEntry(entry)?.code).toBe('all_rejected');
  });

  it('makes individual queries for recent and old episodes when the season answer is empty', async () => {
    pipe = await startPipeline();
    const series = title({ rootId: 'tv', episodes: [episode(1, 1, daysAgo(2)), episode(1, 2, daysAgo(8))] });
    pipe.db.data.titles[series.key] = series;
    pipe.tracker.state.items = [];

    const entries = pipe.finder.requestSearch(series.key);
    await until(() => entries.every((entry) => branchOf(entry) === 'waiting'));

    expect(seasonQueries()).toHaveLength(1);
    expect(episodeQueries().filter((url) => url.searchParams.get('ep') === '1')).toHaveLength(1);
    expect(episodeQueries().filter((url) => url.searchParams.get('ep') === '2')).toHaveLength(1);
  });
});
