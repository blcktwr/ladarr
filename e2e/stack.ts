import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeQbit } from '../packages/server/tests/helpers/test-qbit.ts';
import { hashOf, startFakeTracker } from '../packages/server/tests/helpers/test-pipeline.ts';
import { startFakeTmdb } from './fake-tmdb.ts';

export const PORT = Number(process.env.LADARR_E2E_PORT ?? 3111);
export const URL_BASE = `http://127.0.0.1:${PORT}`;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// The server reads the TMDB key from the build constant, not from the environment.
const CONSTANTS = join(ROOT, 'packages/shared/src/constants.ts');
const E2E_KEY = 'export const TMDB_API_KEY = "e2e-key";';
export const MIB = 1024 * 1024;
export const OWNER = { password: 'correct horse' };

// The names and sizes fit the default preset (1080p).
export const MOVIE_RELEASE = 'Movie.Name.2019.1080p.BluRay.x264-GRP';
export const SERIES_PACK = 'Show.Name.S01.1080p.WEB-DL.DDP5.1-GRP';

// A stand-in for ffprobe. It reports a valid video for any file, so the importer runs its real ffprobe path on test files.
const FAKE_FFPROBE = `#!/bin/sh
if [ "$1" = "-version" ]; then echo "ffprobe version fake"; exit 0; fi
echo '{"format":{"duration":"2700.0","format_name":"matroska,webm"},"streams":[{"codec_type":"video","codec_name":"h264"},{"codec_type":"audio","codec_name":"aac","tags":{"language":"eng"}}]}'
`;

