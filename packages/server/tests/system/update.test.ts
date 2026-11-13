import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { open } from '../../src/core/db.ts';
import { installUpdate, latestRelease, UpdateError } from '../../src/system/update.ts';
import { startTestApp } from '../helpers/test-app.ts';
import { until } from '../helpers/test-pipeline.ts';

const VERSION = '9.9.9';
const TAG = `v${VERSION}`;
const BUNDLE = `ladarr-${VERSION}.tar.gz`;
const CHECKSUM = `${BUNDLE}.sha256`;
const RELEASE_URL = 'https://api.github.com/repos/blcktwr/ladarr/releases/latest';
const HTML_URL = `https://github.com/blcktwr/ladarr/releases/tag/${TAG}`;
const ASSET_BASE = 'https://downloads.test';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const asset = (name: string) => ({ name, browser_download_url: `${ASSET_BASE}/${name}` });
const release = (assets = [BUNDLE, CHECKSUM]) => ({ tag_name: TAG, html_url: HTML_URL, assets: assets.map(asset) });

// The fake fetch records every request and answers by url.
function fakeFetch(respond: (url: URL) => Response | undefined) {
  const calls: { url: URL; init?: RequestInit }[] = [];
  const send = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    return respond(url) ?? new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { send, calls };
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

// The fake GitHub answers the release and the two files of the bundle.
function bundleFetch(bundle: Uint8Array, checksum = `${sha256(bundle)}  ${BUNDLE}\n`) {
  return fakeFetch((url) => {
    if (url.href === RELEASE_URL) return json(release());
    if (url.href === `${ASSET_BASE}/${BUNDLE}`) return new Response(new Blob([bundle as BlobPart]));
    if (url.href === `${ASSET_BASE}/${CHECKSUM}`) return new Response(checksum);
    return undefined;
  });
}

// Builds a real tar.gz bundle from a folder of files.
function makeBundle(dir: string, files: Record<string, string>): string {
  const source = join(dir, 'source');
  for (const [name, content] of Object.entries(files)) {
    const file = join(source, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  const bundle = join(dir, BUNDLE);
  const tar = spawnSync('tar', ['-czf', bundle, '-C', source, '.']);
  expect(tar.status).toBe(0);
  return bundle;
}

// An app folder with the files that the bundles replace and one file that they keep.
function makeAppDir(dir: string): string {
  const appDir = join(dir, 'app');
  mkdirSync(join(appDir, 'folder'), { recursive: true });
  writeFileSync(join(appDir, 'folder', 'old.txt'), 'old old');
  writeFileSync(join(appDir, 'folder', 'gone.txt'), 'gone');
  writeFileSync(join(appDir, 'top.txt'), 'old top');
  writeFileSync(join(appDir, 'keep.txt'), 'keep me');
  return appDir;
}

function expectOldApp(appDir: string) {
  expect(readFileSync(join(appDir, 'folder', 'old.txt'), 'utf8')).toBe('old old');
  expect(readFileSync(join(appDir, 'folder', 'gone.txt'), 'utf8')).toBe('gone');
  expect(readFileSync(join(appDir, 'top.txt'), 'utf8')).toBe('old top');
  expect(readFileSync(join(appDir, 'keep.txt'), 'utf8')).toBe('keep me');
  expect(readdirSync(appDir).sort()).toEqual(['folder', 'keep.txt', 'top.txt']);
}

let base: string;
beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'ladarr-update-')));
});
afterAll(() => rmSync(base, { recursive: true, force: true }));
const fresh = () => mkdtempSync(join(base, 'case-'));

describe('latest release', () => {
  it('asks GitHub for the latest release with the accept and user-agent headers', async () => {
    const { send, calls } = fakeFetch(() => json(release()));
    await latestRelease(send);

    expect(calls).toHaveLength(1);
    const [{ url, init }] = calls;
    expect(url.href).toBe(RELEASE_URL);
    const headers = new Headers(init?.headers);
    expect(headers.get('accept')).toBe('application/vnd.github+json');
    expect(headers.get('user-agent')).toBeTruthy();
  });

  it('returns the version without the leading v, the release url and every asset', async () => {
    const names = [BUNDLE, CHECKSUM, 'notes.txt'];
    const { send } = fakeFetch(() => json(release(names)));
    expect(await latestRelease(send)).toEqual({
      version: VERSION,
      url: HTML_URL,
      assets: names.map((name) => ({ name, url: `${ASSET_BASE}/${name}` })),
    });
  });

  it('throws on a response that is not ok', async () => {
    const { send } = fakeFetch(() => json({ message: 'Not Found' }, 404));
    await expect(latestRelease(send)).rejects.toThrow();
  });

  it('throws when the release has no tag_name', async () => {
    const { send } = fakeFetch(() => json({ html_url: HTML_URL, assets: [] }));
    await expect(latestRelease(send)).rejects.toThrow();
  });

  it('throws when the release has no html_url', async () => {
    const { send } = fakeFetch(() => json({ tag_name: TAG, assets: [] }));
    await expect(latestRelease(send)).rejects.toThrow();
  });
});

