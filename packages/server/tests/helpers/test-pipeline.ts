import { mkdirSync, mkdtempSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { emptyData, open, type Db } from '../../src/core/db.ts';
import { createEvents } from '../../src/core/events.ts';
import { createFinder } from '../../src/library/grab/finder.ts';
import { createImportStatus } from '../../src/library/imports/status.ts';
import { createImporter } from '../../src/library/imports/importer.ts';
import { importRunHandler } from '../../src/jobs/import-run.ts';
import { importResumeHandler } from '../../src/jobs/import-resume.ts';
import { queueGrabHandler } from '../../src/jobs/queue-grab.ts';
import { queueSearchHandler } from '../../src/jobs/queue-search.ts';
import type { Indexer } from '../../src/library/grab/indexers.ts';
import { createIndexerService } from '../../src/library/grab/torznab.ts';
import { enqueue } from '../../src/core/jobs.ts';
import { createLimiter } from '../../src/core/limiter.ts';
import { createPoller } from '../../src/library/downloads/poller.ts';
import { createClients } from '../../src/library/downloads/client-api.ts';
import type { ClientConfig } from '../../src/library/downloads/qbittorrent.ts';
import { createQueue } from '../../src/library/downloads/queue.ts';
import { startFakeQbit } from './test-qbit.ts';
import { indexer as indexerFixture } from './test-fixtures.ts';
import { infoHashOf } from '../../src/library/grab/torrent.ts';
import { createWorker } from '../../src/core/worker.ts';
import { startTestApp } from './test-app.ts';
import type { ProbeResult } from '../../src/library/probe.ts';
import type { Handler } from '../../src/core/worker.ts';

// A torrent with one file, or with the given files (paths inside the folder that has the name of the release).
export const makeTorrent = (name: string, files?: string[], comment?: string) => {
  const list = files ? `5:filesl${files.map((file) => `d6:lengthi1000e4:pathl${file.split('/').map((part) => `${part.length}:${part}`).join('')}ee`).join('')}e` : '6:lengthi1000e';
  // The comment is a top-level key, outside the info dictionary, so the info hash does not change.
  const commentPart = comment === undefined ? '' : `7:comment${Buffer.byteLength(comment, 'utf8')}:${comment}`;
  return Buffer.from(`d8:announce5:http:${commentPart}4:infod${list}4:name${name.length}:${name}12:piece lengthi16384e6:pieces20:AAAAAAAAAAAAAAAAAAAAee`);
};
export const hashOf = (name: string, files?: string[]) => infoHashOf(makeTorrent(name, files));

export type FakeItem = { title: string; size: number; seeders?: number; category?: number; bad?: boolean; files?: string[]; comment?: string };

const xmlEscape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;');

// A Torznab server like the one in the indexer manager. `items` is what every search returns.
export async function startFakeTracker() {
  const state = { items: [] as FakeItem[], searches: [] as URL[], downloads: [] as string[], fail: false, answer: undefined as ((url: URL) => FakeItem[]) | undefined };
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    const port = (server.address() as AddressInfo).port;
    if (state.fail) return void res.writeHead(500).end();
    if (url.pathname.endsWith('/download')) {
      const file = url.searchParams.get('file')!;
      state.downloads.push(file);
      const item = state.items.find((item) => item.title === file);
      if (item?.bad) return void res.end('<html>not a torrent</html>');
      return void res.end(makeTorrent(file, item?.files, item?.comment));
    }
    const t = url.searchParams.get('t');
    if (t === 'caps') {
      return void res.end(`<caps><searching><search available="yes" supportedParams="q"/><tv-search available="yes" supportedParams="q,season,ep"/><movie-search available="yes" supportedParams="q,year,imdbid"/></searching><categories><category id="5000" name="TV"/><category id="2000" name="Movies"/></categories></caps>`);
    }
    state.searches.push(url);
    const items = state.answer ? state.answer(url) : state.items;
    res.end(
      `<?xml version="1.0"?><rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel>${items
        .map(
          (item) =>
            `<item><title>${xmlEscape(item.title)}</title><guid>${xmlEscape(item.title)}</guid><link>http://127.0.0.1:${port}/1/download?file=${encodeURIComponent(item.title)}</link><size>${item.size}</size><torznab:attr name="seeders" value="${item.seeders ?? 20}"/><torznab:attr name="category" value="${item.category ?? 5030}"/></item>`,
        )
        .join('')}</channel></rss>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    state,
    port: (server.address() as AddressInfo).port,
    close() {
      server.closeAllConnections();
      server.close();
    },
  };
}

export async function until(check: () => unknown, timeoutMs = 8_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`Timeout: ${check.toString()}`);
}

