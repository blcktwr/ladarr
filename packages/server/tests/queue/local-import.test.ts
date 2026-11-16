import { linkSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { episode, title } from '../helpers/test-fixtures.ts';
import { hashOf, startPipeline, until } from '../helpers/test-pipeline.ts';
import { reasonOfEntry, stageOf } from '../../src/library/downloads/queue.ts';
import { scanTitle } from '../../src/library/scan.ts';

let pipe: Awaited<ReturnType<typeof startPipeline>> | undefined;
afterEach(async () => {
  await pipe?.stop();
  pipe = undefined;
});

const MIB = 1024 * 1024;

// The target of a season reads its folder before it asks the indexers. A series that is on the disk is imported from
// that folder: it never downloads again.
describe('a series that is in its folder', () => {
  it('goes from searching to available with no search and no download', async () => {
    const seen: string[] = [];
    pipe = await startPipeline({ onState: (entry) => seen.push(`${entry.id}:${entry.state.kind}`) });
    const series = title({ rootId: 'tv', folder: 'Show Name (2020)', episodes: [episode(1, 1), episode(1, 2)] });
    pipe.db.data.titles[series.key] = series;
    const folder = join(pipe.folders.tv, 'Show Name (2020)', 'Season 01');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'Show Name - S01E01.mkv'), 'episode-one');
    writeFileSync(join(folder, 'Show Name - S01E02.mkv'), 'episode-two');

    pipe.finder.requestSearch('tv:1');

    const first = pipe.queue.get('tv:1:1x1')!;
    const second = pipe.queue.get('tv:1:1x2')!;
    await until(() => stageOf(first) === 'available' && stageOf(second) === 'available', 10_000);

    expect(reasonOfEntry(first)).toBeNull();
    expect(reasonOfEntry(second)).toBeNull();
    // The import is the step between the search and the library.
    expect(seen).toContain('tv:1:1x1:importing');
    // Nothing reached the indexers or the client.
    expect(pipe.tracker.state.searches).toEqual([]);
    expect(pipe.tracker.state.downloads).toEqual([]);
    expect(pipe.qbit.torrents.size).toBe(0);
    expect(first.attempts.at(-1)?.outcome).toBe('imported');
    expect(first.importResult).toMatchObject({ ok: true, path: 'Show Name (2020)/Season 01/Show Name - S01E01.mkv' });

    const files = Object.values(pipe.db.data.files);
    expect(files.map((file) => file.path).sort()).toEqual(['Show Name (2020)/Season 01/Show Name - S01E01.mkv', 'Show Name (2020)/Season 01/Show Name - S01E02.mkv']);
    expect(files.every((file) => !file.missing)).toBe(true);
    expect(files.find((file) => file.path.endsWith('S01E01.mkv'))?.episodes).toEqual([{ season: 1, number: 1 }]);
    expect(series.episodes.map((item) => item.fileId)).not.toContain(null);
  });

  it('reads the folder of the title name when the title has none yet', async () => {
    pipe = await startPipeline();
    const series = title({ rootId: 'tv', folder: null, episodes: [episode(1, 1)] });
    pipe.db.data.titles[series.key] = series;
    const folder = join(pipe.folders.tv, 'Show Name (2020)', 'Season 01');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'Show Name - S01E01.mkv'), 'episode-one');

    pipe.finder.requestSearch('tv:1');

    const entry = pipe.queue.get('tv:1:1x1')!;
    await until(() => stageOf(entry) === 'available', 10_000);
    expect(pipe.tracker.state.searches).toEqual([]);
    expect(Object.values(pipe.db.data.files).map((file) => file.path)).toEqual(['Show Name (2020)/Season 01/Show Name - S01E01.mkv']);
  });

  it('keeps one file record for a file that covers two episodes', async () => {
    pipe = await startPipeline();
    const series = title({ rootId: 'tv', folder: 'Show Name (2020)', episodes: [episode(1, 1), episode(1, 2)] });
    pipe.db.data.titles[series.key] = series;
    const folder = join(pipe.folders.tv, 'Show Name (2020)', 'Season 01');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'Show Name - S01E01E02.mkv'), 'both-episodes');

    pipe.finder.requestSearch('tv:1');

    const first = pipe.queue.get('tv:1:1x1')!;
    const second = pipe.queue.get('tv:1:1x2')!;
    await until(() => stageOf(first) === 'available' && stageOf(second) === 'available', 10_000);
    const files = Object.values(pipe.db.data.files);
    expect(files).toHaveLength(1);
    expect(files[0]!.episodes).toEqual([
      { season: 1, number: 1 },
      { season: 1, number: 2 },
    ]);
    expect(first.importResult?.path).toBe(second.importResult?.path);
  });

  it('searches only the episodes that the folder does not hold', async () => {
    pipe = await startPipeline();
    const series = title({ rootId: 'tv', folder: 'Show Name (2020)', episodes: [episode(1, 1), episode(1, 2), episode(1, 3)] });
    pipe.db.data.titles[series.key] = series;
    const folder = join(pipe.folders.tv, 'Show Name (2020)', 'Season 01');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'Show Name - S01E01.mkv'), 'episode-one');
    writeFileSync(join(folder, 'Show Name - S01E02.mkv'), 'episode-two');
    pipe.tracker.state.items = [{ title: 'Show.Name.S01E03.1080p.WEB-DL-GRP', size: 60 * 45 * MIB }];

    pipe.finder.requestSearch('tv:1');

    const first = pipe.queue.get('tv:1:1x1')!;
    const second = pipe.queue.get('tv:1:1x2')!;
    const third = pipe.queue.get('tv:1:1x3')!;
    await until(() => stageOf(first) === 'available' && stageOf(second) === 'available' && stageOf(third) === 'downloading', 15_000);
    // The two episodes of the folder never reached the indexers, and the third took its release.
    expect(pipe.tracker.state.downloads).toHaveLength(1);
    expect(pipe.tracker.state.downloads[0]).toContain('S01E03');
  });

  it('stops the episodes that its folder can hold and shows them for a manual match', async () => {
    pipe = await startPipeline();
    const api = await pipe.api();
    const series = title({ rootId: 'tv', folder: 'Show Name (2020)', episodes: [episode(1, 1), episode(1, 2)] });
    pipe.db.data.titles[series.key] = series;
    const folder = join(pipe.folders.tv, 'Show Name (2020)', 'Season 01');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'Clip A.mkv'), 'episode-one');
    writeFileSync(join(folder, 'Clip B.mkv'), 'episode-two');

    pipe.finder.requestSearch('tv:1');

    const first = pipe.queue.get('tv:1:1x1')!;
    const second = pipe.queue.get('tv:1:1x2')!;
    await until(() => reasonOfEntry(first)?.code === 'file_unmapped' && reasonOfEntry(second)?.code === 'file_unmapped', 10_000);
    // A download would only find the same files again, so the season waits for the user.
    expect(stageOf(first)).toBe('importing');
    expect(pipe.tracker.state.searches).toEqual([]);

    // The files of the folder are offered for the match, without a torrent.
    const listing = await api.get('/queue/entries/tv:1:1x1/files');
    expect(listing.status).toBe(200);
    expect(listing.body.files.map((file: { rel: string }) => file.rel).sort()).toEqual(['Show Name (2020)/Season 01/Clip A.mkv', 'Show Name (2020)/Season 01/Clip B.mkv']);

    const match = await api.post('/queue/entries/tv:1:1x1/match', { file: 'Show Name (2020)/Season 01/Clip A.mkv' });
    expect(match.status).toBe(200);
    await until(() => stageOf(first) === 'available', 10_000);
    expect(reasonOfEntry(first)).toBeNull();
    expect(Object.values(pipe.db.data.files).find((file) => file.path.endsWith('Clip A.mkv'))?.episodes).toEqual([{ season: 1, number: 1 }]);
    // The other episode has no file of its own yet, so it keeps waiting for the user.
    expect(reasonOfEntry(second)?.code).toBe('file_unmapped');

    const secondMatch = await api.post('/queue/entries/tv:1:1x2/match', { file: 'Show Name (2020)/Season 01/Clip B.mkv' });
    expect(secondMatch.status).toBe(200);
    await until(() => stageOf(second) === 'available', 10_000);
    expect(pipe.tracker.state.searches).toEqual([]);
  });

  it('keeps a file that the user matched when the folder is scanned again', async () => {
    pipe = await startPipeline();
    const api = await pipe.api();
    const series = title({ rootId: 'tv', folder: 'Show Name (2020)', episodes: [episode(1, 1), episode(1, 2)] });
    pipe.db.data.titles[series.key] = series;
    const folder = join(pipe.folders.tv, 'Show Name (2020)', 'Season 01');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'Clip A.mkv'), 'episode-one');
    writeFileSync(join(folder, 'Clip B.mkv'), 'episode-two');

    pipe.finder.requestSearch('tv:1');
    const first = pipe.queue.get('tv:1:1x1')!;
    await until(() => reasonOfEntry(first)?.code === 'file_unmapped', 10_000);
    for (const [id, file] of [
      ['tv:1:1x1', 'Show Name (2020)/Season 01/Clip A.mkv'],
      ['tv:1:1x2', 'Show Name (2020)/Season 01/Clip B.mkv'],
    ] as const) {
      expect((await api.post(`/queue/entries/${id}/match`, { file })).status).toBe(200);
      await until(() => stageOf(pipe!.queue.get(id)!) === 'available', 10_000);
    }

    // The scan reads the names again. A name that gives no episode must not take the file away from its episode.
    const scan = await scanTitle('tv:1');
    expect(scan.missing).toBe(0);
    const matched = Object.values(pipe.db.data.files).find((file) => file.path.endsWith('Clip A.mkv'))!;
    expect(matched.missing).toBe(false);
    expect(matched.episodes).toEqual([{ season: 1, number: 1 }]);
    expect(series.episodes[0]!.fileId).toBe(matched.id);
  });

  it('takes a file of another title folder out of the match', async () => {
    pipe = await startPipeline();
    const api = await pipe.api();
    const series = title({ rootId: 'tv', folder: 'Show Name (2020)', episodes: [episode(1, 1)] });
    pipe.db.data.titles[series.key] = series;
    const other = title({ key: 'tv:2', tmdbId: 2, folder: 'Other Show (2021)', episodes: [episode(1, 1)] });
    pipe.db.data.titles[other.key] = other;
    for (const name of ['Show Name (2020)/Season 01/Clip A.mkv', 'Other Show (2021)/Season 01/Clip Z.mkv']) {
      mkdirSync(dirname(join(pipe.folders.tv, name)), { recursive: true });
      writeFileSync(join(pipe.folders.tv, name), 'video');
    }

    pipe.finder.requestSearch('tv:1');
    const entry = pipe.queue.get('tv:1:1x1')!;
    await until(() => reasonOfEntry(entry)?.code === 'file_unmapped', 10_000);

    const match = await api.post('/queue/entries/tv:1:1x1/match', { file: 'Other Show (2021)/Season 01/Clip Z.mkv' });
    expect(match.status).toBe(400);
    expect(stageOf(entry)).toBe('importing');
  });
});

