import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { importResumeHandler } from '../../src/jobs/import-resume.ts';
import type { Job } from '../../src/core/jobs.ts';
import { episode, movie } from '../helpers/test-fixtures.ts';
import { noLink, sleep, startImportTest } from '../helpers/test-import.ts';
import { MIB, until } from '../helpers/test-pipeline.ts';

let t: Awaited<ReturnType<typeof startImportTest>> | undefined;
afterEach(async () => {
  await t?.stop();
  t = undefined;
});

const E01 = 'Show Name (2020)/Season 01/Show Name - S01E01 - Episode 1.mkv';
const E02 = 'Show Name (2020)/Season 01/Show Name - S01E02 - Episode 2.mkv';
const SEASON_DIR = 'Show Name (2020)/Season 01';

const importFolder = async (path: string, extra: Record<string, unknown> = {}) => t!.api.post('/import/folder', { titleKey: 'tv:1', path, ...extra });
const preview = async (path: string, extra: Record<string, unknown> = {}) => t!.api.post('/import/folder/preview', { titleKey: 'tv:1', path, ...extra });

describe('preview', () => {
  it('shows what each file would do, and changes nothing', async () => {
    t = await startImportTest();
    t.write(t.inbox, {
      'Show.Name.S01E01.mkv': 'one',
      'Show.Name.S01E02.mkv': 'two',
      // A smaller file for the same episode is a duplicate.
      'extra/Show.Name.S01E02.720p.mkv': 'tw',
      'Show.Name.S01E09.mkv': 'nine',
      'readme.mkv': 'x',
      'notes.txt': 'not a video',
      // A sample and a hidden folder are not part of the import.
      'Sample/Show.Name.S01E03.mkv': 'sample',
      '.hidden/Show.Name.S01E03.mkv': 'hidden',
    });
    const before = t.tree(t.pipe.folders.tv);
    const { status, body } = await preview(t.inbox);
    expect(status).toBe(200);
    const plan = body.plan;
    expect(plan.files.map((f: { rel: string; status: string }) => [f.rel, f.status])).toEqual([
      ['Show.Name.S01E01.mkv', 'new'],
      ['Show.Name.S01E02.mkv', 'new'],
      ['Show.Name.S01E09.mkv', 'unknown_episode'],
      ['extra/Show.Name.S01E02.720p.mkv', 'duplicate'],
      ['readme.mkv', 'unmatched'],
    ]);
    expect(plan.files[0]).toMatchObject({ dest: E01, replaces: null, episodes: [{ season: 1, number: 1, name: 'Episode 1' }] });
    expect(plan).toMatchObject({ importable: 2, nameMatch: true, truncated: false, coverage: [{ season: 1, total: 3, covered: 2, missing: [3] }] });
    // The plan holds no journal step and no resolved path of the server.
    expect(plan.steps).toBeUndefined();
    expect(plan.real).toBeUndefined();

    expect(t.tree(t.pipe.folders.tv)).toEqual(before);
    expect(t.pipe.db.data.imports).toEqual({});
    expect(Object.values(t.pipe.db.data.jobs).filter((job) => job.type === 'import.run')).toEqual([]);
    expect(t.tree(t.inbox)).toHaveLength(8);
  });

  it('says when the name of the folder is not the name of the title', async () => {
    t = await startImportTest();
    t.write(t.inbox, { 'Other.Thing.S01E01.mkv': 'one' });
    expect((await preview(t.inbox)).body.plan).toMatchObject({ nameMatch: false, importable: 1 });
  });

  it('lists the other videos of a movie as extra files', async () => {
    t = await startImportTest();
    t.pipe.db.data.titles['movie:2'] = (await import('../helpers/test-fixtures.ts')).movie({ rootId: 'movie' });
    t.write(t.inbox, { 'Movie.Name.2019.mkv': 'the movie data', 'Movie.Name.2019.trailer.mkv': 'trailer' });
    const { body } = await t.api.post('/import/folder/preview', { titleKey: 'movie:2', path: t.inbox });
    expect(body.plan.files.map((f: { rel: string; status: string; dest: string | null }) => [f.rel, f.status, f.dest])).toEqual([
      ['Movie.Name.2019.mkv', 'new', 'Movie Name (2019)/Movie Name (2019).mkv'],
      ['Movie.Name.2019.trailer.mkv', 'extra', null],
    ]);
    expect(body.plan.coverage).toEqual([]);
  });

  it('marks a file that has a library file, and a replace only on request', async () => {
    t = await startImportTest();
    t.addFile(E01, 'old', [{ season: 1, number: 1 }]);
    t.write(t.inbox, { 'Show.Name.S01E01.mkv': 'new data' });
    const kept = (await preview(t.inbox)).body.plan;
    expect(kept.files[0]).toMatchObject({ status: 'exists', replaces: E01 });
    expect(kept.importable).toBe(0);
    const replaced = (await preview(t.inbox, { replace: true })).body.plan;
    expect(replaced.files[0]).toMatchObject({ status: 'replace', replaces: E01 });
    expect(replaced.coverage).toEqual([{ season: 1, total: 3, covered: 1, missing: [2, 3] }]);
  });

  it('refuses a request that is not valid', async () => {
    t = await startImportTest();
    const file = join(t.inbox, 'a.txt');
    writeFileSync(file, 'x');
    mkdirSync(join(t.pipe.dir, '.ladarr-hidden'));
    const cases: [Record<string, unknown>, number, string][] = [
      [{ titleKey: 'tv:99', path: t.inbox }, 404, 'title_not_found'],
      [{ titleKey: 'tv:1', path: 'inbox' }, 400, 'path_not_absolute'],
      [{ titleKey: 'tv:1' }, 400, 'path_not_absolute'],
      [{ titleKey: 'tv:1', path: join(t.pipe.dir, 'nope') }, 404, 'folder_not_found'],
      [{ titleKey: 'tv:1', path: file }, 400, 'not_a_folder'],
      [{ titleKey: 'tv:1', path: '/' }, 400, 'folder_too_broad'],
      // The folder holds the library folders.
      [{ titleKey: 'tv:1', path: t.pipe.dir }, 400, 'folder_has_library'],
      [{ titleKey: 'tv:1', path: join(t.pipe.dir, '.ladarr-hidden') }, 400, 'folder_not_allowed'],
    ];
    for (const [body, status, error] of cases) {
      for (const route of ['/import/folder/preview', '/import/folder']) {
        const answer = await t.api.post(route, body);
        expect([answer.status, answer.body.error]).toEqual([status, error]);
      }
    }
    expect(t.pipe.db.data.imports).toEqual({});
  });

  it('does not follow a link to a folder, and does not list a link to a file', async () => {
    t = await startImportTest();
    const outside = join(t.pipe.dir, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'Show.Name.S01E03.mkv'), 'secret');
    symlinkSync(outside, join(t.inbox, 'linked'));
    symlinkSync(join(outside, 'Show.Name.S01E03.mkv'), join(t.inbox, 'Show.Name.S01E03.mkv'));
    t.write(t.inbox, { 'Show.Name.S01E01.mkv': 'one' });
    expect((await preview(t.inbox)).body.plan.files.map((f: { rel: string }) => f.rel)).toEqual(['Show.Name.S01E01.mkv']);
  });
});

