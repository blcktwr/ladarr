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
afterEach(async () => {
  await pipe?.stop();
  pipe = undefined;
});

const stagesOf = (entry: { history: { stage: string; branch: string | null }[] }) => entry.history.map((event) => (event.branch ? `${event.stage}/${event.branch}` : event.stage)).filter((stage, i, all) => stage !== all[i - 1]);

describe('movie journey', () => {
  it('goes from a search to a file in the library, and keeps the seeding source', async () => {
    pipe = await startPipeline();
    const film = movie({ rootId: 'movie', meta: { ...movie().meta, releaseDates: [{ region: 'US', kind: 'digital', date: '2019-06-01' }] } });
    pipe.db.data.titles[film.key] = film;
    const name = 'Movie.Name.2019.1080p.BluRay.x264-GRP';
    pipe.tracker.state.items = [
      { title: 'Movie.Name.2019.CAM-BAD', size: 800 * MIB },
      { title: name, size: 100 * 120 * MIB },
    ];

    const [entry] = pipe.finder.requestSearch(film.key);
    expect(entry!.id).toBe('movie:2');
    await until(() => entry!.stage === 'downloading');
    expect(entry!.release).toMatchObject({ title: name, kind: 'single' });
    expect(entry!.transferHash).toBe(hashOf(name));
    expect(pipe.qbit.torrents.get(hashOf(name))).toMatchObject({ tags: '', save_path: pipe.folders.downloads });

    pipe.complete(name, { [`${name}.mkv`]: 'video-data', 'Sample/sample.mkv': 'x', 'info.nfo': 'n' });
    await until(() => entry!.stage === 'available');

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
    expect(stagesOf(entry!)).toEqual(['queued', 'searching', 'fetching', 'sending', 'downloading', 'validating', 'importing', 'available']);
    expect(pipe.qbit.torrents.has(hashOf(name))).toBe(true);
  });

  it('waits for a release when nothing is eligible, and says why', async () => {
    pipe = await startPipeline();
    const film = movie({ rootId: 'movie', manualRelease: true });
    pipe.db.data.titles[film.key] = film;
    pipe.tracker.state.items = [{ title: 'Movie.Name.2018.1080p.BluRay-GRP', size: 100 * 120 * MIB }, { title: 'Movie.Name.2019.CAM-GRP', size: 500 * MIB }];
    const [entry] = pipe.finder.requestSearch(film.key);
    await until(() => entry!.branch === 'waiting');
    expect(entry!.stage).toBe('queued');
    expect(entry!.reason?.code).toBe('all_rejected');
    expect(entry!.search).toMatchObject({ result: 'all_rejected', candidates: 2, accepted: 0, indexers: [{ state: 'done', count: 2 }] });
    expect(entry!.search!.nextAt).toBeGreaterThan(Date.now());
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
  const film = () => movie({ rootId: 'movie', meta: { ...movie().meta, releaseDates: [{ region: 'US', kind: 'digital', date: '2019-06-01' }] } });

  it('keeps the comment of the torrent file', async () => {
    pipe = await startPipeline();
    const item = film();
    pipe.db.data.titles[item.key] = item;
    pipe.tracker.state.items = [{ title: 'Movie.Name.2019.1080p.BluRay-GRP', size: 100 * 120 * MIB, comment }];

    const [entry] = pipe.finder.requestSearch(item.key);
    await until(() => entry!.stage === 'downloading');
    expect(entry!.release?.comment).toBe(comment);
  });

  it('has no comment when the release comes without one', async () => {
    pipe = await startPipeline();
    const item = film();
    pipe.db.data.titles[item.key] = item;
    pipe.tracker.state.items = [{ title: 'Movie.Name.2019.1080p.BluRay-GRP', size: 100 * 120 * MIB }];

    const [entry] = pipe.finder.requestSearch(item.key);
    await until(() => entry!.stage === 'downloading');
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
    pipe.tracker.state.items = [
      { title: pack, size: 3 * 60 * 45 * MIB },
      { title: 'Show.Name.S01E01.1080p.WEB-DL-GRP', size: 60 * 45 * MIB },
    ];
    const entries = pipe.finder.requestSearch(series.key);
    expect(entries.map((e) => e.id)).toEqual(['tv:1:1x1', 'tv:1:1x2', 'tv:1:1x3']);
    await until(() => entries.every((e) => e.stage === 'downloading'));
    expect(pipe.qbit.torrents.size).toBe(1);
    expect(new Set(entries.map((e) => e.transferHash))).toEqual(new Set([hashOf(pack)]));
    // One query for the whole season, not one for each episode.
    expect(pipe.tracker.state.searches.filter((u) => u.searchParams.get('t') === 'tvsearch')).toHaveLength(1);
    expect(pipe.tracker.state.searches[0]!.searchParams.get('ep')).toBeNull();

    // The pack has episode 3 under another name that the library can not match.
    pipe.complete(pack, { 'Show.Name.S01E01.mkv': 'one', 'Show.Name.S01E02.mkv': 'two', 'extras/Show.Name.S01E03.mkv': 'three-data' });
    await until(() => entries.every((e) => e.stage === 'available'));
    const paths = Object.values(pipe.db.data.files).map((f) => f.path).sort();
    expect(paths).toEqual(['Show Name (2020)/Season 01/Show Name - S01E01 - Episode 1.mkv', 'Show Name (2020)/Season 01/Show Name - S01E02 - Episode 2.mkv', 'Show Name (2020)/Season 01/Show Name - S01E03 - Episode 3.mkv']);
    expect(series.episodes.every((e) => e.fileId)).toBe(true);
  });

  it('maps the numbers of a relative season pack to the numbers of the title', async () => {
    pipe = await startPipeline();
    const series = title({ rootId: 'tv', episodes: [episode(2, 33, '2020-01-01'), episode(2, 34, '2020-01-02'), episode(2, 35, '2020-01-03')] });
    pipe.db.data.titles[series.key] = series;
    const pack = 'Show.Name.S02.1080p.WEB-DL.GRP';
    const files = ['Show.Name.S02E01.mkv', 'Show.Name.S02E02.mkv', 'Show.Name.S02E03.mkv'];
    pipe.tracker.state.items = [{ title: pack, size: 3 * 60 * 45 * MIB, files }];
    const entries = pipe.finder.requestSearch(series.key);
    await until(() => entries.every((e) => e.stage === 'downloading'));
    expect(pipe.qbit.torrents.size).toBe(1);
    expect(pipe.db.data.blocklist).toEqual({});

    pipe.complete(pack, { 'Show.Name.S02E01.mkv': 'one', 'Show.Name.S02E02.mkv': 'two', 'Show.Name.S02E03.mkv': 'three' }, hashOf(pack, files));
    await until(() => entries.every((e) => e.stage === 'available'));
    const paths = Object.values(pipe.db.data.files).map((f) => f.path).sort();
    expect(paths).toEqual(['Show Name (2020)/Season 02/Show Name - S02E33 - Episode 33.mkv', 'Show Name (2020)/Season 02/Show Name - S02E34 - Episode 34.mkv', 'Show Name (2020)/Season 02/Show Name - S02E35 - Episode 35.mkv']);
    expect(series.episodes.every((e) => e.fileId)).toBe(true);
  });

  it('links every query of a series to one request per indexer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ladarr-pipe-requests-'));
    logToFile(join(dir, 'ladarr.log'));
    try {
      pipe = await startPipeline();
      const series = title({ rootId: 'tv', episodes: [aired(1), aired(2), aired(3)], meta: { ...title().meta, aliases: ['Show Alias'] } });
      pipe.db.data.titles[series.key] = series;
      pipe.tracker.state.items = [];
      const entries = pipe.finder.requestSearch(series.key);
      await until(() => entries.every((entry) => entry.stage === 'queued' && entry.branch === 'waiting'));
      // The two names of the title are two queries to the same indexer.
      expect(pipe.tracker.state.searches.filter((url) => url.searchParams.get('t') === 'tvsearch')).toHaveLength(2);
      await closeLog();

      const lines = (await recentLogs(500)).filter((line) => line.itemType === 'tv' && String(line.itemId ?? '').startsWith('tv:1'));
      const requests = lines.flatMap((line) => (Array.isArray(line.requests) ? (line.requests as { indexer?: string; system?: string; requestId?: string }[]) : []));
      expect(requests.length).toBeGreaterThan(1);
      // A log line shows one button per indexer, not one for each query of the same indexer.
      expect(new Set(requests.map((item) => item.requestId)).size).toBe(1);
    } finally {
      await closeLog();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('shows a partial pack: the others available, and the missing episode searched again', async () => {
    pipe = await startPipeline();
    const series = show();
    pipe.db.data.titles[series.key] = series;
    const pack = 'Show.Name.S01.1080p.WEB-DL-GRP';
    pipe.tracker.state.items = [{ title: pack, size: 3 * 60 * 45 * MIB }];
    const entries = pipe.finder.requestSearch(series.key);
    await until(() => entries.every((e) => e.stage === 'downloading'));
    // The new search of the missing episode finds nothing.
    pipe.tracker.state.items = [];
    pipe.complete(pack, { 'Show.Name.S01E01.mkv': 'one', 'Show.Name.S01E03.mkv': 'three' });
    await until(() => entries.filter((e) => e.stage === 'available').length === 2 && entries[1]!.transferHash === null && entries[1]!.reason === null);
    expect(entries.map((e) => e.stage)).toEqual(['available', 'queued', 'available']);
    // The missing episode is not blocked: the import queues the search that covers it.
    expect(entries[1]).toMatchObject({ branch: null, transferHash: null });
    expect(Object.values(pipe.db.data.jobs).some((job) => job.type === 'queue.initial' && job.dedupeKey === `initial:${series.key}`)).toBe(true);
  });

  it('searches an episode on its own when no pack fits, and takes a fallback after a bad file', async () => {
    pipe = await startPipeline();
    const series = title({ rootId: 'tv', episodes: [aired(1)] });
    pipe.db.data.titles[series.key] = series;
    const bad = 'Show.Name.S01E01.1080p.WEB-DL-AAA';
    const good = 'Show.Name.S01E01.1080p.WEBRip-BBB';
    pipe.tracker.state.items = [{ title: bad, size: 60 * 45 * MIB }, { title: good, size: 55 * 45 * MIB }];
    const [entry] = pipe.finder.requestSearch(series.key);
    await until(() => entry!.stage === 'downloading');
    // The best release is the WEB-DL.
    expect(entry!.release!.title).toBe(bad);
    expect(pipe.tracker.state.searches[0]!.searchParams.get('ep')).toBe('1');

    // The client reports a fault: this is a problem of the client, not a bad release, so the release stays out of the blocklist.
    pipe.qbit.progress(hashOf(bad), 0.4, 'missingFiles');
    await until(() => entry!.reason?.code === 'client_error');
    expect(entry!.reason).toMatchObject({ code: 'client_error' });
    expect(pipe.db.data.blocklist).toEqual({});
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
    await until(() => entry.stage === 'downloading');
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
    await until(() => entry!.stage === 'downloading');
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
    await until(() => entry!.stage === 'downloading');
    expect(entry!.reason).toBeNull();
    expect(entry!.branch).toBeNull();
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
    const good = 'Movie.Name.2019.1080p.BluRay-GRP';
    pipe.tracker.state.items = [{ title: bad, size: 100 * 60 * MIB, bad: true }, { title: good, size: 100 * 120 * MIB }];
    const [entry] = pipe.finder.requestSearch(film.key);
    await until(() => entry!.stage === 'downloading');
    expect(entry!.release!.title).toBe(good);

    // The bad release fails while ladarr reads it. That attempt stops in fetching, before any request to the client.
    const first = entry!.history.filter((event) => event.attempt === 1).map((event) => event.stage);
    expect(first).toContain('fetching');
    expect(first).not.toContain('sending');
    // Only the good release goes to the client.
    expect(pipe.qbit.calls.filter((call) => call.path === 'torrents/add')).toHaveLength(1);
  });

  it('keeps the entry and its progress while the client is down, and does not blame the release', async () => {
    pipe = await startPipeline();
    const film = movie({ rootId: 'movie', manualRelease: true });
    pipe.db.data.titles[film.key] = film;
    const name = 'Movie.Name.2019.1080p.BluRay-GRP';
    pipe.tracker.state.items = [{ title: name, size: 100 * 120 * MIB }];
    const [entry] = pipe.finder.requestSearch(film.key);
    await until(() => entry!.stage === 'downloading');
    pipe.qbit.progress(hashOf(name), 0.5);
    await until(() => pipe!.poller.transfer(hashOf(name))?.progress === 0.5);

    pipe.qbit.control.down = true;
    await until(() => pipe!.poller.status().state === 'unreachable');
    expect(pipe.poller.transfer(hashOf(name))).toMatchObject({ progress: 0.5, stale: true });
    expect(entry!.stage).toBe('downloading');
    expect(entry!.branch).toBeNull();
    expect(pipe.db.data.blocklist).toEqual({});

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
    await until(() => entry!.stage === 'downloading');
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
    await until(() => entry!.stage === 'downloading');
    return { film, name, entry: entry! };
  };

  const noLink = (code: string) => async (source: import('node:fs').PathLike, target: import('node:fs').PathLike) => {
    if (String(target).includes('.ladarr-')) throw Object.assign(new Error('no link'), { code });
    return link(source, target);
  };

  it('copies when a hard link is not possible, and leaves the source as it is', async () => {
    const { name, entry, film } = await setup({ fs: { link: noLink('EXDEV') } });
    pipe!.complete(name, { [`${name}.mkv`]: 'video-data' });
    await until(() => entry.stage === 'available');
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
    await until(() => entry.reason?.code === reason);
    expect(entry.reason?.code).toBe(reason);
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
    await until(() => entry.reason?.code === 'destination_exists');
    expect(entry.reason?.code).toBe('destination_exists');
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

    await until(() => entry.stage === 'available');
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
    pipe!.queue.move(entry, { stage: 'validating', reason: null }, 'download complete');
    pipe!.worker.enqueue({ type: 'import.run', payload: { hash: hashOf(name) }, dedupeKey: `import:${hashOf(name)}` });

    // The next run of the import finishes the record. The file is not left without one.
    await until(() => entry.stage === 'available', 15_000);
    const file = Object.values(pipe!.db.data.files)[0]!;
    expect(file.path).toBe('Movie Name (2019)/Movie Name (2019).mkv');
    expect(pipe!.db.data.titles[film.key]!.fileId).toBe(file.id);
    expect(readFileSync(join(pipe!.folders.movies, file.path), 'utf8')).toBe('video-data');
    expect(pipe!.db.data.imports).toEqual({});
  }, 20_000);

  it('blocks a file that ffprobe can not read', async () => {
    const { name, entry } = await setup({ probe: async () => ({ ok: false, reason: 'unreadable' }) });
    pipe!.complete(name, { [`${name}.mkv`]: 'broken' });
    await until(() => entry.reason?.code === 'file_unreadable');
    expect(entry.reason?.code).toBe('file_unreadable');
    expect(existsSync(join(pipe!.folders.movies, 'Movie Name (2019)'))).toBe(false);
  });

  it('stays out of a download path that leads outside the download folder', async () => {
    const { name, entry } = await setup();
    pipe!.qbit.torrents.get(hashOf(name))!.content_path = '/etc';
    pipe!.complete(name, { [`${name}.mkv`]: 'x' });
    pipe!.qbit.torrents.get(hashOf(name))!.content_path = '/etc';
    await until(() => entry.reason?.code === 'path_outside_downloads');
    expect(entry.reason?.code).toBe('path_outside_downloads');
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
    await until(() => entry.stage === 'available' && Object.keys(pipe!.db.data.imports).length === 0, 12_000);
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
      await until(() => entry!.stage === 'downloading');
      pipe.complete(name, { [`${name}.mkv`]: 'video-data' });
      await until(() => entry!.stage === 'available');
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
      await until(() => entry!.reason?.code === 'all_rejected');
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
      await until(() => entry!.reason?.code === 'grab_failed');
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
    expect(pipe.db.data.queue[film.key]).toMatchObject({ stage: 'queued', branch: null });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(pipe.tracker.state.searches).toEqual([]);

    pipe.queue.setPaused(false);
    await until(() => pipe!.tracker.state.searches.length > 0);
  }, 20_000);
});
