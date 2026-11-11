import { existsSync, linkSync, lstatSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanTitle } from '../../src/library/scan.ts';
import { episode, movie } from '../helpers/test-fixtures.ts';
import { noLink, sleep, startImportTest } from '../helpers/test-import.ts';
import { until } from '../helpers/test-pipeline.ts';

let t: Awaited<ReturnType<typeof startImportTest>> | undefined;
afterEach(async () => {
  await t?.stop();
  t = undefined;
});

const SEASON = 'Show Name (2020)/Season 01';
const OLD = `${SEASON}/Show Name - S01E01 - Episode 1.mkv`;
const NEW = `${SEASON}/Show Name - S01E01 - Pilot.mkv`;

const preview = (body: Record<string, unknown> = {}) => t!.api.post('/rename/preview', { titleKey: 'tv:1', ...body });
const apply = () => t!.api.post('/rename/apply', { titleKey: 'tv:1' });

// A title whose first episode has a new name at TMDB, and whose file has the old name.
async function renamed() {
  t = await startImportTest();
  const id = t.addFile(OLD, 'video data', [{ season: 1, number: 1 }]);
  t.show.episodes[0]!.name = 'Pilot';
  // The seeding source of the file: a second name for the same data.
  const seed = join(t.pipe.folders.downloads, 'seed.mkv');
  linkSync(join(t.pipe.folders.tv, OLD), seed);
  return { id, seed };
}