describe('install update', () => {
  it('does not download the bundle when the release is not newer', async () => {
    const dir = fresh();
    const appDir = makeAppDir(dir);
    const { send, calls } = fakeFetch((url) => (url.href === RELEASE_URL ? json(release()) : undefined));

    const error = await installUpdate({ appDir, fetchImpl: send, currentVersion: VERSION }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(UpdateError);
    expect(error).toMatchObject({ code: 'no_update' });
    // Only the release request went out. Nothing was downloaded.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.href).toBe(RELEASE_URL);
    expectOldApp(appDir);
  });

  it('throws asset_missing when the release has no bundle', async () => {
    const dir = fresh();
    const appDir = makeAppDir(dir);
    const { send } = fakeFetch((url) => (url.href === RELEASE_URL ? json(release([CHECKSUM])) : undefined));

    await expect(installUpdate({ appDir, fetchImpl: send, currentVersion: '0.0.1' })).rejects.toMatchObject({ code: 'asset_missing' });
    expectOldApp(appDir);
  });

  it('replaces the app files with the bundle and keeps the files outside it', async () => {
    const dir = fresh();
    const appDir = makeAppDir(dir);
    const bytes = readFileSync(makeBundle(dir, { 'folder/old.txt': 'new old', 'folder/new.txt': 'new', 'top.txt': 'new top' }));
    const { send } = bundleFetch(bytes);

    expect(await installUpdate({ appDir, fetchImpl: send, currentVersion: '0.0.1' })).toEqual({ version: VERSION });

    expect(readFileSync(join(appDir, 'folder', 'old.txt'), 'utf8')).toBe('new old');
    expect(readFileSync(join(appDir, 'folder', 'new.txt'), 'utf8')).toBe('new');
    expect(readFileSync(join(appDir, 'top.txt'), 'utf8')).toBe('new top');
    // A top-level file that the bundle does not have stays.
    expect(readFileSync(join(appDir, 'keep.txt'), 'utf8')).toBe('keep me');
    // A file that only the old folder had is gone.
    expect(existsSync(join(appDir, 'folder', 'gone.txt'))).toBe(false);
    // No staging folder stays inside the app folder.
    expect(readdirSync(appDir).sort()).toEqual(['folder', 'keep.txt', 'top.txt']);
  });

  it('refuses the bundle when the checksum does not match', async () => {
    const dir = fresh();
    const appDir = makeAppDir(dir);
    const bytes = readFileSync(makeBundle(dir, { 'folder/old.txt': 'new old', 'top.txt': 'new top' }));
    const { send } = bundleFetch(bytes, `${'0'.repeat(64)}  ${BUNDLE}\n`);

    await expect(installUpdate({ appDir, fetchImpl: send, currentVersion: '0.0.1' })).rejects.toMatchObject({ code: 'checksum_mismatch' });
    expectOldApp(appDir);
  });

  it('reports download_failed when the bundle request is not ok', async () => {
    const dir = fresh();
    const appDir = makeAppDir(dir);
    const bytes = readFileSync(makeBundle(dir, { 'folder/old.txt': 'new old', 'top.txt': 'new top' }));
    const { send } = fakeFetch((url) => {
      if (url.href === RELEASE_URL) return json(release());
      if (url.href === `${ASSET_BASE}/${BUNDLE}`) return new Response('bad gateway', { status: 502 });
      if (url.href === `${ASSET_BASE}/${CHECKSUM}`) return new Response(`${sha256(bytes)}  ${BUNDLE}\n`);
      return undefined;
    });

    await expect(installUpdate({ appDir, fetchImpl: send, currentVersion: '0.0.1' })).rejects.toMatchObject({ code: 'download_failed' });
    expectOldApp(appDir);
  });

  it('reports extract_failed when the bundle is not a tar.gz', async () => {
    const dir = fresh();
    const appDir = makeAppDir(dir);
    const bundle = join(dir, BUNDLE);
    writeFileSync(bundle, 'not a tar.gz');
    const { send } = bundleFetch(readFileSync(bundle));

    await expect(installUpdate({ appDir, fetchImpl: send, currentVersion: '0.0.1' })).rejects.toMatchObject({ code: 'extract_failed' });
    expectOldApp(appDir);
  });
});

type UpdaterOptions = {
  restart?: () => void;
  installUpdate?: () => Promise<{ version: string }>;
  pauseQueue?: () => Promise<void>;
  resumeQueue?: () => void;
};

describe('update route', () => {
  let app: Awaited<ReturnType<typeof startTestApp>>;

  // The updater options join the app options with the implementation.
  async function start(options: UpdaterOptions = {}) {
    app = await startTestApp(options as unknown as Parameters<typeof startTestApp>[0], await open('unused.json'));
  }
  afterEach(() => {
    vi.unstubAllGlobals();
    app?.close();
  });

  it('answers 409 when there is no update, and does not restart', async () => {
    const restart = vi.fn();
    await start({
      restart,
      installUpdate: async () => {
        throw new UpdateError('no_update', 'no update');
      },
    });

    expect(await app.post('/system/update')).toMatchObject({ status: 409, body: { error: 'no_update' } });
    expect(restart).not.toHaveBeenCalled();
  });

  it('answers 202 with the new version, and restarts once', async () => {
    const restart = vi.fn();
    await start({ restart, installUpdate: async () => ({ version: VERSION }) });

    expect(await app.post('/system/update')).toMatchObject({ status: 202, body: { version: VERSION } });
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('restarts once when the client disconnects before the answer', async () => {
    const restart = vi.fn();
    let finish!: (value: { version: string }) => void;
    const install = new Promise<{ version: string }>((resolve) => (finish = resolve));
    let installing = false;
    await start({
      restart,
      pauseQueue: async () => {},
      installUpdate: () => {
        installing = true;
        return install;
      },
    });

    const controller = new AbortController();
    const request = fetch(`${app.base}/system/update`, {
      method: 'POST',
      headers: { cookie: app.cookie, 'x-csrf-token': app.csrfToken },
      signal: controller.signal,
    }).catch(() => undefined);

    await until(() => installing);
    controller.abort();
    // The server reads the close of the socket on a later turn, and then the answer goes to nobody.
    await new Promise((resolve) => setTimeout(resolve, 100));
    finish({ version: VERSION });

    await until(() => restart.mock.calls.length === 1, 2_000);
    await request;
    // A second call after the answer would restart the process twice.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(restart).toHaveBeenCalledTimes(1);
  }, 10_000);

  it('answers 502 when the install fails, and does not restart', async () => {
    const restart = vi.fn();
    await start({
      restart,
      installUpdate: async () => {
        throw new Error('disk full');
      },
    });

    expect(await app.post('/system/update')).toMatchObject({ status: 502, body: { error: 'update_failed' } });
    expect(restart).not.toHaveBeenCalled();
  });

  it('awaits the pause of the queue before it installs', async () => {
    const calls: string[] = [];
    let release!: () => void;
    const restart = vi.fn();
    await start({
      restart,
      pauseQueue: () => {
        calls.push('pause');
        return new Promise<void>((resolve) => (release = resolve));
      },
      resumeQueue: () => void calls.push('resume'),
      installUpdate: async () => {
        calls.push('install');
        return { version: VERSION };
      },
    });

    const pending = app.post('/system/update');
    await until(() => calls.includes('pause'));
    // The install waits for the pause to resolve.
    expect(calls).toEqual(['pause']);

    release();
    expect(await pending).toMatchObject({ status: 202, body: { version: VERSION } });
    expect(calls).toEqual(['pause', 'install']);
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('answers 202, restarts once, and does not resume the queue', async () => {
    const restart = vi.fn();
    const pauseQueue = vi.fn(async () => {});
    const resumeQueue = vi.fn();
    await start({ restart, pauseQueue, resumeQueue, installUpdate: async () => ({ version: VERSION }) });

    expect(await app.post('/system/update')).toMatchObject({ status: 202, body: { version: VERSION } });
    expect(pauseQueue).toHaveBeenCalledTimes(1);
    expect(resumeQueue).not.toHaveBeenCalled();
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('resumes the queue once and does not restart when there is no update', async () => {
    const restart = vi.fn();
    const resumeQueue = vi.fn();
    await start({
      restart,
      pauseQueue: async () => {},
      resumeQueue,
      installUpdate: async () => {
        throw new UpdateError('no_update', 'no update');
      },
    });

    expect(await app.post('/system/update')).toMatchObject({ status: 409, body: { error: 'no_update' } });
    expect(resumeQueue).toHaveBeenCalledTimes(1);
    expect(restart).not.toHaveBeenCalled();
  });

  it('resumes the queue once and does not restart when the install fails', async () => {
    const restart = vi.fn();
    const resumeQueue = vi.fn();
    await start({
      restart,
      pauseQueue: async () => {},
      resumeQueue,
      installUpdate: async () => {
        throw new Error('disk full');
      },
    });

    expect(await app.post('/system/update')).toMatchObject({ status: 502, body: { error: 'update_failed' } });
    expect(resumeQueue).toHaveBeenCalledTimes(1);
    expect(restart).not.toHaveBeenCalled();
  });

  it('answers 404 and does not pause the queue when the updater is not given', async () => {
    const pauseQueue = vi.fn(async () => {});
    await start({ pauseQueue });

    expect(await app.post('/system/update')).toMatchObject({ status: 404, body: { error: 'update_unavailable' } });
    expect(pauseQueue).not.toHaveBeenCalled();
  });

  it('answers a GET with the update check', async () => {
    await start();
    const real = globalThis.fetch;
    // Only the GitHub request is faked. The call to the test server goes on.
    vi.stubGlobal('fetch', ((input: string | URL | Request, init?: RequestInit) =>
      String(input) === RELEASE_URL ? Promise.resolve(json(release())) : real(input, init)) as typeof fetch);

    expect(await app.get('/system/update')).toMatchObject({ status: 200, body: { available: true, latest: VERSION, url: HTML_URL } });
  });
});