describe('import', () => {
  it('imports with hard links, keeps the source, and reports the run', async () => {
    t = await startImportTest();
    t.write(t.inbox, { 'Show.Name.S01E01.mkv': 'one', 'Show.Name.S01E02.mkv': 'two', 'readme.mkv': 'x' });
    const started = await importFolder(t.inbox);
    expect(started.status).toBe(202);
    expect(started.body.total).toBe(2);
    await t.finished(started.body.id);

    const tv = t.pipe.folders.tv;
    expect(readFileSync(join(tv, E01), 'utf8')).toBe('one');
    expect(readFileSync(join(tv, E02), 'utf8')).toBe('two');
    // A hard link: the source is the same file, and it is untouched.
    expect(statSync(join(tv, E01)).ino).toBe(statSync(join(t.inbox, 'Show.Name.S01E01.mkv')).ino);
    expect(t.tree(t.inbox).sort()).toEqual(['Show.Name.S01E01.mkv', 'Show.Name.S01E02.mkv', 'readme.mkv']);
    // No staged file stays.
    expect(t.tree(tv).sort()).toEqual([E01, E02]);

    const files = Object.values(t.pipe.db.data.files);
    expect(files.map((f) => f.path).sort()).toEqual([E01, E02]);
    expect(t.show.episodes.map((e) => Boolean(e.fileId))).toEqual([true, true, false]);
    expect(t.pipe.db.data.imports).toEqual({});
    const run = await t.api.get(`/import/runs/${started.body.id}`);
    expect(run.body.run).toMatchObject({ kind: 'import', titleKey: 'tv:1', total: 2, done: 2, problems: [], finished: true });
    expect(run.body.steps).toEqual([]);
    expect(t.pipe.published.some((event) => event.type === 'library.changed')).toBe(true);

    // A second preview sees that the files are in the library already.
    const again = (await preview(t.inbox)).body.plan;
    expect(again.files.filter((f: { status: string }) => f.status === 'in_place')).toHaveLength(2);
    expect((await importFolder(t.inbox)).body.error).toBe('nothing_to_import');
  });

  it('copies when a hard link is not possible, and leaves the source as it is', async () => {
    t = await startImportTest({ fs: { link: noLink('EXDEV') } });
    t.write(t.inbox, { 'Show.Name.S01E01.mkv': 'one' });
    const started = await importFolder(t.inbox);
    await t.finished(started.body.id);
    expect(readFileSync(join(t.pipe.folders.tv, E01), 'utf8')).toBe('one');
    expect(statSync(join(t.pipe.folders.tv, E01)).ino).not.toBe(statSync(join(t.inbox, 'Show.Name.S01E01.mkv')).ino);
    expect(readFileSync(join(t.inbox, 'Show.Name.S01E01.mkv'), 'utf8')).toBe('one');
    expect(t.tree(t.pipe.folders.tv)).toEqual([E01]);
  });

  it('blocks a file that ffprobe can not read, and imports the others', async () => {
    t = await startImportTest({ probe: async (path) => (path.includes('E02') ? { ok: false, reason: 'unreadable' } : { ok: true, durationSeconds: 60, container: 'matroska', videoCodec: 'h264', audioLanguages: [] }) });
    t.write(t.inbox, { 'Show.Name.S01E01.mkv': 'one', 'Show.Name.S01E02.mkv': 'broken' });
    const started = await importFolder(t.inbox);
    await t.finished(started.body.id);
    expect(t.tree(t.pipe.folders.tv)).toEqual([E01]);
    expect(t.pipe.importStatus.run(started.body.id)).toMatchObject({ total: 2, done: 1, problems: [{ file: 'Show.Name.S01E02.mkv', code: 'file_unreadable' }] });
    expect(t.pipe.db.data.files).not.toHaveProperty('broken');
    expect(t.show.episodes[1]!.fileId).toBeNull();
  });

  it.each([
    ['ENOSPC', 'disk_full'],
    ['EACCES', 'permission_denied'],
  ])('leaves the library as it is when the copy fails with %s', async (code, reason) => {
    t = await startImportTest({
      fs: {
        link: noLink('EXDEV'),
        copyFile: async () => {
          throw Object.assign(new Error('copy'), { code });
        },
      },
    });
    t.write(t.inbox, { 'Show.Name.S01E01.mkv': 'one' });
    const started = await importFolder(t.inbox);
    await t.finished(started.body.id);
    expect(t.pipe.importStatus.run(started.body.id)!.problems).toMatchObject([{ code: reason }]);
    expect(readdirSync(join(t.pipe.folders.tv, 'Show Name (2020)', 'Season 01'))).toEqual([]);
    expect(Object.values(t.pipe.db.data.files)).toHaveLength(0);
    expect(readFileSync(join(t.inbox, 'Show.Name.S01E01.mkv'), 'utf8')).toBe('one');
  });

  it('does not replace a file that the library does not know', async () => {
    t = await startImportTest();
    mkdirSync(join(t.pipe.folders.tv, 'Show Name (2020)', 'Season 01'), { recursive: true });
    writeFileSync(join(t.pipe.folders.tv, E01), 'someone else');
    t.write(t.inbox, { 'Show.Name.S01E01.mkv': 'one', 'Show.Name.S01E02.mkv': 'two' });
    const plan = (await preview(t.inbox, { replace: true })).body.plan;
    expect(plan.files.map((f: { status: string; reason: string | null }) => [f.status, f.reason])).toEqual([['blocked', 'destination_exists'], ['new', null]]);
    const started = await importFolder(t.inbox, { replace: true });
    await t.finished(started.body.id);
    expect(readFileSync(join(t.pipe.folders.tv, E01), 'utf8')).toBe('someone else');
    expect(readFileSync(join(t.pipe.folders.tv, E02), 'utf8')).toBe('two');
    expect(t.show.episodes[0]!.fileId).toBeNull();
  });

  it('refuses a replace that would leave an episode without its file', async () => {
    t = await startImportTest();
    t.addFile('Show Name (2020)/Season 01/Show Name - S01E01E02.mkv', 'old pair', [{ season: 1, number: 1 }, { season: 1, number: 2 }]);
    t.write(t.inbox, { 'Show.Name.S01E01.mkv': 'one' });
    const plan = (await preview(t.inbox, { replace: true })).body.plan;
    expect(plan.files[0]).toMatchObject({ status: 'blocked', reason: 'partial_overlap' });
    expect((await importFolder(t.inbox, { replace: true })).body.error).toBe('nothing_to_import');
  });

  it('deletes the old file when it replaces a file of the same name', async () => {
    t = await startImportTest();
    t.addFile(E01, 'old', [{ season: 1, number: 1 }]);
    const id = t.show.episodes[0]!.fileId!;
    t.write(t.inbox, { 'Show.Name.S01E01.mkv': 'new data' });
    const started = await importFolder(t.inbox, { replace: true });
    await t.finished(started.body.id);
    expect(readFileSync(join(t.pipe.folders.tv, E01), 'utf8')).toBe('new data');
    // The record of the name stays, and it has the size of the new file.
    expect(t.show.episodes[0]!.fileId).toBe(id);
    expect(t.pipe.db.data.files[id]).toMatchObject({ path: E01, sizeBytes: 8 });
    expect(existsSync(join(t.pipe.folders.tv, '.ladarr-recovery'))).toBe(false);
  });

  it('deletes the old file when the new name is another name', async () => {
    t = await startImportTest();
    // The library has the file under a name from an older template.
    t.addFile('Show Name (2020)/Season 01/old name.mkv', 'old', [{ season: 1, number: 1 }]);
    t.write(t.inbox, { 'Show.Name.S01E01.mkv': 'new data' });
    const started = await importFolder(t.inbox, { replace: true });
    await t.finished(started.body.id);
    expect(readFileSync(join(t.pipe.folders.tv, E01), 'utf8')).toBe('new data');
    expect(existsSync(join(t.pipe.folders.tv, 'Show Name (2020)/Season 01/old name.mkv'))).toBe(false);
    expect(existsSync(join(t.pipe.folders.tv, '.ladarr-recovery'))).toBe(false);
    expect(Object.values(t.pipe.db.data.files).map((file) => file.path)).toEqual([E01]);
  });

  it('adds the record of a file that is at its destination already, and keeps the data', async () => {
    t = await startImportTest();
    // The library folder has the file at its canonical path. The library has no record of it.
    t.write(t.pipe.folders.tv, { [E01]: 'one' });
    const season = join(t.pipe.folders.tv, 'Show Name (2020)', 'Season 01');
    const inode = statSync(join(t.pipe.folders.tv, E01)).ino;
    const plan = (await preview(season)).body.plan;
    expect(plan.files[0]).toMatchObject({ status: 'register', dest: E01, replaces: null });
    expect(plan.importable).toBe(1);
    expect(plan.coverage).toEqual([{ season: 1, total: 3, covered: 1, missing: [2, 3] }]);
    const started = await importFolder(season);
    await t.finished(started.body.id);
    expect(Object.values(t.pipe.db.data.files)).toMatchObject([{ path: E01, titleKey: 'tv:1', episodes: [{ season: 1, number: 1 }] }]);
    expect(t.show.episodes[0]!.fileId).toBe(Object.keys(t.pipe.db.data.files)[0]);
    expect(statSync(join(t.pipe.folders.tv, E01)).ino).toBe(inode);
    expect(readFileSync(join(t.pipe.folders.tv, E01), 'utf8')).toBe('one');
    expect(t.tree(t.pipe.folders.tv)).toEqual([E01]);
    // The file has a record now, so it is in place.
    expect((await preview(season)).body.plan.files[0].status).toBe('in_place');
  });

  it('does not move the library file that it reads as a source', async () => {
    t = await startImportTest();
    // The folder to read is in the library, and its file is the file of the episode under another name.
    t.addFile(`${SEASON_DIR}/Show.Name.S01E01.mkv`, 'one', [{ season: 1, number: 1 }]);
    const season = join(t.pipe.folders.tv, SEASON_DIR);
    expect((await preview(season)).body.plan.files[0]).toMatchObject({ status: 'exists' });
    const plan = (await preview(season, { replace: true })).body.plan;
    expect(plan.files[0]).toMatchObject({ status: 'blocked', reason: 'source_is_library_file' });
    expect((await importFolder(season, { replace: true })).body.error).toBe('nothing_to_import');
    expect(t.tree(t.pipe.folders.tv)).toEqual([`${SEASON_DIR}/Show.Name.S01E01.mkv`]);
  });

  it('completes the targets that wait for the file, and keeps the targets that have a download', async () => {
    t = await startImportTest();
    const queue = t.pipe.queue;
    t.show.episodes.push(episode(1, 4, '2020-01-04'), episode(1, 5, '2020-01-05'));
    const [waiting, loading, paused, attention, blocked] = [1, 2, 3, 4, 5].map((n) => {
      const entry = queue.ensure('tv:1', 1, n);
      queue.request(entry, 'test');
      return entry;
    });
    queue.move(waiting!, { branch: 'waiting' }, 'no release');
    queue.move(loading!, { stage: 'downloading' }, 'client has it');
    loading!.transferHash = 'a'.repeat(40);
    queue.move(paused!, { branch: 'paused' }, 'paused');
    queue.move(attention!, { stage: 'validating', reason: { code: 'file_not_found' } }, 'no file');
    // A download import that met a full disk leaves the target in Importing with a block.
    queue.move(blocked!, { stage: 'importing', reason: { code: 'disk_full' } }, 'import blocked');
    t.write(t.inbox, { 'Show.Name.S01E01.mkv': 'one', 'Show.Name.S01E02.mkv': 'two', 'Show.Name.S01E03.mkv': 'three', 'Show.Name.S01E04.mkv': 'four', 'Show.Name.S01E05.mkv': 'five' });
    const started = await importFolder(t.inbox);
    await t.finished(started.body.id);

    expect(waiting).toMatchObject({ stage: 'available', branch: null, reason: null, importResult: { ok: true, method: 'hardlink', path: E01 } });
    expect(waiting!.attempts.at(-1)).toMatchObject({ outcome: 'imported' });
    expect(waiting!.history.at(-1)).toMatchObject({ cause: 'imported by hand' });
    expect(attention).toMatchObject({ stage: 'available', branch: null, reason: null });
    expect(blocked).toMatchObject({ stage: 'available', branch: null, reason: null });
    // A download in work and a pause are the choice of the user.
    expect(loading).toMatchObject({ stage: 'downloading', branch: null, transferHash: 'a'.repeat(40) });
    expect(paused).toMatchObject({ stage: 'queued', branch: 'paused' });
    expect(Object.values(t.pipe.db.data.files)).toHaveLength(5);
  });

  it('does not undo a target that it settled while the search of the target runs', async () => {
    t = await startImportTest();
    const [entry] = t.pipe.finder.requestSearch('tv:1', { season: 1, number: 1 });
    // The indexer answers after the import: the answer has no release.
    t.pipe.tracker.state.answer = () => {
      t!.pipe.queue.move(entry!, { stage: 'available', branch: null, reason: null }, 'imported by hand');
      return [];
    };
    await until(() => t!.pipe.tracker.state.searches.length > 0);
    await sleep(200);
    expect(entry).toMatchObject({ stage: 'available', branch: null });
    expect(entry!.history.at(-1)!.cause).toBe('imported by hand');
  });

  it('waits for an open manual import or rename before it imports a download for the title', async () => {
    t = await startImportTest();
    const film = movie({ rootId: 'movie', manualRelease: true });
    t.pipe.db.data.titles[film.key] = film;
    const name = 'Movie.Name.2019.1080p.BluRay-GRP';
    t.pipe.tracker.state.items = [{ title: name, size: 100 * 120 * MIB }];
    const [entry] = t.pipe.finder.requestSearch(film.key);
    await until(() => entry!.stage === 'downloading');
    t.pipe.db.data.imports.busy = { id: 'busy', hash: 'rename:busy', titleKey: film.key, steps: [], createdAt: 0, kind: 'rename', sourceBase: t.pipe.folders.movies };
    t.pipe.complete(name, { [`${name}.mkv`]: 'video-data' });
    await sleep(300);
    // The target is not blocked. It waits.
    expect(entry).toMatchObject({ stage: 'validating', branch: null, reason: null });
    delete t.pipe.db.data.imports.busy;
    await until(() => entry!.stage === 'available');
  });

  it('does not start a second journal for a title that has one', async () => {
    t = await startImportTest();
    t.pipe.db.data.imports.other = { id: 'other', hash: 'abc', titleKey: 'tv:1', steps: [], createdAt: 0 };
    t.write(t.inbox, { 'Show.Name.S01E01.mkv': 'one' });
    const refused = await importFolder(t.inbox);
    expect([refused.status, refused.body.error]).toEqual([409, 'title_busy']);
  });

  it('does not run on a root that is not the accepted disk', async () => {
    t = await startImportTest();
    t.pipe.db.data.roots.tv!.dev += 1;
    t.write(t.inbox, { 'Show.Name.S01E01.mkv': 'one' });
    const refused = await importFolder(t.inbox);
    expect([refused.status, refused.body.error]).toEqual([409, 'root_unavailable']);
  });

  it('ends a journal when the title left the library', async () => {
    let armed = true;
    t = await startImportTest({
      afterStep: (state) => {
        if (armed && state === 'staged') {
          armed = false;
          throw new Error('stop');
        }
      },
    });
    t.write(t.inbox, { 'Show.Name.S01E01.mkv': 'one' });
    const started = await importFolder(t.inbox);
    await until(() => !armed);
    await sleep(50);
    delete t.pipe.db.data.titles['tv:1'];
    const hash = t.pipe.db.data.imports[started.body.id]!.hash;
    t.pipe.worker.enqueue({ type: 'import.run', payload: { hash }, dedupeKey: `import:${hash}` });
    await t.finished(started.body.id);
    expect(t.pipe.db.data.imports).toEqual({});
  });
});

