import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PlanPreview, PlanResult } from '@ladarr/shared/types';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEvents } from '../../src/core/events.ts';
import { enqueue } from '../../src/core/jobs.ts';
import { seriesCounts } from '../../src/library/library.ts';
import { dropTitle, forgetFile, retireFile, seeFile, type Seen } from '../../src/library/tools/remove.ts';
import { createQueue } from '../../src/library/downloads/queue.ts';
import { scanTitle } from '../../src/library/scan.ts';
import { startTestApp } from '../helpers/test-app.ts';
import { episode, movie, title } from '../helpers/test-fixtures.ts';
import type { Tmdb } from '../../src/metadata/tmdb.ts';

let app: Awaited<ReturnType<typeof startTestApp>>;
let dir: string;
let tv: string;
let movies: string;

const write = (path: string, text = 'data') => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
};

const show = () => title({ rootId: 'tv', folder: 'Show', episodes: [episode(1, 1), episode(1, 2), episode(1, 3)] });
const film = () => movie({ rootId: 'movies', folder: 'Film (2000)' });

const plan = (body: unknown) => app.post('/library/plans', body);
const preview = async (body: unknown) => (await plan(body)).body as PlanPreview;
const apply = (planId: string) => app.post(`/library/plans/${planId}/apply`);

beforeAll(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'ladarr-plans-')));
  tv = join(dir, 'tv');
  movies = join(dir, 'movies');
  mkdirSync(tv);
  mkdirSync(movies);
  // A stand-in for TMDB. The bulk refresh only queues a job, so it never calls it.
  app = await startTestApp({ tmdb: {} as Tmdb });
  const dev = statSync(tv).dev;
  app.db.data.roots = { tv: { id: 'tv', path: tv, mediaType: 'tv', dev }, movies: { id: 'movies', path: movies, mediaType: 'movie', dev } };
});
afterAll(() => {
  app.close();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  for (const root of [tv, movies]) for (const name of readdirSync(root)) rmSync(join(root, name), { recursive: true, force: true });
  Object.assign(app.db.data, { titles: {}, files: {}, imports: {}, queue: {}, jobs: {} });
  app.db.data.roots.tv!.dev = app.db.data.roots.movies!.dev = statSync(tv).dev;
});
afterEach(() => vi.restoreAllMocks());

// A series with two episode files and two files that ladarr does not manage.
async function seedShow() {
  write(join(tv, 'Show', 'Season 01', 'Show.S01E01.mkv'), 'episode one');
  write(join(tv, 'Show', 'Season 01', 'Show.S01E02.mkv'), 'episode two');
  write(join(tv, 'Show', 'Season 01', 'Show.S01E01.en.srt'), 'subtitle');
  write(join(tv, 'Show', 'poster.jpg'), 'poster');
  app.db.data.titles['tv:1'] = show();
  await scanTitle(app.db, 'tv:1');
}

async function seedFilm() {
  write(join(movies, 'Film (2000)', 'Film (2000).mkv'), 'the film');
  app.db.data.titles['movie:2'] = film();
  await scanTitle(app.db, 'movie:2');
}

describe('preview of a removal with files', () => {
  it('names every file that moves, and every file that stays in the folder', async () => {
    await seedShow();
    const body = await preview({ action: 'remove', keys: ['tv:1'], deleteFiles: true });
    expect(body.files.map((file) => file.path).sort()).toEqual(['Show/Season 01/Show.S01E01.mkv', 'Show/Season 01/Show.S01E02.mkv']);
    expect(body.files.every((file) => file.present && file.problem === null)).toBe(true);
    expect(body.titles).toMatchObject([{ key: 'tv:1', files: 2, bytes: 22, skip: null }]);
    expect(body.stays.map((file) => file.path).sort()).toEqual(['Show/Season 01/Show.S01E01.en.srt', 'Show/poster.jpg']);
    // The preview moves nothing.
    expect(existsSync(join(tv, 'Show', 'Season 01', 'Show.S01E01.mkv'))).toBe(true);
    expect(Object.keys(app.db.data.files)).toHaveLength(2);
  });

  it('lists no file for a removal that keeps the files', async () => {
    await seedShow();
    const body = await preview({ action: 'remove', keys: ['tv:1'] });
    expect(body.files).toEqual([]);
    expect(body.titles[0]).toMatchObject({ files: 2 });
  });
});