describe('rename preview', () => {
  it('shows the new name after a metadata change, and changes nothing', async () => {
    await renamed();
    t!.addFile(`${SEASON}/Show Name - S01E02 - Episode 2.mkv`, 'two', [{ season: 1, number: 2 }]);
    const before = t!.tree(t!.pipe.folders.tv);
    const { status, body } = await preview();
    expect(status).toBe(200);
    expect(body.rows).toEqual([
      { fileId: 'file-1', from: OLD, to: NEW, status: 'rename', reason: null },
      { fileId: 'file-2', from: `${SEASON}/Show Name - S01E02 - Episode 2.mkv`, to: `${SEASON}/Show Name - S01E02 - Episode 2.mkv`, status: 'unchanged', reason: null },
    ]);
    expect(body.counts).toEqual({ rename: 1, blocked: 0 });
    expect(t!.tree(t!.pipe.folders.tv)).toEqual(before);
    expect(t!.pipe.db.data.imports).toEqual({});
    expect(Object.values(t!.pipe.db.data.jobs).filter((job) => job.type === 'import.run')).toEqual([]);
  });

  it('uses templates that are not saved yet, and refuses a template that is not valid', async () => {
    await renamed();
    const rows = (await preview({ movie: '{title}', episode: '{title} S{season}E{episode}' })).body.rows;
    expect(rows[0]).toMatchObject({ from: OLD, to: `${SEASON}/Show Name S01E01.mkv`, status: 'rename' });
    // The saved templates did not change.
    expect(t!.pipe.db.data.settings.naming.episode).toBe('{title} - S{season}E{episode} - {episodeTitle}');
    for (const bad of [{ movie: '{title}', episode: '../{title} {season}{episode}' }, { movie: '{title}', episode: '{title}' }, { movie: '{year}', episode: '{title} S{season}E{episode}' }, { movie: '{title}', episode: '{title} {season}x{episode}' }]) {
      const refused = await preview(bad);
      expect([refused.status, refused.body.error]).toEqual([400, 'invalid_template']);
    }
  });

  it('shows a sample name for each template', async () => {
    t = await startImportTest();
    expect((await t.api.post('/rename/examples', { movie: '{title} [{year}]', episode: '{title} S{season}E{episode}' })).body).toEqual({
      problems: { movie: null, episode: null },
      examples: { movie: 'Movie Name [2019]', episode: 'Show Name S01E02' },
    });
    expect((await t.api.post('/rename/examples', { movie: '{title}/x', episode: '{title}' })).body).toEqual({ problems: { movie: 'template_separator', episode: 'template_missing_token' }, examples: null });
  });

  it('lists the titles that new templates change', async () => {
    await renamed();
    const film = movie({ rootId: 'movie', folder: 'Movie Name (2019)', fileId: 'film-file' });
    t!.pipe.db.data.titles[film.key] = film;
    t!.write(t!.pipe.folders.movies, { 'Movie Name (2019)/Movie Name (2019).mkv': 'film' });
    t!.pipe.db.data.files['film-file'] = { id: 'film-file', titleKey: film.key, path: 'Movie Name (2019)/Movie Name (2019).mkv', sizeBytes: 4, mtimeMs: 0, episodes: [], missing: false, addedAt: 0 };
    const answer = await t!.api.post('/rename/overview', { movie: '{title} [{year}]', episode: '{title} - S{season}E{episode} - {episodeTitle}' });
    expect(answer.body).toEqual({
      titles: [
        { titleKey: 'movie:2', title: 'Movie Name', year: 2019, rename: 1, blocked: 0 },
        { titleKey: 'tv:1', title: 'Show Name', year: 2020, rename: 1, blocked: 0 },
      ],
      total: 2,
    });
    // The saved templates change the series only.
    expect((await t!.api.post('/rename/overview', {})).body.titles.map((item: { titleKey: string }) => item.titleKey)).toEqual(['tv:1']);
  });

  it('blocks a name that is taken, a file that is gone, and a name for two files', async () => {
    await renamed();
    // The new name is a file that the library does not know.
    writeFileSync(join(t!.pipe.folders.tv, NEW), 'someone else');
    // A file that the record has and the disk has not.
    t!.addFile(`${SEASON}/gone.mkv`, 'x', [{ season: 1, number: 2 }]);
    unlinkSync(join(t!.pipe.folders.tv, `${SEASON}/gone.mkv`));
    // Two files for one episode get one name.
    t!.addFile(`${SEASON}/a.mkv`, 'a', [{ season: 1, number: 3 }]);
    t!.addFile(`${SEASON}/b.mkv`, 'b', [{ season: 1, number: 3 }]);
    // An episode that the title does not have now.
    t!.addFile(`${SEASON}/lost.mkv`, 'l', [{ season: 1, number: 9 }]);
    // A link is not renamed.
    writeFileSync(join(t!.pipe.dir, 'target.mkv'), 't');
    symlinkSync(join(t!.pipe.dir, 'target.mkv'), join(t!.pipe.folders.tv, `${SEASON}/link.mkv`));
    t!.show.episodes.push(episode(1, 4, '2020-01-04'));
    t!.pipe.db.data.files['file-link'] = { id: 'file-link', titleKey: 'tv:1', path: `${SEASON}/link.mkv`, sizeBytes: 1, mtimeMs: 0, episodes: [{ season: 1, number: 4 }], missing: false, addedAt: 0 };

    const { rows } = (await preview()).body;
    const byFrom = Object.fromEntries(rows.map((row: { from: string; status: string; reason: string | null }) => [row.from.split('/').pop(), [row.status, row.reason]]));
    expect(byFrom).toEqual({
      'Show Name - S01E01 - Episode 1.mkv': ['blocked', 'destination_exists'],
      'gone.mkv': ['blocked', 'file_missing'],
      'a.mkv': ['blocked', 'name_collision'],
      'b.mkv': ['blocked', 'name_collision'],
      'lost.mkv': ['blocked', 'episode_unknown'],
      'link.mkv': ['blocked', 'not_a_regular_file'],
    });
    const refused = await apply();
    expect([refused.status, refused.body.error]).toEqual([409, 'nothing_to_rename']);
    expect(readFileSync(join(t!.pipe.folders.tv, NEW), 'utf8')).toBe('someone else');
    expect(existsSync(join(t!.pipe.folders.tv, OLD))).toBe(true);
  });

  it('refuses a name that another record of the library has', async () => {
    await renamed();
    // A record for the new name. The file is gone, but the record stays until the user removes it.
    t!.pipe.db.data.files.old = { id: 'old', titleKey: 'tv:1', path: NEW, sizeBytes: 1, mtimeMs: 0, episodes: [{ season: 1, number: 2 }], missing: true, addedAt: 0 };
    expect((await preview()).body.rows[0]).toMatchObject({ status: 'blocked', reason: 'destination_exists' });
  });

  it('refuses a request for a root that is not the accepted disk', async () => {
    await renamed();
    t!.pipe.db.data.roots.tv!.dev += 1;
    const refused = await preview();
    expect([refused.status, refused.body.error]).toEqual([409, 'root_unavailable']);
    expect((await t!.api.post('/rename/preview', { titleKey: 'tv:99' })).status).toBe(404);
  });
});

