import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emptyData, QUEUE_KEYS } from '../../src/core/db.ts';
import type { Data, MediaFile, QueueData } from '../../src/types.ts';
import { indexer, movie } from '../helpers/test-fixtures.ts';
import { until } from '../helpers/test-pipeline.ts';
import { startFakeQbit } from '../helpers/test-qbit.ts';
import { entryOf } from '../helpers/test-queue.ts';

const entry = fileURLToPath(new URL('../../src/index.ts', import.meta.url));
const password = 'original password';
const nextPassword = 'new owner password';
const folder = 'Movie Name (2019)';
const primary = join(folder, 'Movie Name (2019).mkv');
const variant = join(folder, 'Movie Name (2019) - 2160p.mkv');
const unrelated = join(folder, 'personal notes.txt');
const oldLog = 'record from before reset';
const logPaths = ['ladarr.log', 'ladarr.log.1', 'requests.log', 'requests.log.1', join('items', 'queued.log')];

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer().once('error', reject).listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });

describe('factory reset', () => {
  let dir: string;
  let config: string;
  let media: string;
  let outside: string;
  let stop: (() => Promise<number | null>) | undefined;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'ladarr-reset-')));
    config = join(dir, 'config');
    media = join(dir, 'media');
    outside = join(dir, 'outside');
    mkdirSync(join(media, folder), { recursive: true });
    mkdirSync(join(outside, folder), { recursive: true });
    mkdirSync(join(config, 'logs', 'items'), { recursive: true });
  });

  afterEach(async () => {
    try {
      await stop?.();
    } finally {
      stop = undefined;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  async function start() {
    const port = await freePort();
    const base = `http://127.0.0.1:${port}/api`;
    const child = spawn(process.execPath, [entry], {
      cwd: dir,
      env: { ...process.env, NODE_ENV: 'production', PORT: String(port), LADARR_CONFIG_DIR: config, LADARR_COMPAT_PORTS: '0', LADARR_URL_BASE: '', LADARR_WEB_DIR: '', LADARR_DEV_ORIGIN: '', LADARR_TMDB_BASE_URL: 'http://127.0.0.1:1' },
      stdio: 'ignore',
    });
    const exit = once(child, 'exit').then(([code]) => code as number | null);
    stop = async () => {
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
      try {
        return await exit;
      } finally {
        clearTimeout(timer);
      }
    };
    let ready = false;
    await until(() => {
      if (child.exitCode !== null) throw new Error(`Server exited with code ${child.exitCode}`);
      if (!ready) void fetch(`${base}/health`).then((res) => (ready = res.ok), () => {});
      return ready;
    });

    const get = (path: string, headers?: Record<string, string>) => fetch(`${base}${path}`, { headers, signal: AbortSignal.timeout(8_000) });
    const post = (path: string, body: unknown, headers?: Record<string, string>) =>
      fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(8_000) });
    const session = async (path: '/auth/setup' | '/auth/login', password: string) => {
      const res = await post(path, { password });
      expect(res.status, await res.clone().text()).toBe(path === '/auth/setup' ? 201 : 200);
      const cookie = res.headers.getSetCookie()[0]!.split(';')[0]!;
      const status = await (await get('/auth/status', { cookie })).json();
      expect(status).toMatchObject({ setupRequired: false, authenticated: true, csrfToken: expect.any(String) });
      return { cookie, 'x-csrf-token': status.csrfToken as string };
    };
    return { get, post, session };
  }

  const file = (id: string, titleKey: string, path: string, root = media): MediaFile => {
    const info = statSync(join(root, path));
    return { id, titleKey, path, sizeBytes: info.size, mtimeMs: info.mtimeMs, episodes: [], missing: false, addedAt: Date.now() };
  };
  const data = (): Data => JSON.parse(readFileSync(join(config, 'db.json'), 'utf8'));
  const queue = (): QueueData => JSON.parse(readFileSync(join(config, 'queue.json'), 'utf8'));
  const text = (path: string) => readFileSync(path, 'utf8');
  const log = (path: string) => join(config, 'logs', path);

  async function install(change?: (data: Data) => void) {
    writeFileSync(join(media, primary), 'primary video');
    writeFileSync(join(media, variant), 'alternate video');
    writeFileSync(join(media, unrelated), 'personal notes');
    writeFileSync(join(outside, primary), 'outside video');
    for (const path of logPaths) writeFileSync(log(path), `${oldLog}\n`);

    const saved = emptyData();
    const film = movie({ rootId: 'root', folder, fileId: 'primary', paused: true });
    saved.roots.root = { id: 'root', path: media, mediaType: 'movie', dev: statSync(media).dev };
    saved.titles[film.key] = film;
    saved.files = { primary: file('primary', film.key, primary), variant: file('variant', film.key, variant) };
    saved.settings = { ...saved.settings, setupCompleted: true, defaultRoots: { movie: 'root', tv: null }, naming: { ...saved.settings.naming, movie: '{title}' } };
    saved.indexers['1'] = indexer({ baseUrl: 'http://127.0.0.1:1/' });
    saved.downloadClients = [{ id: 'client', name: 'Client', type: 'qbittorrent', host: '127.0.0.1', port: 1, auth: { type: 'password', username: 'user', password: 'client password' }, enabled: false, maxDownloads: 0 }];
    saved.queue.queued = entryOf({ id: 'queued', titleKey: film.key, branch: 'paused' });
    saved.queuePaused = true;
    change?.(saved);
    writeFileSync(join(config, 'db.json'), JSON.stringify(saved, (key, value) => QUEUE_KEYS.some((item) => item === key) ? undefined : value));
    writeFileSync(join(config, 'queue.json'), JSON.stringify(Object.fromEntries(QUEUE_KEYS.map((key) => [key, saved[key]]))));

    const app = await start();
    const owner = await app.session('/auth/setup', password);
    const { apiKey } = await (await app.get('/auth/api-key', owner)).json();
    const created = await app.post('/backups', {}, owner);
    expect(created.status).toBe(201);
    const { backup } = await created.json();
    return { app, owner, apiKey: apiKey as string, backup: join(config, 'backups', backup.name), film };
  }

  async function expectUnchanged({ app, owner, apiKey, backup, film }: Awaited<ReturnType<typeof install>>, currentMedia = media) {
    expect(await (await app.get('/auth/status', owner)).json()).toMatchObject({ setupRequired: false, authenticated: true });
    expect(data()).toMatchObject({ titles: { [film.key]: { fileId: 'primary' } }, settings: { setupCompleted: true }, apiKey });
    expect(queue()).toMatchObject({ queue: { queued: { titleKey: film.key } }, queuePaused: true });
    expect(existsSync(backup)).toBe(true);
    expect(text(log('ladarr.log'))).toContain(oldLog);
    expect(text(join(currentMedia, primary))).toBe('primary video');
    expect(text(join(currentMedia, variant))).toBe('alternate video');
    expect(text(join(currentMedia, unrelated))).toBe('personal notes');
    expect(text(join(outside, primary))).toBe('outside video');
  }

  it('clears persisted data and owned files, invalidates credentials, and allows a fresh setup', async () => {
    const { app, owner, apiKey, backup } = await install();
    const second = await app.session('/auth/login', password);
    const reset = await app.post('/system/reset', { confirm: true }, owner);
    expect(reset.status, await reset.clone().text()).toBe(200);
    expect(await reset.json()).toEqual({ ok: true });

    for (const headers of [owner, second]) {
      expect(await (await app.get('/auth/status', headers)).json()).toMatchObject({ setupRequired: true, authenticated: false });
    }
    expect((await app.get('/library', { 'x-api-key': apiKey })).status).toBe(401);
    expect(existsSync(join(media, primary))).toBe(false);
    expect(existsSync(join(media, variant))).toBe(false);
    expect(text(join(media, unrelated))).toBe('personal notes');
    expect(text(join(outside, primary))).toBe('outside video');
    expect(existsSync(backup)).toBe(false);
    for (const path of logPaths) {
      expect(existsSync(log(path)) ? text(log(path)) : '', path).not.toContain(oldLog);
    }

    expect(await stop!()).toBe(0);
    expect(data()).toMatchObject({ owner: null, apiKey: null, settings: emptyData().settings, downloadClients: [] });
    for (const name of ['sessions', 'titles', 'files', 'roots', 'indexers'] as const) expect(data()[name], name).toEqual({});
    expect(queue().queue).toEqual({});
    expect(queue().queuePaused).toBe(false);

    const restarted = await start();
    expect(await (await restarted.get('/auth/status', owner)).json()).toMatchObject({ setupRequired: true, authenticated: false });
    const fresh = await restarted.session('/auth/setup', nextPassword);
    expect((await restarted.post('/auth/login', { password })).ok).toBe(false);
    await restarted.session('/auth/login', nextPassword);
    expect((await (await restarted.get('/auth/api-key', fresh)).json()).apiKey).not.toBe(apiKey);
    expect(await (await restarted.get('/library', fresh)).json()).toMatchObject({ items: [], total: 0 });
    expect(await (await restarted.get('/queue', fresh)).json()).toMatchObject({ items: [], total: 0 });
  }, 25_000);

  it('skips an absent root and an absent file while resetting the rest of the installation', async () => {
    const absentRoot = join(dir, 'absent-root');
    const movedRoot = join(dir, 'moved-root');
    const absentFile = join(folder, 'missing.mkv');
    mkdirSync(join(absentRoot, folder), { recursive: true });
    writeFileSync(join(absentRoot, primary), 'video from the absent root');
    writeFileSync(join(media, absentFile), 'video from the healthy root');

    const { app, owner, backup } = await install((saved) => {
      const film = movie({ key: 'movie:3', tmdbId: 3, rootId: 'absent', folder, fileId: 'absent', paused: true });
      saved.roots.absent = { id: 'absent', path: absentRoot, mediaType: 'movie', dev: statSync(absentRoot).dev };
      saved.titles[film.key] = film;
      saved.files.absent = file('absent', film.key, primary, absentRoot);
      saved.files.missing = file('missing', saved.files.primary!.titleKey, absentFile);
    });
    renameSync(absentRoot, movedRoot);
    rmSync(join(media, absentFile));

    const response = await app.post('/system/reset', { confirm: true }, owner);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(await (await app.get('/auth/status', owner)).json()).toMatchObject({ setupRequired: true, authenticated: false });
    expect(data()).toEqual(expect.objectContaining({ owner: null, apiKey: null, sessions: {}, titles: {}, files: {}, roots: {} }));
    expect(existsSync(backup)).toBe(false);
    expect(existsSync(join(media, primary))).toBe(false);
    expect(existsSync(join(media, variant))).toBe(false);
    expect(text(join(media, unrelated))).toBe('personal notes');
    expect(text(join(outside, primary))).toBe('outside video');
    expect(text(join(movedRoot, primary))).toBe('video from the absent root');
  }, 20_000);

  it('deletes linked Ladarr torrents and their payloads but keeps an external torrent', async () => {
    const downloads = join(dir, 'downloads');
    mkdirSync(downloads);
    const qbit = await startFakeQbit({ savePath: downloads });
    try {
      const queued = 'a'.repeat(40);
      const imported = 'b'.repeat(40);
      const external = 'c'.repeat(40);
      for (const hash of [queued, imported, external]) {
        qbit.torrents.set(hash, {
          hash, name: hash, size: 10, progress: 1, state: 'uploading', category: '', tags: '',
          save_path: downloads, content_path: join(downloads, `${hash}.mkv`), dlspeed: 0, eta: 0, num_seeds: 0, num_leechs: 0, added_on: 1,
        });
      }

      const { app, owner } = await install((saved) => {
        const client = saved.downloadClients[0]!;
        Object.assign(client, { port: qbit.port, enabled: true, auth: { type: 'password', username: 'admin', password: 'secret' } });
        Object.assign(saved.queue.queued!, { clientId: client.id, transferHash: queued });
        saved.sentTorrents[queued] = Date.now();
        saved.files.primary!.download = { clientId: client.id, hash: imported, external: false };
        saved.files.variant!.download = { clientId: client.id, hash: external, external: true };
      });
      const response = await app.post('/system/reset', { confirm: true }, owner);
      expect(response.status, await response.clone().text()).toBe(200);

      const removals = qbit.calls.filter(({ path }) => path === 'torrents/delete').flatMap(({ body }) => {
        const { hashes, deleteFiles } = JSON.parse(body!) as { hashes: string; deleteFiles: string };
        return hashes.split('|').map((hash) => ({ hash, deleteFiles }));
      });
      expect(removals.sort((a, b) => a.hash.localeCompare(b.hash))).toEqual([
        { hash: queued, deleteFiles: 'true' },
        { hash: imported, deleteFiles: 'true' },
      ]);
      expect([...qbit.torrents.keys()]).toEqual([external]);
    } finally {
      qbit.close();
    }
  }, 20_000);

  it('requires an owner session, its CSRF token, and explicit Boolean confirmation', async () => {
    const installState = await install();
    const { app, owner, apiKey } = installState;
    const rejected = [
      [{ confirm: true }, undefined],
      [{ confirm: true }, { 'x-api-key': apiKey }],
      [{ confirm: true }, { cookie: owner.cookie }],
      [{ confirm: true }, { ...owner, 'x-csrf-token': 'wrong' }],
      [{ confirm: true }, { cookie: owner.cookie, 'x-api-key': apiKey }],
      [{}, owner],
      [{ confirm: false }, owner],
      [{ confirm: 'true' }, owner],
    ] as const;
    for (const [body, headers] of rejected) expect((await app.post('/system/reset', body, headers)).ok).toBe(false);
    await expectUnchanged(installState);
  }, 20_000);

  it.each(['root replaced by a link', 'different device', 'path traversal', 'linked directory'] as const)('fails safely for %s', async (problem) => {
    const installState = await install((saved) => {
      if (problem === 'different device') saved.roots.root!.dev += 1;
      if (problem === 'path traversal') saved.files.unsafe = { ...saved.files.variant!, id: 'unsafe', path: `../outside/${primary}` };
      if (problem === 'linked directory') {
        symlinkSync(outside, join(media, 'linked'), 'dir');
        saved.files.unsafe = { ...saved.files.variant!, id: 'unsafe', path: join('linked', primary) };
      }
    });
    const moved = join(dir, 'moved');
    const replaced = problem === 'root replaced by a link';
    if (replaced) {
      renameSync(media, moved);
      symlinkSync(outside, media, 'dir');
    }
    const { app, owner } = installState;
    expect((await app.post('/system/reset', { confirm: true }, owner)).ok).toBe(false);
    await expectUnchanged(installState, replaced ? moved : media);
  }, 20_000);

  it.skipIf(process.getuid?.() === 0)('fails safely when the root cannot be read', async () => {
    const installState = await install();
    chmodSync(media, 0o000);
    try {
      const { app, owner } = installState;
      expect((await app.post('/system/reset', { confirm: true }, owner)).ok).toBe(false);
    } finally {
      chmodSync(media, 0o700);
    }
    await expectUnchanged(installState);
  }, 20_000);
});