describe('apply of a removal with files', () => {
  it('deletes the files, removes the title and its records, and keeps the other files', async () => {
    await seedShow();
    const body = await preview({ action: 'remove', keys: ['tv:1'], deleteFiles: true });
    const result = (await apply(body.planId)).body as PlanResult;
    expect(result).toMatchObject({ changed: 1, deleted: 2, skipped: [], failed: [] });

    expect(app.db.data.titles['tv:1']).toBeUndefined();
    expect(app.db.data.files).toEqual({});
    expect(existsSync(join(tv, 'Show', 'Season 01', 'Show.S01E01.mkv'))).toBe(false);
    expect(existsSync(join(tv, 'Show', 'Season 01', 'Show.S01E02.mkv'))).toBe(false);
    // The files that ladarr does not manage stay, so the folder stays.
    expect(readFileSync(join(tv, 'Show', 'poster.jpg'), 'utf8')).toBe('poster');
    expect(readFileSync(join(tv, 'Show', 'Season 01', 'Show.S01E01.en.srt'), 'utf8')).toBe('subtitle');
    expect(existsSync(join(tv, '.ladarr-recovery'))).toBe(false);
  });

  it('removes the empty folder of the title and keeps the root', async () => {
    await seedFilm();
    const body = await preview({ action: 'remove', keys: ['movie:2'], deleteFiles: true });
    expect(body.stays).toEqual([]);
    await apply(body.planId);
    expect(existsSync(join(movies, 'Film (2000)'))).toBe(false);
    expect(existsSync(movies)).toBe(true);
  });

  it('removes the blocklist of a removed title and keeps the blocklist of other titles', async () => {
    await seedShow();
    app.db.data.blocklist = {
      explicit: { title: 'Show.Name.S01E01.1080p.WEB-DL-GRP', reason: 'invalid_torrent', at: 1, titleKey: 'tv:1' },
      legacy: { title: 'Show.Name.S01E02.1080p.WEB-DL-GRP', reason: 'invalid_torrent', at: 2 },
      film: { title: 'Film.Name.2000.1080p.BluRay-GRP', reason: 'invalid_torrent', at: 3, titleKey: 'movie:2' },
    };
    await app.del('/library/tv:1');
    expect(Object.keys(app.db.data.blocklist)).toEqual(['film']);
  });

  it('keeps the files of a removal without the file option', async () => {
    await seedFilm();
    const body = await preview({ action: 'remove', keys: ['movie:2'] });
    expect(await apply(body.planId)).toMatchObject({ body: { changed: 1, deleted: 0 } });
    expect(readFileSync(join(movies, 'Film (2000)', 'Film (2000).mkv'), 'utf8')).toBe('the film');
    expect(app.db.data.titles['movie:2']).toBeUndefined();
    // The records go with the title, so no record points to a title that is gone.
    expect(app.db.data.files).toEqual({});
  });

  it('spends the plan: a second apply finds nothing', async () => {
    await seedFilm();
    const body = await preview({ action: 'remove', keys: ['movie:2'], deleteFiles: true });
    expect((await apply(body.planId)).status).toBe(200);
    expect((await apply(body.planId)).body).toEqual({ error: 'plan_not_found' });
    expect((await apply('nope')).status).toBe(404);
  });

  it('refuses a plan after it expired', async () => {
    await seedFilm();
    const body = await preview({ action: 'remove', keys: ['movie:2'], deleteFiles: true });
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 16 * 60_000);
    expect((await apply(body.planId)).status).toBe(404);
    expect(existsSync(join(movies, 'Film (2000)', 'Film (2000).mkv'))).toBe(true);
  });
});