describe('rename', () => {
  it('renames with the same data, keeps the record, and keeps the other names of the file', async () => {
    const { id, seed } = await renamed();
    const started = await apply();
    expect(started.status).toBe(202);
    await t!.finished(started.body.id);

    const tv = t!.pipe.folders.tv;
    expect(t!.tree(tv)).toEqual([NEW]);
    expect(readFileSync(join(tv, NEW), 'utf8')).toBe('video data');
    // The record of the file is the same record, with the new path.
    expect(t!.pipe.db.data.files[id]).toMatchObject({ path: NEW, sizeBytes: 10, missing: false });
    expect(Object.keys(t!.pipe.db.data.files)).toEqual([id]);
    expect(t!.show.episodes[0]!.fileId).toBe(id);
    // The seeding source is the same data, and it is untouched.
    expect(statSync(seed).ino).toBe(statSync(join(tv, NEW)).ino);
    expect(readFileSync(seed, 'utf8')).toBe('video data');
    expect(t!.pipe.db.data.imports).toEqual({});
    expect(t!.pipe.importStatus.run(started.body.id)).toMatchObject({ kind: 'rename', total: 1, done: 1, problems: [], finished: true });
    expect((await preview()).body.counts).toEqual({ rename: 0, blocked: 0 });
  });

  it('renames a file for several episodes and a movie, and moves a file to the folder of its season', async () => {
    t = await startImportTest();
    t.addFile('Show/S1/ep1+2.mkv', 'pair', [{ season: 1, number: 1 }, { season: 1, number: 2 }]);
    t.show.folder = 'Show';
    const film = movie({ rootId: 'movie', folder: 'Movie Name (2019)', fileId: 'film-file' });
    t.pipe.db.data.titles[film.key] = film;
    t.write(t.pipe.folders.movies, { 'Movie Name (2019)/old.mkv': 'film' });
    t.pipe.db.data.files['film-file'] = { id: 'film-file', titleKey: film.key, path: 'Movie Name (2019)/old.mkv', sizeBytes: 4, mtimeMs: 0, episodes: [], missing: false, addedAt: 0 };

    const series = await apply();
    const filmRun = await t.api.post('/rename/apply', { titleKey: film.key });
    await t.finished(series.body.id);
    await t.finished(filmRun.body.id);
    expect(t.tree(t.pipe.folders.tv)).toEqual(['Show/Season 01/Show Name - S01E01E02.mkv']);
    expect(t.tree(t.pipe.folders.movies)).toEqual(['Movie Name (2019)/Movie Name (2019).mkv']);
    expect(t.pipe.db.data.files['film-file']!.path).toBe('Movie Name (2019)/Movie Name (2019).mkv');
  });

  it('does not rename when a hard link is not possible', async () => {
    t = await startImportTest({ fs: { link: noLink('EXDEV') } });
    t.addFile(OLD, 'video data', [{ season: 1, number: 1 }]);
    t.show.episodes[0]!.name = 'Pilot';
    const started = await apply();
    await t.finished(started.body.id);
    // A copy of a big file is not a rename, so the file keeps its name.
    expect(t.pipe.importStatus.run(started.body.id)!.problems).toMatchObject([{ file: OLD, code: 'hard_link_unavailable' }]);
    expect(t.tree(t.pipe.folders.tv)).toEqual([OLD]);
    expect(t.pipe.db.data.files['file-1']!.path).toBe(OLD);
  });

  it('keeps the file when the new name is taken after the plan', async () => {
    let taken = '';
    t = await startImportTest({
      afterStep: (state) => {
        // Someone makes the file between the plan and the publication.
        if (state === 'staged') writeFileSync(taken, 'someone else');
      },
    });
    taken = join(t.pipe.folders.tv, NEW);
    t.addFile(OLD, 'video data', [{ season: 1, number: 1 }]);
    t.show.episodes[0]!.name = 'Pilot';
    const started = await apply();
    await t.finished(started.body.id);
    expect(t.pipe.importStatus.run(started.body.id)!.problems).toMatchObject([{ code: 'destination_exists' }]);
    expect(readFileSync(taken, 'utf8')).toBe('someone else');
    expect(readFileSync(join(t.pipe.folders.tv, OLD), 'utf8')).toBe('video data');
    expect(t.tree(t.pipe.folders.tv).sort()).toEqual([NEW, OLD].sort());
    expect(t.pipe.db.data.files['file-1']!.path).toBe(OLD);
  });

  it('works for letter case on every file system without a loss', async () => {
    t = await startImportTest();
    t.addFile(`${SEASON}/Show Name - S01E01 - the pilot.mkv`, 'video data', [{ season: 1, number: 1 }]);
    t.show.episodes[0]!.name = 'The Pilot';
    const caseBlind = existsSync(join(t.pipe.folders.tv, SEASON, 'SHOW NAME - S01E01 - THE PILOT.MKV'));
    const rows = (await preview()).body.rows;
    if (caseBlind) {
      // The new name is the old file for this file system. It is a name that is taken.
      expect(rows[0]).toMatchObject({ status: 'blocked', reason: 'destination_exists' });
    } else {
      const started = await apply();
      await t.finished(started.body.id);
    }
    expect(t.tree(t.pipe.folders.tv)).toHaveLength(1);
    const [only] = t.tree(t.pipe.folders.tv);
    expect(readFileSync(join(t.pipe.folders.tv, only!), 'utf8')).toBe('video data');
    expect(t.pipe.db.data.files['file-1']!.path).toBe(only);
  });
});