export const MIB = 1024 * 1024;

type Options = {
  probe?: (path: string) => Promise<ProbeResult>;
  afterStep?: Parameters<typeof createImporter>[0]['afterStep'];
  fs?: Parameters<typeof createImporter>[0]['fs'];
  // Replaces the write of the database, to test a disk that fails at a chosen step.
  save?: () => Promise<void>;
  indexer?: Partial<Indexer>;
  // How often the size of a running copy is read.
  copyPollMs?: number;
  // How long each import check stays in `running`. The production default is 100 ms.
  checkDelayMs?: number;
  // More job handlers, for a test that needs the metadata or the first search.
  handlers?: (context: { db: Db; events: ReturnType<typeof createEvents>; queue: ReturnType<typeof createQueue>; finder: ReturnType<typeof createFinder> }) => Record<string, Handler>;
};

// The whole path with real servers: Torznab and qBittorrent are fakes on local ports, the folders are real.
export async function startPipeline(options: Options = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ladarr-pipe-')));
  const folders = { tv: join(dir, 'tv'), movies: join(dir, 'movies'), downloads: join(dir, 'downloads') };
  for (const folder of Object.values(folders)) mkdirSync(folder);

  const db: Db = await open('unused.json');
  Object.assign(db.data, emptyData());
  db.data.roots = {
    tv: { id: 'tv', path: folders.tv, mediaType: 'tv', dev: statSync(folders.tv).dev },
    movie: { id: 'movie', path: folders.movies, mediaType: 'movie', dev: statSync(folders.movies).dev },
  };
  const tracker = await startFakeTracker();
  const qbit = await startFakeQbit({ savePath: folders.downloads });
  db.data.indexers[1] = indexerFixture({ baseUrl: `http://127.0.0.1:${tracker.port}/1/`, ...options.indexer });
  const config: ClientConfig = { id: 'client-1', name: 'qBittorrent', type: 'qbittorrent', host: '127.0.0.1', port: qbit.port, auth: { type: 'password', username: 'admin', password: 'secret' }, enabled: true, maxDownloads: 0 };
  db.data.downloadClients = [config];

  const events = createEvents();
  const published: { type: string; data: any }[] = [];
  const originalPublish = events.publish;
  events.publish = (type, data) => {
    published.push({ type, data });
    return originalPublish(type, data);
  };
  const save = options.save ?? (async () => {});
  const queue = createQueue(events, () => {});
  const limiter = createLimiter();
  const indexers = createIndexerService(limiter, { timeoutMs: 2_000 });
  const clients = createClients();
  const importStatus = createImportStatus(events, { pollMs: options.copyPollMs ?? 20 });
  let real!: ReturnType<typeof createWorker>;
  const finder = createFinder({ queue, indexers, enqueue: (input) => real.enqueue(input) });
  const handlers = {
    'queue.search': queueSearchHandler(finder),
    'queue.grab': queueGrabHandler({ queue, finder, indexers, clients, save, reconcileMs: 20 }),
    'import.run': importRunHandler({
      queue,
      events,
      clients,
      save,
      probe: options.probe ?? (async () => ({ ok: true, durationSeconds: 2700, container: 'matroska', videoCodec: 'h264', audioLanguages: ['eng'] })),
      afterStep: options.afterStep,
      fs: options.fs,
      status: importStatus,
      checkDelayMs: options.checkDelayMs ?? 0,
    }),
    'import.resume': importResumeHandler(),
    ...options.handlers?.({ db, events, queue, finder }),
  };
  real = createWorker(save, handlers, { tickMs: 15 });
  const poller = createPoller({ queue, events, clients, enqueue: (input) => real.enqueue(input), intervalMs: 20 });
  real.start();
  poller.start();

  // Simulates the end of a download: the files exist in the download folder, and the client reports 100%.
  function complete(name: string, files: Record<string, string>, hash = hashOf(name)) {
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(folders.downloads, name, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
    qbit.progress(hash, 1);
  }

  return {
    dir,
    folders,
    db,
    queue,
    finder,
    poller,
    worker: real,
    events,
    importStatus,
    published,
    tracker,
    qbit,
    complete,
    // The HTTP app on top of the same services, with a signed-in owner.
    api: (extra: Parameters<typeof startTestApp>[0] = {}) => startTestApp({ events, enqueue: (input) => real.enqueue(input), cancelJob: (id) => real.cancel(id), services: { queue, finder, poller, clients, importStatus }, ...extra }, db),
    async stop() {
      poller.stop();
      await real.stop();
      limiter.stop();
      tracker.close();
      qbit.close();
    },
  };
}