describe('a change between the preview and the apply', () => {
  it('stops and changes nothing when a file changed on the disk', async () => {
    await seedShow();
    const body = await preview({ action: 'remove', keys: ['tv:1'], deleteFiles: true });
    write(join(tv, 'Show', 'Season 01', 'Show.S01E01.mkv'), 'a different and longer file');

    const result = await apply(body.planId);
    expect(result).toMatchObject({ status: 409, body: { error: 'plan_changed', keys: ['tv:1'] } });
    expect(app.db.data.titles['tv:1']).toBeDefined();
    expect(Object.keys(app.db.data.files)).toHaveLength(2);
    expect(readFileSync(join(tv, 'Show', 'Season 01', 'Show.S01E02.mkv'), 'utf8')).toBe('episode two');
  });

  it('stops when a new file was recorded after the preview', async () => {
    await seedShow();
    const body = await preview({ action: 'remove', keys: ['tv:1'], deleteFiles: true });
    write(join(tv, 'Show', 'Season 01', 'Show.S01E03.mkv'), 'new');
    await scanTitle(app.db, 'tv:1');
    expect((await apply(body.planId)).body).toMatchObject({ error: 'plan_changed' });
    expect(existsSync(join(tv, 'Show', 'Season 01', 'Show.S01E01.mkv'))).toBe(true);
  });

  it('stops when the title is gone', async () => {
    await seedFilm();
    const body = await preview({ action: 'remove', keys: ['movie:2'], deleteFiles: true });
    delete app.db.data.titles['movie:2'];
    expect((await apply(body.planId)).body).toMatchObject({ error: 'plan_changed', keys: ['movie:2'] });
    expect(existsSync(join(movies, 'Film (2000)', 'Film (2000).mkv'))).toBe(true);
  });

  it('skips a title when an import starts after the preview', async () => {
    await seedFilm();
    const body = await preview({ action: 'remove', keys: ['movie:2'], deleteFiles: true });
    app.db.data.imports.j = { id: 'j', hash: 'h', titleKey: 'movie:2', steps: [], createdAt: 0 };
    expect((await apply(body.planId)).body).toMatchObject({ changed: 0, deleted: 0, skipped: [{ key: 'movie:2', reason: 'import_running' }] });
    expect(app.db.data.titles['movie:2']).toBeDefined();
    expect(existsSync(join(movies, 'Film (2000)', 'Film (2000).mkv'))).toBe(true);
  });
});

