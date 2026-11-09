import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { movie } from '../helpers/test-fixtures.ts';
import { startTestApp } from '../helpers/test-app.ts';

let app: Awaited<ReturnType<typeof startTestApp>>;
let dir: string;
const configDir = () => join(dir, 'config');
const folder = (name: string) => {
  const path = join(dir, name);
  mkdirSync(path, { recursive: true });
  return path;
};

beforeAll(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'ladarr-roots-')));
  mkdirSync(configDir());
  app = await startTestApp({ configDir: configDir() });
});
afterAll(() => {
  app.close();
  chmodSync(join(dir), 0o755);
  rmSync(dir, { recursive: true, force: true });
});

describe('settings', () => {
  it('starts with defaults and offers the two profiles of version 1', async () => {
    const { body } = await app.get('/settings');
    expect(body.settings).toMatchObject({ setupCompleted: false, audio: null, keepQueueLogs: true });
    expect(body.settings).not.toHaveProperty('upgrades');
    expect(body.settings).not.toHaveProperty('defaultPreset');
    expect(body.settings).not.toHaveProperty('maxAliases');
    expect(body.settings).not.toHaveProperty('recentDays');
    expect(body.presets).toEqual([
      { id: 'p1080', label: '1080p' },
      { id: 'p2160', label: '2160p' },
    ]);
  });

  it('lists the presets in the order of the chain', async () => {
    app.db.data.profileOrder = ['p2160', 'p1080'];
    try {
      expect((await app.get('/settings')).body.presets).toEqual([
        { id: 'p2160', label: '2160p' },
        { id: 'p1080', label: '1080p' },
      ]);
    } finally {
      app.db.data.profileOrder = ['p1080', 'p2160'];
    }
  });

  it('offers the languages of the aliases of every title', async () => {
    const aliased = (tmdbId: number, aliasRegions: Record<string, string[]>) =>
      movie({ key: `movie:${tmdbId}`, tmdbId, meta: { ...movie().meta, tmdbId, aliasRegions } });
    app.db.data.titles['movie:901'] = aliased(901, { 'Alias MA': ['MA'], 'Alias TH': ['TH'], 'Alias FR': ['FR'] });
    expect((await app.get('/settings')).body.aliasLanguageOptions).toEqual(['ar', 'fr', 'th']);

    app.db.data.titles['movie:902'] = aliased(902, { 'Alias JP': ['JP'] });
    expect((await app.get('/settings')).body.aliasLanguageOptions).toEqual(['ar', 'fr', 'ja', 'th']);
  });

  it('saves valid changes', async () => {
    const changes = { region: 'AR', timeZone: 'America/Argentina/Buenos_Aires', language: 'es', theme: 'light', audio: { language: 'es', strict: true }, keepQueueLogs: false };
    expect((await app.patch('/settings', changes)).status).toBe(200);
    expect((await app.get('/settings')).body.settings).toMatchObject(changes);
    expect((await app.patch('/settings', { audio: null })).body.settings.audio).toBeNull();
    expect((await app.patch('/settings', { keepQueueLogs: true })).body.settings.keepQueueLogs).toBe(true);
  });

  it.each([
    [{ region: 'ar' }, 'region'],
    [{ timeZone: 'Mars/Base' }, 'timeZone'],
    [{ language: 'fr' }, 'language'],
    [{ theme: 'blue' }, 'theme'],
    [{ defaultPreset: 'p1080' }, 'defaultPreset'],
    [{ audio: { language: 'Spanish', strict: true } }, 'audio'],
    [{ setupCompleted: true }, 'setupCompleted'],
    [{ defaultRoots: { movie: 'missing' } }, 'defaultRoots.movie'],
    [{ keepQueueLogs: 'true' }, 'keepQueueLogs'],
    [{ keepQueueLogs: 1 }, 'keepQueueLogs'],
    [{ maxAliases: 5 }, 'maxAliases'],
    [{ maxAliases: -1 }, 'maxAliases'],
    [{ maxAliases: 21 }, 'maxAliases'],
    [{ maxAliases: 2.5 }, 'maxAliases'],
    [{ maxAliases: '3' }, 'maxAliases'],
    [{ recentDays: 0 }, 'recentDays'],
    [{ recentDays: 366 }, 'recentDays'],
    [{ recentDays: 2.5 }, 'recentDays'],
    [{ recentDays: '3' }, 'recentDays'],
    [{ aliasLanguages: 'en' }, 'aliasLanguages'],
    [{ aliasLanguages: [1] }, 'aliasLanguages'],
    [{ aliasLanguages: ['EN'] }, 'aliasLanguages'],
    [{ aliasLanguages: ['toolong'] }, 'aliasLanguages'],
  ])('rejects %j', async (body, field) => {
    const res = await app.patch('/settings', body);
    expect(res).toMatchObject({ status: 400, body: { error: 'invalid_setting', field } });
  });

  it('does not finish the setup without both default folders', async () => {
    expect((await app.post('/settings/complete-setup')).status).toBe(400);
    expect((await app.get('/settings')).body.settings.setupCompleted).toBe(false);
  });
});

