import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanTitle } from '../../src/library/scan.ts';
import { BULK_SEARCH_JOB } from '../../src/library/calendar/calendar-search.ts';
import { librarySearchHandler } from '../../src/jobs/library-search.ts';
import { enqueue } from '../../src/core/jobs.ts';
import { hashOf, MIB, startPipeline, until } from '../helpers/test-pipeline.ts';
import { movie } from '../helpers/test-fixtures.ts';

describe('multiple versions of a title', () => {
  it('keeps the old file of an upgrade, shows both resolutions, and removes both torrents', async () => {
    const pipe = await startPipeline({ handlers: ({ finder }) => ({ [BULK_SEARCH_JOB]: librarySearchHandler({ finder, enqueue: (input) => enqueue(input) }) }) });
    const api = await pipe.api();
    try {
      const film = movie({ rootId: 'movie', manualRelease: true, folder: 'Movie Name (2019)', fileId: 'old' });
      const oldPath = 'Movie Name (2019)/Movie Name (2019).mkv';
      mkdirSync(join(pipe.folders.movies, 'Movie Name (2019)'));
      writeFileSync(join(pipe.folders.movies, oldPath), 'old-data');
      pipe.db.data.titles[film.key] = film;
      pipe.db.data.files.old = {
        id: 'old',
        titleKey: film.key,
        path: oldPath,
        sizeBytes: 8,
        mtimeMs: 1,
        episodes: [],
        missing: false,
        addedAt: 1,
        source: 'webdl',
        resolution: 720,
      };
      // The entry of the old download is available and still knows the torrent that gave the file.
      const oldEntry = pipe.queue.ensure(film.key, null, null);
      Object.assign(oldEntry, {
        stage: 'available',
        stageSince: 1,
        attempt: 1,
        attempts: [{ n: 1, startedAt: 1, endedAt: 2, reason: 'title added', release: 'Old Release', outcome: 'imported' }],
        release: { guid: 'old', indexerId: 1, indexerName: 'Indexer', title: 'Movie.Name.2019.720p.WEB-DL-GRP', sizeBytes: 1, infoHash: 'old-hash', link: null, magnet: null, kind: 'single' as const, seeders: 1, manual: false },
        transferHash: 'old-hash',
        clientId: 'client-1',
        importResult: { at: 2, ok: true, method: 'hardlink', path: oldPath, validation: 'ffprobe' },
      });

      const name = 'Movie.Name.2019.1080p.WEB-DL-GRP';
      pipe.tracker.state.items = [{ title: name, size: 100 * 120 * MIB }];
      const plan = (await api.post('/library/search/preview', { kind: 'upgrades', keys: [film.key], quality: 'webdl-1080' })).body;
      expect(plan).toMatchObject({ planId: expect.any(String), targets: 1 });
      expect((await api.post('/library/search', { planId: plan.planId })).status).toBe(202);

      await until(() => Boolean(pipe.queue.get(film.key)));
      const entry = pipe.queue.get(film.key)!;
      await until(() => entry.stage === 'downloading');
      pipe.complete(name, { [`${name}.mkv`]: 'new-data' });
      await until(() => entry.stage === 'available', 12_000);

      const files = Object.values(pipe.db.data.files).filter((file) => file.titleKey === film.key);
      expect(files).toHaveLength(2);
      const old = files.find((file) => file.id === 'old')!;
      const added = files.find((file) => file.id !== 'old')!;
      expect(old).toMatchObject({ path: oldPath, missing: false, resolution: 720 });
      expect(old.download).toEqual({ clientId: 'client-1', hash: 'old-hash', external: false });
      expect(added.path).toBe('Movie Name (2019)/Movie Name (2019) - 1080p.mkv');
      expect(added).toMatchObject({ missing: false, resolution: 1080, download: { clientId: 'client-1', hash: hashOf(name), external: false } });
      expect(pipe.db.data.titles[film.key]!.fileId).toBe(added.id);
      expect(readFileSync(join(pipe.folders.movies, oldPath), 'utf8')).toBe('old-data');
      expect(readFileSync(join(pipe.folders.movies, added.path), 'utf8')).toBe('new-data');
      expect((await api.get(`/library/${film.key}`)).body.title.resolutions).toEqual([1080, 720]);

      // A rescan keeps both versions.
      const scan = await scanTitle(film.key);
      expect(scan.missing).toBe(0);
      expect(files.every((file) => !file.missing)).toBe(true);
      expect(pipe.db.data.titles[film.key]!.fileId).toBe(added.id);

      // The removal deletes both files and both torrents.
      const removal = (await api.post('/library/plans', { action: 'remove', keys: [film.key], deleteFiles: true })).body;
      await api.post(`/library/plans/${removal.planId}/apply`);
      expect(pipe.db.data.titles[film.key]).toBeUndefined();
      expect(Object.values(pipe.db.data.files).filter((file) => file.titleKey === film.key)).toHaveLength(0);
      expect(existsSync(join(pipe.folders.movies, oldPath))).toBe(false);
      expect(existsSync(join(pipe.folders.movies, added.path))).toBe(false);
      const removed = pipe.qbit.calls.filter((call) => call.path === 'torrents/delete').map((call) => JSON.parse(call.body!) as { hashes: string; deleteFiles: string });
      expect(removed.flatMap((call) => call.hashes.split('|'))).toEqual(expect.arrayContaining(['old-hash', hashOf(name)]));
      expect(removed.every((call) => call.deleteFiles === 'true')).toBe(true);
    } finally {
      api.close();
      await pipe.stop();
    }
  }, 30_000);
});