describe('safety', () => {
  it('moves nothing when another disk is mounted at the root, and keeps every record', async () => {
    await seedFilm();
    app.db.data.roots.movies!.dev += 1;
    const body = await preview({ action: 'remove', keys: ['movie:2'], deleteFiles: true });
    expect(body.titles[0]).toMatchObject({ skip: 'root_unavailable' });
    expect(body.files).toEqual([]);
    expect(await apply(body.planId)).toMatchObject({ body: { changed: 0, skipped: [{ key: 'movie:2', reason: 'root_unavailable' }] } });
    expect(app.db.data.titles['movie:2']).toBeDefined();
    expect(Object.keys(app.db.data.files)).toHaveLength(1);
    expect(existsSync(join(movies, 'Film (2000)', 'Film (2000).mkv'))).toBe(true);
  });

  it('refuses a title with an unfinished import in the preview, in the apply, and in the plain removal', async () => {
    await seedFilm();
    app.db.data.imports.j = { id: 'j', hash: 'h', titleKey: 'movie:2', steps: [], createdAt: 0 };
    for (const request of [{ action: 'remove', keys: ['movie:2'] }, { action: 'remove', keys: ['movie:2'], deleteFiles: true }, { action: 'delete_files', keys: ['movie:2'] }]) {
      const body = await preview(request);
      expect(body.titles[0]).toMatchObject({ skip: 'import_running' });
      expect(await apply(body.planId)).toMatchObject({ body: { changed: 0, skipped: [{ reason: 'import_running' }] } });
    }
    expect((await app.del('/library/movie:2')).body).toEqual({ error: 'import_running' });
    expect(app.db.data.titles['movie:2']).toBeDefined();
    expect(existsSync(join(movies, 'Film (2000)', 'Film (2000).mkv'))).toBe(true);
  });

  it('keeps the title and the record of a file that cannot be deleted, and drops the records of the files that were deleted', async () => {
    await seedShow();
    // The third episode sits behind a link that leaves the root. ladarr must not touch it.
    write(join(dir, 'outside', 'Show.S01E03.mkv'), 'outside data');
    symlinkSync(join(dir, 'outside'), join(tv, 'Show', 'Season 03'));
    app.db.data.files.linked = { id: 'linked', titleKey: 'tv:1', path: 'Show/Season 03/Show.S01E03.mkv', sizeBytes: 12, mtimeMs: 1, episodes: [{ season: 1, number: 3 }], missing: false, addedAt: 0 };
    app.db.data.titles['tv:1']!.episodes[2]!.fileId = 'linked';

    const body = await preview({ action: 'remove', keys: ['tv:1'], deleteFiles: true });
    expect(body.files.find((file) => file.id === 'linked')).toMatchObject({ problem: 'outside_root' });
    const result = (await apply(body.planId)).body as PlanResult;
    expect(result).toMatchObject({ changed: 0, deleted: 2, failed: [{ path: 'Show/Season 03/Show.S01E03.mkv', reason: 'outside_root' }], skipped: [{ key: 'tv:1', reason: 'files_not_deleted' }] });

    const kept = app.db.data.titles['tv:1']!;
    expect(kept.episodes.map((e) => e.fileId)).toEqual([null, null, 'linked']);
    expect(Object.keys(app.db.data.files)).toEqual(['linked']);
    expect(readFileSync(join(dir, 'outside', 'Show.S01E03.mkv'), 'utf8')).toBe('outside data');
    expect(seriesCounts(kept, { now: Date.now(), timeZone: 'UTC', files: app.db.data.files })).toMatchObject({ available: 1 });
  });

  it('keeps every record when a file cannot be deleted', async () => {
    await seedFilm();
    const folder = join(movies, 'Film (2000)');
    chmodSync(folder, 0o500);
    try {
      const body = await preview({ action: 'remove', keys: ['movie:2'], deleteFiles: true });
      const result = (await apply(body.planId)).body as PlanResult;
      expect(result).toMatchObject({ changed: 0, deleted: 0, failed: [{ path: 'Film (2000)/Film (2000).mkv' }] });
      expect(app.db.data.titles['movie:2']!.fileId).toBeTruthy();
      expect(Object.keys(app.db.data.files)).toHaveLength(1);
      expect(readFileSync(join(folder, 'Film (2000).mkv'), 'utf8')).toBe('the film');
    } finally {
      chmodSync(folder, 0o700);
    }
  });

  it('treats a file that is gone already as deleted, and drops its record', async () => {
    await seedFilm();
    rmSync(join(movies, 'Film (2000)', 'Film (2000).mkv'));
    const body = await preview({ action: 'remove', keys: ['movie:2'], deleteFiles: true });
    expect(body.files).toMatchObject([{ present: false }]);
    expect(await apply(body.planId)).toMatchObject({ body: { changed: 1, deleted: 0, failed: [] } });
    expect(app.db.data.titles['movie:2']).toBeUndefined();
    expect(app.db.data.files).toEqual({});
  });

  it('does not let a scan that started before the removal record a file for the removed title', async () => {
    await seedFilm();
    delete app.db.data.titles['movie:2'];
    app.db.data.files = {};
    app.db.data.titles['movie:2'] = film();
    const scan = scanTitle(app.db, 'movie:2');
    // The scan has started and waits for the disk. The title goes now.
    dropTitle(app.db, 'movie:2');
    expect((await scan).status).toBe('no_folder');
    expect(app.db.data.files).toEqual({});
  });

  it('makes a scan that began before a deletion run again, so it cannot record a file that moved', async () => {
    await seedShow();
    const kept = app.db.data.titles['tv:1']!;
    const fileId = kept.episodes[0]!.fileId!;
    const scan = scanTitle(app.db, 'tv:1');
    // The scan waits for the disk. The deletion removes the record and the file now.
    forgetFile(app.db, kept, fileId);
    rmSync(join(tv, 'Show', 'Season 01', 'Show.S01E01.mkv'));
    const changed = await scan;
    expect(changed).toMatchObject({ status: 'changed', added: 0, updated: 0 });
    expect(app.db.data.files[fileId]).toBeUndefined();
    // The scan that runs after the deletion finds the disk as it is.
    expect((await scanTitle(app.db, 'tv:1')).status).toBe('ok');
    expect(kept.episodes[0]!.fileId).toBeNull();
  });

  it('stops moving files when an import starts for the title during the move', async () => {
    await seedShow();
    const body = await preview({ action: 'delete_files', keys: ['tv:1'] });
    // The journal appears after the first file moved.
    let calls = 0;
    const real = app.db.data.imports;
    Object.defineProperty(app.db.data, 'imports', {
      configurable: true,
      get: () => {
        if (++calls > 1 && !('j' in real)) real.j = { id: 'j', hash: 'h', titleKey: 'tv:1', steps: [], createdAt: 0 };
        return real;
      },
    });
    try {
      const result = (await apply(body.planId)).body as PlanResult;
      expect(result.failed.some((item) => item.reason === 'import_running')).toBe(true);
      expect(result.deleted).toBeLessThan(2);
      expect(app.db.data.titles['tv:1']).toBeDefined();
    } finally {
      Object.defineProperty(app.db.data, 'imports', { configurable: true, writable: true, value: real });
    }
  });

  it('cancels the active downloads of a removed title and leaves the finished ones', () => {
    const queue = createQueue(app.db, createEvents(), () => {});
    app.db.data.titles['tv:1'] = show();
    const active = queue.ensure('tv:1', 1, 1);
    queue.request(active, 'test');
    const finished = queue.ensure('tv:1', 1, 2);
    queue.request(finished, 'test');
    queue.move(finished, { stage: 'available' }, 'imported');
    const other = queue.ensure('movie:2', null, null);
    queue.request(other, 'test');

    dropTitle(app.db, 'tv:1', queue);
    expect(active.branch).toBe('cancelled');
    expect(finished).toMatchObject({ branch: null, stage: 'available' });
    expect(other.branch).toBeNull();
  });

  it('removes the file records of the title and no other record in a plain removal', async () => {
    await seedShow();
    await seedFilm();
    expect((await app.del('/library/tv:1')).status).toBe(200);
    expect(Object.values(app.db.data.files).map((file) => file.titleKey)).toEqual(['movie:2']);
    expect(existsSync(join(tv, 'Show', 'Season 01', 'Show.S01E01.mkv'))).toBe(true);
  });
});