// The real server (packages/server/src/index.ts) in its own process, on a temp config folder.
// TMDB, the Torznab indexer, qBittorrent, and ffprobe are local fakes. Nothing reaches a real service.
export async function startStack() {
  // A short path, because the folder paths show in the pages, and a long path can break a narrow layout.
  const dir = realpathSync(mkdtempSync('/tmp/ladarr-e2e-'));
  const folders = { config: join(dir, 'config'), movies: join(dir, 'movies'), tv: join(dir, 'tv'), downloads: join(dir, 'downloads'), bin: join(dir, 'bin') };
  for (const folder of Object.values(folders)) mkdirSync(folder);
  writeFileSync(join(folders.bin, 'ffprobe'), FAKE_FFPROBE);
  chmodSync(join(folders.bin, 'ffprobe'), 0o755);

  const tmdb = await startFakeTmdb();
  const tracker = await startFakeTracker();
  const qbit = await startFakeQbit({ savePath: folders.downloads });
  // The test occupies the constant for the run, and gives the file back at the end.
  const constants = readFileSync(CONSTANTS, 'utf8');
  const restoreConstants = () => writeFileSync(CONSTANTS, constants);
  writeFileSync(CONSTANTS, `${E2E_KEY}\n`);
  process.once('exit', restoreConstants);
  tracker.state.items = [
    { title: MOVIE_RELEASE, size: 100 * 120 * MIB },
    { title: SERIES_PACK, size: 3 * 60 * 45 * MIB },
  ];

  let child: ChildProcess | undefined;
  let output = '';

  // Returns the time from the spawn to the first good answer of the health check.
  async function start() {
    const began = performance.now();
    output = '';
    // A server that already answers on this port is not ours, and the tests must not use it.
    if (await fetch(`${URL_BASE}/api/health`).then(() => true, () => false)) throw new Error(`Port ${PORT} is in use. Stop the process on it, or set LADARR_E2E_PORT.`);
    const proc = spawn(process.execPath, [join(ROOT, 'packages/server/src/index.ts')], {
      cwd: ROOT,
      env: {
        ...process.env,
        // lowdb keeps the database in memory when NODE_ENV is "test".
        NODE_ENV: 'production',
        PORT: String(PORT),
        LADARR_CONFIG_DIR: folders.config,
        LADARR_WEB_DIR: join(ROOT, 'packages/webapp/dist'),
        LADARR_TMDB_BASE_URL: tmdb.url,
        // The tests and the benchmark call the server without a URL base.
        LADARR_URL_BASE: '',
        // The proxy ports are not part of this test stack. The tests that need them start the app directly.
        LADARR_COMPAT_PORTS: '0',
        PATH: `${folders.bin}:${process.env.PATH}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child = proc;
    // The server must not outlive a test run that dies.
    process.once('exit', () => proc.kill('SIGKILL'));
    for (const stream of [proc.stdout, proc.stderr]) stream.on('data', (chunk) => (output += chunk));
    const exited = new Promise<never>((_, reject) => proc.once('exit', (code) => reject(new Error(`The server stopped with code ${code}.\n${output}`))));
    const ready = (async () => {
      for (let i = 0; i < 2000; i++) {
        if (await fetch(`${URL_BASE}/api/health`).then((res) => res.ok, () => false)) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`The server did not become ready.\n${output}`);
    })();
    await Promise.race([ready, exited]);
    return performance.now() - began;
  }

  async function stopServer(signal: NodeJS.Signals = 'SIGTERM') {
    const proc = child;
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
    child = undefined;
    const done = new Promise((resolve) => proc.once('exit', resolve));
    proc.kill(signal);
    const timer = setTimeout(() => proc.kill('SIGKILL'), 15_000);
    await done;
    clearTimeout(timer);
  }

  const stopFakes = () => {
    tmdb.close();
    tracker.close();
    qbit.close();
    restoreConstants();
    process.off('exit', restoreConstants);
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    await start();
  } catch (error) {
    await stopServer('SIGKILL');
    stopFakes();
    throw error;
  }

  // The API of the server, with the owner session. The browser tests use it to prepare state quickly.
  let session: { cookie: string; csrf: string } | undefined;
  async function call(method: string, path: string, body?: unknown) {
    const res = await fetch(`${URL_BASE}/api${path}`, {
      method,
      headers: { ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrf } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, headers: res.headers, body: (await res.json().catch(() => undefined)) as any };
  }

  return {
    dir,
    folders,
    tmdb,
    tracker,
    qbit,
    // The output of the process and the log file of the server, to attach to a failed test.
    logs: () => `${output}\n${existsSync(join(folders.config, 'logs', 'ladarr.log')) ? readFileSync(join(folders.config, 'logs', 'ladarr.log'), 'utf8') : ''}`,
    call,
    restart: async (signal: NodeJS.Signals = 'SIGTERM') => {
      await stopServer(signal);
      await start();
    },
    server: { start, stop: stopServer, pid: () => child?.pid },

    // Creates the owner and keeps the session. Returns the session cookie for a browser.
    async createOwner() {
      const res = await call('POST', '/auth/setup', OWNER);
      const cookie = res.headers.getSetCookie()[0]!.split(';')[0]!;
      const csrf = (await (await fetch(`${URL_BASE}/api/auth/status`, { headers: { cookie } })).json()).csrfToken as string;
      session = { cookie, csrf };
      return { name: cookie.split('=')[0]!, value: cookie.slice(cookie.indexOf('=') + 1) };
    },

    // What the indexer manager does: it pushes the fake indexer to the Sonarr and Radarr adapters with the API key.
    async pushIndexer(apiKey: string) {
      const body = (categories: number[]) => ({
        id: 0,
        name: 'Tracker',
        implementation: 'Torznab',
        configContract: 'TorznabSettings',
        enableRss: true,
        enableAutomaticSearch: true,
        enableInteractiveSearch: true,
        priority: 25,
        tags: [],
        fields: [
          { name: 'baseUrl', value: `http://127.0.0.1:${tracker.port}/1/` },
          { name: 'apiPath', value: '/api' },
          { name: 'apiKey', value: 'indexer-key' },
          { name: 'categories', value: categories },
          { name: 'minimumSeeders', value: 1 },
        ],
      });
      for (const [app, categories] of [['sonarr', [5030, 5040]], ['radarr', [2040, 2045]]] as const) {
        const res = await fetch(`${URL_BASE}/${app}/api/v3/indexer`, { method: 'POST', headers: { 'x-api-key': apiKey, 'content-type': 'application/json' }, body: JSON.stringify(body([...categories])) });
        if (!res.ok) throw new Error(`Push to ${app} failed with ${res.status}`);
      }
    },

    // The end of a download: the files are in the download folder, and the client reports 100%.
    complete(name: string, files: Record<string, string>) {
      for (const [rel, content] of Object.entries(files)) {
        const abs = join(folders.downloads, name, rel);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, content);
      }
      qbit.progress(hashOf(name), 1);
    },

    async stop() {
      await stopServer();
      stopFakes();
    },
  };
}

export type Stack = Awaited<ReturnType<typeof startStack>>;

// Does the setup through the API, for the owner that createOwner made: folders, client, and indexer.
export async function configure(stack: Stack) {
  const steps: [string, string, unknown][] = [
    ['POST', '/roots', { path: stack.folders.movies, mediaType: 'movie' }],
    ['POST', '/roots', { path: stack.folders.tv, mediaType: 'tv' }],
    ['PATCH', '/settings', { region: 'US', timeZone: 'UTC' }],
    ['POST', '/settings/complete-setup', {}],
    ['POST', '/clients', { name: 'qBittorrent', type: 'qbittorrent', host: '127.0.0.1', port: stack.qbit.port, auth: { type: 'password', username: 'admin', password: 'secret' } }],
  ];
  for (const [method, path, body] of steps) {
    const res = await stack.call(method, path, body);
    if (res.status >= 300) throw new Error(`${method} ${path} answered ${res.status}: ${JSON.stringify(res.body)}`);
  }
  await stack.pushIndexer((await stack.call('GET', '/auth/api-key')).body.apiKey);
}