describe('roots', () => {
  it('refuses a folder that cannot work, and saves nothing', async () => {
    const file = join(dir, 'file.txt');
    writeFileSync(file, 'x');
    const add = (path: string) => app.post('/roots', { path, mediaType: 'movie' });
    expect((await add('relative/path')).body).toEqual({ error: 'path_not_absolute' });
    expect((await add(join(dir, 'missing'))).body).toEqual({ error: 'root_unusable', problems: ['not_found'] });
    expect((await add(file)).body).toEqual({ error: 'root_unusable', problems: ['not_directory'] });
    expect((await add('/')).body).toEqual({ error: 'root_too_broad' });
    expect((await add(configDir())).body).toEqual({ error: 'root_overlaps_config' });
    expect((await add(dir)).body).toEqual({ error: 'root_overlaps_config' });
    expect((await app.post('/roots', { path: dir, mediaType: 'book' })).body).toEqual({ error: 'invalid_root' });
    expect((await app.get('/roots')).body.roots).toEqual([]);
  });

  it('refuses a folder that cannot be written', async (ctx) => {
    if (process.getuid?.() === 0) return ctx.skip();
    const locked = folder('locked');
    chmodSync(locked, 0o555);
    expect((await app.post('/roots/check', { path: locked })).body).toMatchObject({ error: 'root_unusable', problems: ['not_writable'] });
    chmodSync(locked, 0o755);
  });

  it('checks a folder without saving it', async () => {
    const movies = folder('movies');
    const { status, body } = await app.post('/roots/check', { path: movies });
    expect(status).toBe(200);
    expect(body.path).toBe(movies);
    expect(body.check.freeBytes).toBeGreaterThan(0);
    expect((await app.get('/roots')).body.roots).toEqual([]);
  });

  it('lists the folders of a folder for the picker', async () => {
    const parent = folder('picker');
    mkdirSync(join(parent, 'z-folder'));
    mkdirSync(join(parent, 'a-folder'));
    mkdirSync(join(parent, '.hidden'));
    writeFileSync(join(parent, 'file.txt'), 'x');
    const res = await app.get(`/roots/browse?path=${encodeURIComponent(parent)}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ path: parent, parent: dir, folders: ['a-folder', 'z-folder'] });
  });

  it('lists the top of the disk without a parent', async () => {
    const { status, body } = await app.get('/roots/browse?path=/');
    expect(status).toBe(200);
    expect(body).toMatchObject({ path: '/', parent: null });
    expect(Array.isArray(body.folders)).toBe(true);
  });

  it('refuses a folder that it cannot list', async () => {
    writeFileSync(join(dir, 'not-a-folder.txt'), 'x');
    expect((await app.get('/roots/browse')).body).toEqual({ error: 'path_not_absolute' });
    expect((await app.get('/roots/browse?path=relative')).body).toEqual({ error: 'path_not_absolute' });
    expect((await app.get(`/roots/browse?path=${encodeURIComponent(join(dir, 'missing'))}`)).body).toEqual({ error: 'root_unusable', problems: ['not_found'] });
    expect((await app.get(`/roots/browse?path=${encodeURIComponent(join(dir, 'not-a-folder.txt'))}`)).body).toEqual({ error: 'root_unusable', problems: ['not_directory'] });
  });

  it('adds a movie folder and a series folder, and makes each the default', async () => {
    const movies = await app.post('/roots', { path: join(dir, 'movies'), mediaType: 'movie' });
    const series = await app.post('/roots', { path: folder('series'), mediaType: 'tv' });
    expect([movies.status, series.status]).toEqual([201, 201]);
    const { settings } = (await app.get('/settings')).body;
    expect(settings.defaultRoots).toEqual({ movie: movies.body.id, tv: series.body.id });
    expect((await app.get('/roots')).body.roots).toHaveLength(2);
  });

  it('refuses a folder inside a root, or around one, or the same one', async () => {
    const add = (path: string) => app.post('/roots', { path, mediaType: 'tv' });
    expect((await add(folder('movies/sub'))).body.error).toBe('root_overlaps_root');
    expect((await add(join(dir, 'movies'))).body.error).toBe('root_overlaps_root');
    expect((await add(dir)).body.error).toBe('root_overlaps_config');
  });

  it('saves the real path of a symbolic link', async () => {
    const real = folder('real-tv');
    const link = join(dir, 'link-tv');
    symlinkSync(real, link);
    const res = await app.post('/roots', { path: link, mediaType: 'tv' });
    expect(res.body.path).toBe(real);
  });

  it('shows a changed mount as a problem and keeps the record', async () => {
    const [root] = Object.values(app.db.data.roots);
    const real = root!.dev;
    root!.dev = real + 1;
    const { roots } = (await app.get('/roots')).body;
    expect(roots.find((r: { id: string }) => r.id === root!.id).check.problems).toContain('mount_changed');
    root!.dev = real;
    expect(Object.keys(app.db.data.roots)).toContain(root!.id);
  });

  it('shows a missing folder as a problem and keeps the record', async () => {
    const gone = folder('gone-later');
    const added = await app.post('/roots', { path: gone, mediaType: 'movie' });
    rmSync(gone, { recursive: true });
    const { roots } = (await app.get('/roots')).body;
    expect(roots.find((r: { id: string }) => r.id === added.body.id).check.problems).toEqual(['not_found']);
    expect(app.db.data.roots[added.body.id]).toBeDefined();
  });

  it('edits the path of a saved folder', async () => {
    const root = Object.values(app.db.data.roots).find((item) => item.mediaType === 'movie' && item.path === join(dir, 'movies'))!;
    const next = folder('movies-edited');
    const res = await app.patch(`/roots/${root.id}`, { path: next });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: root.id, path: next, mediaType: 'movie' });
    expect(app.db.data.roots[root.id]!.path).toBe(next);
    expect((await app.get('/roots')).body.roots.find((item: { id: string }) => item.id === root.id).path).toBe(next);
  });

  it('refuses to move a folder onto another saved folder', async () => {
    const roots = Object.values(app.db.data.roots);
    const movieRoot = roots.find((root) => root.mediaType === 'movie' && root.path === join(dir, 'movies-edited'))!;
    const tvRoot = roots.find((root) => root.mediaType === 'tv')!;
    expect((await app.patch(`/roots/${movieRoot.id}`, { path: tvRoot.path })).body).toEqual({ error: 'root_overlaps_root' });
  });

  it('does not edit a folder that a title uses', async () => {
    const root = Object.values(app.db.data.roots).find((item) => item.mediaType === 'movie')!;
    app.db.data.titles['movie:edit'] = movie({ key: 'movie:edit', tmdbId: 700, rootId: root.id });
    expect((await app.patch(`/roots/${root.id}`, { path: folder('movies-in-use') })).body).toEqual({ error: 'root_in_use', titles: 1 });
    delete app.db.data.titles['movie:edit'];
  });

  it('keeps defaults that name a saved folder of the same type', async () => {
    const [tvRoot] = Object.values(app.db.data.roots).filter((root) => root.mediaType === 'tv');
    expect((await app.patch('/settings', { defaultRoots: { movie: tvRoot!.id } })).body.field).toBe('defaultRoots.movie');
    expect((await app.patch('/settings', { defaultRoots: { tv: tvRoot!.id } })).status).toBe(200);
  });

  it('finishes the setup once both defaults exist', async () => {
    const { status, body } = await app.post('/settings/complete-setup');
    expect(status).toBe(200);
    expect(body.settings.setupCompleted).toBe(true);
  });
});