describe('retireFile', () => {
  it('leaves a file that changed after the check, and deletes the file', async () => {
    write(join(movies, 'Film', 'a.mkv'), 'one');
    const seen = (await seeFile(movies, 'Film/a.mkv')) as { seen: Seen };
    write(join(movies, 'Film', 'a.mkv'), 'one and more');
    expect(await retireFile(movies, 'Film/a.mkv', seen.seen)).toEqual({ ok: false, reason: 'changed' });
    expect(readFileSync(join(movies, 'Film', 'a.mkv'), 'utf8')).toBe('one and more');

    const now = (await seeFile(movies, 'Film/a.mkv')) as { seen: Seen };
    expect(await retireFile(movies, 'Film/a.mkv', now.seen)).toEqual({ ok: true, how: 'deleted' });
    expect(existsSync(join(movies, 'Film', 'a.mkv'))).toBe(false);
    expect(await retireFile(movies, 'Film/a.mkv', null)).toEqual({ ok: true, how: 'gone' });
  });

  it('refuses a path that leaves the root', async () => {
    write(join(dir, 'outside.mkv'), 'x');
    expect(await retireFile(movies, '../outside.mkv', { sizeBytes: 1, mtimeMs: 1 })).toEqual({ ok: false, reason: 'outside_root' });
    expect(existsSync(join(dir, 'outside.mkv'))).toBe(true);
  });
});