describe('interruption', () => {
  it.each(['staged', 'published', 'committed', 'retired'] as const)('finishes a rename that stopped after %s', async (stopAfter) => {
    let armed = true;
    t = await startImportTest({
      afterStep: (state) => {
        if (armed && state === stopAfter) {
          armed = false;
          throw new Error('stop');
        }
      },
    });
    const id = t.addFile(OLD, 'video data', [{ season: 1, number: 1 }]);
    t.show.episodes[0]!.name = 'Pilot';
    const seed = join(t.pipe.folders.downloads, 'seed.mkv');
    linkSync(join(t.pipe.folders.tv, OLD), seed);

    const started = await apply();
    await until(() => !armed);
    await sleep(50);
    const journal = t.pipe.db.data.imports[started.body.id]!;
    expect(journal).toMatchObject({ kind: 'rename', hash: `rename:${started.body.id}` });
    // Whatever the step, the data is under at least one name.
    expect([OLD, NEW].some((name) => existsSync(join(t!.pipe.folders.tv, name)))).toBe(true);
    t.pipe.worker.enqueue({ type: 'import.run', payload: { hash: journal.hash }, dedupeKey: `import:${journal.hash}` });
    await t.finished(started.body.id);

    expect(t.tree(t.pipe.folders.tv)).toEqual([NEW]);
    expect(readFileSync(join(t.pipe.folders.tv, NEW), 'utf8')).toBe('video data');
    expect(Object.keys(t.pipe.db.data.files)).toEqual([id]);
    expect(t.pipe.db.data.files[id]!.path).toBe(NEW);
    expect(t.pipe.db.data.imports).toEqual({});
    // The seeding source is the same data in the end.
    expect(statSync(seed).ino).toBe(statSync(join(t.pipe.folders.tv, NEW)).ino);
    expect(lstatSync(seed).isFile()).toBe(true);
  }, 20_000);

  it('does not remove the old name when it is not the data of the new name any more', async () => {
    t = await startImportTest({
      afterStep: (state) => {
        // After the commit, someone puts another file under the old name.
        if (state === 'committed') {
          unlinkSync(join(t!.pipe.folders.tv, OLD));
          writeFileSync(join(t!.pipe.folders.tv, OLD), 'a different file');
        }
      },
    });
    t.addFile(OLD, 'video data', [{ season: 1, number: 1 }]);
    t.show.episodes[0]!.name = 'Pilot';
    const started = await apply();
    await t.finished(started.body.id);
    expect(readFileSync(join(t.pipe.folders.tv, NEW), 'utf8')).toBe('video data');
    expect(readFileSync(join(t.pipe.folders.tv, OLD), 'utf8')).toBe('a different file');
  });
});

describe('the templates in the import', () => {
  it('names a new file with the saved templates', async () => {
    t = await startImportTest();
    t.pipe.db.data.settings.naming = { movie: '{title}', episode: '{title} S{season}E{episode} {episodeTitle}' };
    t.write(t.inbox, { 'Show.Name.S01E02.mkv': 'two' });
    const started = await t.api.post('/import/folder', { titleKey: 'tv:1', path: t.inbox });
    await t.finished(started.body.id);
    expect(t.tree(t.pipe.folders.tv)).toEqual(['Show Name (2020)/Season 01/Show Name S01E02 Episode 2.mkv']);
  });

  it('gives names that a rescan reads, also for a file with several episodes', async () => {
    t = await startImportTest();
    t.pipe.db.data.settings.naming = { movie: '{title}', episode: '{title} S{season}E{episode} {episodeTitle}' };
    t.write(t.inbox, { 'Show.Name.S01E01.mkv': 'one', 'Show.Name.S01E02E03.mkv': 'two and three' });
    const started = await t.api.post('/import/folder', { titleKey: 'tv:1', path: t.inbox });
    await t.finished(started.body.id);
    expect(t.tree(t.pipe.folders.tv).sort()).toEqual(['Show Name (2020)/Season 01/Show Name S01E01 Episode 1.mkv', 'Show Name (2020)/Season 01/Show Name S01E02E03.mkv']);
    const before = Object.values(t.pipe.db.data.files).map((file) => file.id).sort();
    const result = await scanTitle('tv:1');
    expect(result).toMatchObject({ status: 'ok', missing: 0, unmatched: [], added: 0 });
    expect(Object.values(t.pipe.db.data.files).map((file) => file.id).sort()).toEqual(before);
    expect(Object.values(t.pipe.db.data.files).every((file) => !file.missing)).toBe(true);
  });
});