// A download that the client still has stays with the target, also when the file is imported from the title folder.
describe('the torrent of a file that is in the folder', () => {
  it('stays as the chosen torrent of the target', async () => {
    pipe = await startPipeline();
    const series = title({ rootId: 'tv', folder: 'Show Name (2020)', episodes: [episode(1, 1)] });
    pipe.db.data.titles[series.key] = series;
    const name = 'Show.Name.S01.1080p.WEB-DL-GRP';
    const content = 'episode-one';
    const downloads = join(pipe.folders.downloads, name);
    mkdirSync(downloads, { recursive: true });
    writeFileSync(join(downloads, 'Show.Name.S01E01.mkv'), content);
    const hash = hashOf(name);
    pipe.qbit.torrents.set(hash, {
      hash,
      name,
      size: content.length,
      progress: 1,
      state: 'uploading',
      category: '',
      tags: '',
      save_path: pipe.folders.downloads,
      content_path: downloads,
      dlspeed: 0,
      eta: 0,
      num_seeds: 0,
      num_leechs: 0,
      added_on: Math.floor(Date.now() / 1000),
    });
    pipe.qbit.setFiles(hash, [{ name: `${name}/Show.Name.S01E01.mkv`, size: content.length, progress: 1 }]);
    // The library file is the hard link of the file of the torrent, as an import leaves it.
    const folder = join(pipe.folders.tv, 'Show Name (2020)', 'Season 01');
    mkdirSync(folder, { recursive: true });
    linkSync(join(downloads, 'Show.Name.S01E01.mkv'), join(folder, 'Show Name - S01E01.mkv'));

    pipe.finder.requestSearch('tv:1');

    const entry = pipe.queue.get('tv:1:1x1')!;
    await until(() => stageOf(entry) === 'available', 15_000);
    expect(pipe.tracker.state.searches).toEqual([]);
    expect(entry.transferHash).toBe(hash);
    expect(entry.clientId).toBe('client-1');
    expect(entry.release).toMatchObject({ title: name, infoHash: hash, external: true });
    const file = Object.values(pipe.db.data.files).find((item) => item.path === 'Show Name (2020)/Season 01/Show Name - S01E01.mkv');
    expect(file?.download).toMatchObject({ clientId: 'client-1', hash });
  });

  it('waits for the root instead of calling its episodes missing', async () => {
    pipe = await startPipeline();
    const series = title({ rootId: 'tv', folder: 'Show Name (2020)', episodes: [episode(1, 1)] });
    pipe.db.data.titles[series.key] = series;
    // The mount is gone, so the folder says nothing about the files of the series.
    pipe.db.data.roots.tv = { ...pipe.db.data.roots.tv!, path: join(pipe.folders.tv, 'unmounted') };
    pipe.tracker.state.items = [{ title: 'Show.Name.S01E01.1080p.WEB-DL-GRP', size: 60 * 45 * MIB }];

    pipe.finder.requestSearch('tv:1');

    const entry = pipe.queue.get('tv:1:1x1')!;
    await until(() => reasonOfEntry(entry)?.code === 'root_unavailable', 15_000);
    // A download would put a second copy next to a file that the app cannot see.
    expect(pipe.tracker.state.searches).toEqual([]);
    expect(pipe.tracker.state.downloads).toEqual([]);
  });
});