describe('delete files and keep the title', () => {
  it('moves one file and shows its episode as missing', async () => {
    await seedShow();
    const [first] = app.db.data.titles['tv:1']!.episodes;
    const fileId = first!.fileId!;
    const body = await preview({ action: 'delete_files', keys: ['tv:1'], fileIds: [fileId] });
    expect(body.files).toMatchObject([{ id: fileId, path: 'Show/Season 01/Show.S01E01.mkv', episodes: [{ season: 1, number: 1 }] }]);
    expect(body.stays).toEqual([]);

    expect(await apply(body.planId)).toMatchObject({ body: { changed: 1, deleted: 1 } });
    const kept = app.db.data.titles['tv:1']!;
    expect(kept.episodes.map((e) => Boolean(e.fileId))).toEqual([false, true, false]);
    expect(app.db.data.files[fileId]).toBeUndefined();
    expect(seriesCounts(kept, { now: Date.now(), timeZone: 'UTC', files: app.db.data.files })).toMatchObject({ eligible: 3, available: 1 });
    expect(existsSync(join(tv, 'Show', 'Season 01', 'Show.S01E01.mkv'))).toBe(false);
    expect(existsSync(join(tv, 'Show', 'Season 01', 'Show.S01E01.en.srt'))).toBe(true);
  });

  it('moves every file of the titles when no file is named, and keeps the folders', async () => {
    await seedShow();
    await seedFilm();
    const body = await preview({ action: 'delete_files', keys: ['tv:1', 'movie:2'] });
    expect(body.files).toHaveLength(3);
    await apply(body.planId);
    expect(app.db.data.files).toEqual({});
    expect(app.db.data.titles['movie:2']!.fileId).toBeNull();
    expect(existsSync(join(movies, 'Film (2000)'))).toBe(true);
  });

  it('rejects a file that belongs to another title', async () => {
    await seedShow();
    await seedFilm();
    const other = app.db.data.titles['movie:2']!.fileId!;
    expect((await plan({ action: 'delete_files', keys: ['tv:1'], fileIds: [other] })).body).toEqual({ error: 'invalid_files' });
    expect((await plan({ action: 'delete_files', keys: ['tv:1', 'movie:2'], fileIds: [other] })).body).toEqual({ error: 'invalid_files' });
  });

  it('refuses a plan with more files than the preview can list', async () => {
    app.db.data.titles['tv:1'] = show();
    for (let i = 0; i < 5_001; i++) app.db.data.files[`f${i}`] = { id: `f${i}`, titleKey: 'tv:1', path: `Show/${i}.mkv`, sizeBytes: 1, mtimeMs: 1, episodes: [], missing: false, addedAt: 0 };
    expect((await plan({ action: 'delete_files', keys: ['tv:1'] })).status).toBe(413);
  });
});

describe('bulk actions that keep the files', () => {
  beforeEach(async () => {
    await seedShow();
    await seedFilm();
  });

  it('pauses and resumes the selected titles, and shows the ones that need no change', async () => {
    app.db.data.titles['movie:2']!.paused = true;
    const body = await preview({ action: 'pause', keys: ['tv:1', 'movie:2'] });
    expect(body.titles.map((row) => [row.key, row.files, row.unchanged])).toEqual([['tv:1', 2, false], ['movie:2', 1, true]]);
    expect(await apply(body.planId)).toMatchObject({ body: { changed: 1 } });
    expect(app.db.data.titles['tv:1']!.paused).toBe(true);

    await apply((await preview({ action: 'resume', keys: ['tv:1', 'movie:2'] })).planId);
    expect([app.db.data.titles['tv:1']!.paused, app.db.data.titles['movie:2']!.paused]).toEqual([false, false]);
  });

  it('sets the quality preset, or the default with null', async () => {
    await apply((await preview({ action: 'preset', keys: ['tv:1'], preset: 'p2160' })).planId);
    expect(app.db.data.titles['tv:1']!.preset).toBe('p2160');
    await apply((await preview({ action: 'preset', keys: ['tv:1'], preset: null })).planId);
    expect(app.db.data.titles['tv:1']!.preset).toBeNull();
  });

  it('queues one refresh job for each title', async () => {
    await apply((await preview({ action: 'refresh', keys: ['tv:1', 'movie:2'] })).planId);
    expect(Object.values(app.db.data.jobs).map((job) => job.dedupeKey).sort()).toEqual(['refresh:movie:2', 'refresh:tv:1']);
  });

  it('removes the selected titles in one apply, with the file count in the preview', async () => {
    const body = await preview({ action: 'remove', keys: ['tv:1', 'movie:2'], deleteFiles: true });
    expect(body.titles.map((row) => row.files)).toEqual([2, 1]);
    expect(body.files).toHaveLength(3);
    expect(await apply(body.planId)).toMatchObject({ body: { changed: 2, deleted: 3 } });
    expect(app.db.data.titles).toEqual({});
  });
});