describe('interruption', () => {
  it('runs a journal again when its job is gone', async () => {
    t = await startImportTest();
    t.write(t.inbox, { 'Show.Name.S01E01.mkv': 'one' });
    const id = 'cccccccc-0000-0000-0000-000000000000';
    t.pipe.db.data.imports[id] = {
      id,
      hash: `manual:${id}`,
      titleKey: 'tv:1',
      createdAt: 0,
      sourceBase: t.inbox,
      steps: [{ entryIds: [], source: 'Show.Name.S01E01.mkv', dest: E01, replaces: null, state: 'planned', method: null, sizeBytes: 3, episodes: [{ season: 1, number: 1 }], validation: 'basic' }],
    };
    t.pipe.importStatus.begin(id, 'import', 'tv:1', 1);
    // The journal is open and no job runs it. The title is busy.
    expect((await importFolder(t.inbox)).body.error).toBe('title_busy');
    const handler = importResumeHandler();
    await handler.run({} as Job, { signal: new AbortController().signal });
    await t.finished(id);
    expect(readFileSync(join(t.pipe.folders.tv, E01), 'utf8')).toBe('one');
    // The next run finds no open journal and asks for nothing.
    const before = Object.keys(t.pipe.db.data.jobs).length;
    await handler.run({} as Job, { signal: new AbortController().signal });
    expect(Object.keys(t.pipe.db.data.jobs).length).toBe(before);
  });

  // Every step of the journal: stop the import after the step, run it again, and check the result.
  describe.each([
    ['hard link', undefined],
    ['copy', { link: noLink('EXDEV') }],
  ] as const)('with a %s', (_name, fs) => {
    it.each(['staged', 'published', 'committed', 'retired'] as const)('finishes an import that stopped after %s', async (stopAfter) => {
      let armed = true;
      t = await startImportTest({
        fs,
        afterStep: (state) => {
          if (armed && state === stopAfter) {
            armed = false;
            throw new Error('stop');
          }
        },
      });
      t.write(t.inbox, { 'Show.Name.S01E01.mkv': 'one' });
      const started = await importFolder(t.inbox);
      await until(() => !armed);
      await sleep(50);
      // The journal is what remembers the work.
      const journal = t.pipe.db.data.imports[started.body.id]!;
      expect(journal.hash).toBe(`manual:${started.body.id}`);
      t.pipe.worker.enqueue({ type: 'import.run', payload: { hash: journal.hash }, dedupeKey: `import:${journal.hash}` });
      await t.finished(started.body.id);

      expect(readFileSync(join(t.pipe.folders.tv, E01), 'utf8')).toBe('one');
      expect(Object.values(t.pipe.db.data.files)).toHaveLength(1);
      expect(t.show.episodes[0]!.fileId).toBe(Object.values(t.pipe.db.data.files)[0]!.id);
      expect(t.pipe.db.data.imports).toEqual({});
      // No staged file stays in the folder, and the source is the same as before.
      expect(t.tree(t.pipe.folders.tv)).toEqual([E01]);
      expect(lstatSync(join(t.inbox, 'Show.Name.S01E01.mkv')).isFile()).toBe(true);
      expect(readFileSync(join(t.inbox, 'Show.Name.S01E01.mkv'), 'utf8')).toBe('one');
    }, 20_000);
  });

  it('starts a copy again when the process stopped in the middle of it', async () => {
    t = await startImportTest({ fs: { link: noLink('EXDEV') } });
    t.write(t.inbox, { 'Show.Name.S01E01.mkv': 'complete data' });
    // The state that a stop in the middle of a copy leaves: a journal at "planned" and half a staged file.
    const id = 'aaaaaaaa-0000-0000-0000-000000000000';
    t.pipe.db.data.imports[id] = {
      id,
      hash: `manual:${id}`,
      titleKey: 'tv:1',
      createdAt: 0,
      sourceBase: t.inbox,
      steps: [{ entryIds: [], source: 'Show.Name.S01E01.mkv', dest: E01, replaces: null, state: 'planned', method: null, sizeBytes: 13, episodes: [{ season: 1, number: 1 }], validation: 'basic' }],
    };
    const folder = join(t.pipe.folders.tv, 'Show Name (2020)', 'Season 01');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, '.ladarr-aaaaaaaa-Show Name - S01E01 - Episode 1.mkv'), 'compl');
    t.pipe.importStatus.begin(id, 'import', 'tv:1', 1);
    t.pipe.worker.enqueue({ type: 'import.run', payload: { hash: `manual:${id}` }, dedupeKey: `import:manual:${id}` });
    await t.finished(id);
    expect(readFileSync(join(t.pipe.folders.tv, E01), 'utf8')).toBe('complete data');
    expect(t.tree(t.pipe.folders.tv)).toEqual([E01]);
  });

  it('does not import a file that changed size after the plan', async () => {
    t = await startImportTest({ fs: { link: noLink('EXDEV') } });
    t.write(t.inbox, { 'Show.Name.S01E01.mkv': 'one' });
    const id = 'bbbbbbbb-0000-0000-0000-000000000000';
    t.pipe.db.data.imports[id] = {
      id,
      hash: `manual:${id}`,
      titleKey: 'tv:1',
      createdAt: 0,
      sourceBase: t.inbox,
      // The plan saw 99 bytes. The file has 3 now.
      steps: [{ entryIds: [], source: 'Show.Name.S01E01.mkv', dest: E01, replaces: null, state: 'planned', method: null, sizeBytes: 99, episodes: [{ season: 1, number: 1 }], validation: 'basic' }],
    };
    t.pipe.importStatus.begin(id, 'import', 'tv:1', 1);
    t.pipe.worker.enqueue({ type: 'import.run', payload: { hash: `manual:${id}` }, dedupeKey: `import:manual:${id}` });
    await t.finished(id);
    expect(t.pipe.importStatus.run(id)!.problems).toMatchObject([{ code: 'copy_incomplete' }]);
    expect(existsSync(join(t.pipe.folders.tv, E01))).toBe(false);
    expect(t.tree(t.pipe.folders.tv)).toEqual([]);
  });
});

describe('a source folder that can not be read', () => {
  // A user who is root can read every folder, so the check has no meaning there.
  it.skipIf(process.getuid?.() === 0)('refuses the folder and changes nothing', async () => {
    t = await startImportTest();
    t.write(t.inbox, { 'locked/Show.Name.S01E01.mkv': 'one' });
    chmodSync(join(t.inbox, 'locked'), 0o000);
    try {
      const answer = await preview(t.inbox);
      expect([answer.status, answer.body.error]).toEqual([400, 'folder_not_readable']);
    } finally {
      chmodSync(join(t.inbox, 'locked'), 0o755);
    }
    expect(t.pipe.db.data.imports).toEqual({});
  });
});