describe('removal of one season', () => {
  async function seedTwoSeasons() {
    write(join(tv, 'Show', 'Season 01', 'Show.S01E01.mkv'), 'one');
    write(join(tv, 'Show', 'Season 01', 'Show.S01E02.mkv'), 'two');
    write(join(tv, 'Show', 'Season 02', 'Show.S02E01.mkv'), 'three');
    app.db.data.titles['tv:1'] = title({ rootId: 'tv', folder: 'Show', episodes: [episode(1, 1), episode(1, 2), episode(2, 1)] });
    await scanTitle(app.db, 'tv:1');
  }

  it('lists only the files of the season that is removed', async () => {
    await seedTwoSeasons();
    const body = await preview({ action: 'remove', keys: ['tv:1'], season: 2, deleteFiles: true });
    expect(body.files.map((file) => file.path)).toEqual(['Show/Season 02/Show.S02E01.mkv']);
    expect(body.titles).toMatchObject([{ key: 'tv:1', files: 1, bytes: 5, skip: null }]);
    expect(body.stays).toEqual([]);
  });

  it('deletes the files of the season, keeps the title, and keeps the other seasons', async () => {
    await seedTwoSeasons();
    const body = await preview({ action: 'remove', keys: ['tv:1'], season: 1, deleteFiles: true });
    expect((await apply(body.planId)).body).toMatchObject({ changed: 1, deleted: 2, skipped: [], failed: [] });

    expect(app.db.data.titles['tv:1']).toBeDefined();
    expect(existsSync(join(tv, 'Show', 'Season 01', 'Show.S01E01.mkv'))).toBe(false);
    expect(existsSync(join(tv, 'Show', 'Season 01', 'Show.S01E02.mkv'))).toBe(false);
    expect(readFileSync(join(tv, 'Show', 'Season 02', 'Show.S02E01.mkv'), 'utf8')).toBe('three');

    const kept = app.db.data.titles['tv:1']!;
    expect(kept.seasonOverrides).toMatchObject({ 1: 'unmonitored' });
    expect(kept.episodes.filter((item) => item.season === 1).map((item) => item.fileId)).toEqual([null, null]);
    expect(kept.episodes.find((item) => item.season === 2)!.fileId).toBeTruthy();
    expect(Object.keys(app.db.data.files)).toHaveLength(1);
  });

  it('removes only the blocklist of the season that is removed', async () => {
    await seedTwoSeasons();
    app.db.data.blocklist = {
      's1-explicit': { title: 'Show.S01.1080p.WEB-DL-GRP', reason: 'pack_missing_episodes', at: 1, titleKey: 'tv:1', season: 1 },
      's1-legacy': { title: 'Show.Name.S01E02.1080p.WEB-DL-GRP', reason: 'invalid_torrent', at: 2 },
      's2-legacy': { title: 'Show.Name.S02E01.1080p.WEB-DL-GRP', reason: 'invalid_torrent', at: 3 },
      other: { title: 'Other.Show.S01E01.1080p.WEB-DL-GRP', reason: 'invalid_torrent', at: 4, titleKey: 'tv:9', season: 1 },
    };
    await apply((await preview({ action: 'remove', keys: ['tv:1'], season: 1 })).planId);
    expect(Object.keys(app.db.data.blocklist).sort()).toEqual(['other', 's2-legacy']);
  });

  it('unmonitors the season and keeps its files without the file option', async () => {
    await seedTwoSeasons();
    const body = await preview({ action: 'remove', keys: ['tv:1'], season: 1 });
    expect(body.files).toEqual([]);
    expect((await apply(body.planId)).body).toMatchObject({ changed: 1, deleted: 0 });

    expect(app.db.data.titles['tv:1']).toBeDefined();
    expect(app.db.data.titles['tv:1']!.seasonOverrides).toMatchObject({ 1: 'unmonitored' });
    expect(readFileSync(join(tv, 'Show', 'Season 01', 'Show.S01E01.mkv'), 'utf8')).toBe('one');
    expect(Object.keys(app.db.data.files)).toHaveLength(3);
  });

  it('clears the choices of the episodes of the season, so the season is selected again on a later add', async () => {
    await seedTwoSeasons();
    const show = app.db.data.titles['tv:1']!;
    show.episodes.filter((item) => item.season === 1)[0]!.override = 'unmonitored';
    show.episodes.filter((item) => item.season === 2)[0]!.override = 'unmonitored';

    await apply((await preview({ action: 'remove', keys: ['tv:1'], season: 1 })).planId);
    expect(show.episodes.filter((item) => item.season === 1).map((item) => item.override)).toEqual([null, null]);
    expect(show.episodes.find((item) => item.season === 2)!.override).toBe('unmonitored');
  });

  it('removes the queue targets and the jobs of the season, and keeps the other seasons', async () => {
    await seedTwoSeasons();
    const queue = createQueue(app.db, createEvents(), () => {});
    const first = queue.ensure('tv:1', 1, 1);
    queue.request(first, 'test');
    const second = queue.ensure('tv:1', 2, 1);
    queue.request(second, 'test');
    const own = enqueue(app.db, { type: 'queue.search', payload: { titleKey: 'tv:1', season: 1, entryIds: [first.id] } });
    const other = enqueue(app.db, { type: 'queue.search', payload: { titleKey: 'tv:1', season: 2, entryIds: [second.id] } });

    await apply((await preview({ action: 'remove', keys: ['tv:1'], season: 1 })).planId);
    expect(app.db.data.queue[first.id]).toBeUndefined();
    expect(app.db.data.queue[second.id]).toBeDefined();
    expect(app.db.data.jobs[own.id]).toBeUndefined();
    expect(app.db.data.jobs[other.id]).toBeDefined();
  });

  it.each([
    [{ action: 'remove', keys: ['movie:2'], season: 1 }, 'invalid_season'],
    [{ action: 'remove', keys: ['tv:1'], season: 3 }, 'invalid_season'],
    [{ action: 'remove', keys: ['tv:1'], season: -1 }, 'invalid_season'],
    [{ action: 'remove', keys: ['tv:1'], season: 1.5 }, 'invalid_season'],
    [{ action: 'remove', keys: ['tv:1', 'movie:2'], season: 1 }, 'invalid_season'],
    [{ action: 'delete_files', keys: ['tv:1'], season: 1 }, 'invalid_season'],
  ])('refuses %j', async (body, error) => {
    await seedTwoSeasons();
    app.db.data.titles['movie:2'] = movie({ rootId: 'movies' });
    expect((await plan(body)).body).toEqual({ error });
  });
});

describe('requests', () => {
  it.each([
    [[], 'invalid_plan'],
    [{}, 'invalid_action'],
    [{ action: 'explode', keys: ['tv:1'] }, 'invalid_action'],
    [{ action: 'pause', keys: [] }, 'invalid_keys'],
    [{ action: 'pause', keys: ['tv:1', 'bad'] }, 'invalid_keys'],
    [{ action: 'pause', keys: 'tv:1' }, 'invalid_keys'],
    [{ action: 'preset', keys: ['tv:1'], preset: 'p480' }, 'invalid_preset'],
    [{ action: 'preset', keys: ['tv:1'], preset: 'constructor' }, 'invalid_preset'],
    [{ action: 'preset', keys: ['tv:1'] }, 'invalid_preset'],
    [{ action: 'remove', keys: ['tv:1'], deleteFiles: 'yes' }, 'invalid_plan'],
  ])('rejects %j', async (body, error) => {
    expect((await plan(body)).body).toEqual({ error });
  });

  it('answers 404 for a title that is not in the library', async () => {
    expect((await plan({ action: 'pause', keys: ['tv:999'] })).body).toEqual({ error: 'not_found', key: 'tv:999' });
  });

  it('refuses a refresh when no metadata provider is connected', async () => {
    const bare = await startTestApp();
    try {
      bare.db.data.titles['tv:1'] = show();
      expect((await bare.post('/library/plans', { action: 'refresh', keys: ['tv:1'] })).body).toEqual({ error: 'metadata_unavailable' });
    } finally {
      bare.close();
    }
  });
});
