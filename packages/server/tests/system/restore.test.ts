import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { link } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import type { Response } from 'express';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createBackup, listBackups, readBackup } from '../../src/system/backup.ts';
import { emptyData, open, SCHEMA_VERSION, set, type Data } from '../../src/core/db.ts';
import type { EnqueueInput } from '../../src/core/jobs.ts';
import { createRestorer, MAX_UPLOAD_BYTES, restoreGate } from '../../src/system/restore.ts';
import { startTestApp } from '../helpers/test-app.ts';
import { movie, title } from '../helpers/test-fixtures.ts';
import { hashOf, MIB, startPipeline, until } from '../helpers/test-pipeline.ts';
import { createWorker } from '../../src/core/worker.ts';

let dir: string;
beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'ladarr-restore-')));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const fresh = () => mkdtempSync(join(dir, 'case-'));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// A worker that records what the restore asks of it.
function fakeWorker(pause: () => Promise<boolean> = async () => true) {
  const calls = { pause: 0, resume: 0, enqueued: [] as EnqueueInput[] };
  return {
    calls,
    pause: async () => {
      calls.pause++;
      return pause();
    },
    resume: () => void calls.resume++,
    enqueue: (input: EnqueueInput) => void calls.enqueued.push(input),
  };
}

describe('restore through the API', () => {
  let backupDir: string;
  let worker: ReturnType<typeof fakeWorker>;
  let app: Awaited<ReturnType<typeof startTestApp>>;

  const start = async (pause?: () => Promise<boolean>) => {
    backupDir = fresh();
    worker = fakeWorker(pause);
    const db = await open('unused.json');
    app = await startTestApp({ backupDir, restorer: createRestorer({ dir: backupDir, worker }) }, db);
    return db;
  };
  afterEach(() => app?.close());

  it('replaces the data with the backup, makes a safety backup, and ends the sessions', async () => {
    const db = await start();
    db.data.settings.naming.movie = 'FR';
    db.data.blocklist = { a: { title: 'Kept', reason: 'bad', at: 1 } };
    const apiKey = db.data.apiKey;
    const { backup } = (await app.post('/backups')).body;

    db.data.settings.naming.movie = 'DE';
    db.data.blocklist = {};
    db.data.apiKey = 'changed after the backup';

    const res = await app.post(`/backups/${backup.name}/restore`);
    expect(res.status).toBe(200);
    expect(db.data.settings.naming.movie).toBe('FR');
    expect(db.data.blocklist).toEqual({ a: { title: 'Kept', reason: 'bad', at: 1 } });
    expect(db.data.apiKey).toBe(apiKey);
    expect(db.data.sessions).toEqual({});
    // The session of the request is gone with the others.
    expect((await app.get('/backups')).status).toBe(401);

    // The safety backup holds the data from before the restore.
    const safety = (await listBackups(backupDir)).find((item) => item.kind === 'safety')!;
    expect(safety.name).toBe(res.body.safetyBackup);
    const saved = await readBackup(readFileSync(join(backupDir, safety.name)));
    expect(saved.data.settings.naming.movie).toBe('DE');
    expect(saved.data.apiKey).toBe('changed after the backup');
    // The worker stopped before the safety backup and runs again after the restore.
    expect(worker.calls).toMatchObject({ pause: 1, resume: 1 });
  });

  // Sends bytes as a backup file, like the Settings page does.
  async function upload(body: Uint8Array, type = 'application/zip') {
    const { csrfToken } = await (await fetch(`${app.base}/auth/status`, { headers: { cookie: app.cookie } })).json();
    const res = await fetch(`${app.base}/backups/restore`, { method: 'POST', headers: { cookie: app.cookie, 'x-csrf-token': csrfToken, 'content-type': type }, body: new Blob([body as BlobPart]) });
    return { status: res.status, body: (await res.json()) as any };
  }

  it('restores a backup file that is not in the backup folder', async () => {
    const db = await start();
    db.data.settings.naming.movie = 'FR';
    const { backup } = (await app.post('/backups')).body;
    // The file comes from another machine: the folder does not have it.
    const bytes = readFileSync(join(backupDir, backup.name));
    rmSync(join(backupDir, backup.name));
    db.data.settings.naming.movie = 'DE';

    const res = await upload(bytes);
    expect(res.status).toBe(200);
    expect(db.data.settings.naming.movie).toBe('FR');
    expect(db.data.sessions).toEqual({});
    // The safety backup holds the data from before the restore, and the sent file is not kept in the folder.
    const kept = await listBackups(backupDir);
    expect(kept.map((item) => item.kind)).toEqual(['safety']);
    expect(kept[0]!.name).toBe(res.body.safetyBackup);
    expect((await readBackup(readFileSync(join(backupDir, kept[0]!.name)))).data.settings.naming.movie).toBe('DE');
    expect(worker.calls).toMatchObject({ pause: 1, resume: 1 });
  });

  it('changes nothing when the file is not a backup, is damaged, or comes from a newer version', async () => {
    const db = await start();
    db.data.settings.naming.movie = 'DE';
    const { backup } = (await app.post('/backups')).body;
    const bytes = readFileSync(join(backupDir, backup.name));
    const files = unzipSync(bytes);
    const newer = zipSync({ ...files, 'manifest.json': strToU8(JSON.stringify({ ...JSON.parse(strFromU8(files['manifest.json']!)), schemaVersion: SCHEMA_VERSION + 1 })) });
    const damagedDb = zipSync({ ...files, 'db.json': strToU8('{"settings":{}}') });

    expect(await upload(strToU8('not a zip file'))).toMatchObject({ status: 422, body: { error: 'invalid_archive' } });
    expect(await upload(damagedDb)).toMatchObject({ status: 422, body: { error: 'checksum_mismatch' } });
    expect(await upload(newer)).toMatchObject({ status: 422, body: { error: 'unsupported_schema' } });
    expect(await upload(new Uint8Array())).toMatchObject({ status: 400, body: { error: 'invalid_archive' } });
    expect(await upload(bytes, 'text/plain')).toMatchObject({ status: 400, body: { error: 'invalid_archive' } });
    expect(db.data.settings.naming.movie).toBe('DE');
    // Nothing was written, so the worker did not stop and no safety backup exists.
    expect(worker.calls).toMatchObject({ pause: 0, resume: 0 });
    expect((await listBackups(backupDir)).map((item) => item.kind)).toEqual(['manual']);
  });

  it('does not restore a sent file for the API key, only for a session', async () => {
    const db = await start();
    const res = await fetch(`${app.base}/backups/restore`, { method: 'POST', headers: { 'x-api-key': db.data.apiKey!, 'content-type': 'application/zip' }, body: new Blob([new Uint8Array(4)]) });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'session_required' });
  });

  it('refuses a file that is too large before it reads the body', async () => {
    await start();
    const { csrfToken } = await (await fetch(`${app.base}/auth/status`, { headers: { cookie: app.cookie } })).json();
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(new URL(`${app.base}/backups/restore`), { method: 'POST', headers: { cookie: app.cookie, 'x-csrf-token': csrfToken, 'content-type': 'application/zip', 'content-length': String(MAX_UPLOAD_BYTES + 1) } }, (res) => {
        res.resume();
        resolve(res.statusCode!);
        req.destroy();
      });
      req.on('error', (err) => ((err as NodeJS.ErrnoException).code === 'ECONNRESET' ? undefined : reject(err)));
      req.flushHeaders();
    });
    expect(status).toBe(413);
  });

  it('gives the safety backup its own kind', async () => {
    const db = await start();
    const { backup } = (await app.post('/backups')).body;
    await app.post(`/backups/${backup.name}/restore`);
    expect((await listBackups(backupDir)).map((item) => item.kind).sort()).toEqual(['manual', 'safety']);
    expect(db.data.owner?.passwordHash).toEqual(expect.any(String));
    expect(db.data.owner).not.toHaveProperty('username');
  });

  const damaged = (files: Record<string, Uint8Array>, change: (manifest: any) => any = (manifest) => manifest, replace: Record<string, Uint8Array> = {}) => ({
    ...files,
    'manifest.json': strToU8(JSON.stringify(change(JSON.parse(strFromU8(files['manifest.json']!))))),
    ...replace,
  });

  it.each([
    ['a file that is not a ZIP', () => strToU8('not a zip'), 'invalid_archive'],
    ['a database that does not match its checksum', (files: Record<string, Uint8Array>) => zipSync(damaged(files, undefined, { 'db.json': strToU8('{}') })), 'checksum_mismatch'],
    ['a newer schema in the manifest', (files: Record<string, Uint8Array>) => zipSync(damaged(files, (m) => ({ ...m, schemaVersion: SCHEMA_VERSION + 1 }))), 'unsupported_schema'],
    ['a manifest of another program', (files: Record<string, Uint8Array>) => zipSync(damaged(files, (m) => ({ ...m, app: 'other' }))), 'invalid_archive'],
    ['a manifest without a schema version', (files: Record<string, Uint8Array>) => zipSync(damaged(files, ({ schemaVersion, ...m }) => m)), 'invalid_archive'],
  ])('refuses %s and changes nothing', async (_label, build, code) => {
    const db = await start();
    const { backup } = (await app.post('/backups')).body;
    const files = unzipSync(readFileSync(join(backupDir, backup.name)));
    const badName = 'ladarr-manual-20200101T000000000Z.zip';
    writeFileSync(join(backupDir, badName), build(files));
    db.data.settings.naming.movie = 'DE';
    const before = db.data;

    const res = await app.post(`/backups/${badName}/restore`);
    expect(res.status).toBe(422);
    expect(res.body.error).toBe(code);
    expect(db.data).toBe(before);
    expect(db.data.settings.naming.movie).toBe('DE');
    expect((await app.get('/backups')).status).toBe(200);
    expect((await listBackups(backupDir)).some((item) => item.kind === 'safety')).toBe(false);
    expect(worker.calls.pause).toBe(0);
  });

  it('refuses a database with a collection of the wrong type, also when the checksum matches', async () => {
    const db = await start();
    const { backup } = (await app.post('/backups')).body;
    const files = unzipSync(readFileSync(join(backupDir, backup.name)));
    const broken = strToU8(JSON.stringify({ ...JSON.parse(strFromU8(files['db.json']!)), titles: [] }));
    const manifest = JSON.parse(strFromU8(files['manifest.json']!));
    manifest.files['db.json'].sha256 = createHash('sha256').update(broken).digest('hex');
    writeFileSync(join(backupDir, 'ladarr-manual-20200101T000000000Z.zip'), zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest)), 'db.json': broken }));
    const before = db.data;

    const res = await app.post('/backups/ladarr-manual-20200101T000000000Z.zip/restore');
    expect(res.body.error).toBe('invalid_archive');
    expect(db.data).toBe(before);
  });

  it('refuses a newer schema in the database file, also when the manifest says otherwise', async () => {
    const db = await start();
    const { backup } = (await app.post('/backups')).body;
    const files = unzipSync(readFileSync(join(backupDir, backup.name)));
    const newer = strToU8(JSON.stringify({ ...JSON.parse(strFromU8(files['db.json']!)), schemaVersion: SCHEMA_VERSION + 1 }));
    const manifest = JSON.parse(strFromU8(files['manifest.json']!));
    manifest.files['db.json'].sha256 = createHash('sha256').update(newer).digest('hex');
    writeFileSync(join(backupDir, 'ladarr-manual-20200101T000000000Z.zip'), zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest)), 'db.json': newer }));
    const before = db.data;

    const res = await app.post('/backups/ladarr-manual-20200101T000000000Z.zip/restore');
    expect(res.body.error).toBe('unsupported_schema');
    expect(db.data).toBe(before);
  });

  it.each(['ladarr-manual-20200101T000000000Z.zip', 'db.json', '..%2Fx'])('answers 404 for the backup %s', async (name) => {
    await start();
    expect((await app.post(`/backups/${name}/restore`)).status).toBe(404);
  });

  it('does not restore for the API key, only for a session', async () => {
    const db = await start();
    const { backup } = (await app.post('/backups')).body;
    db.data.settings.naming.movie = 'DE';
    const res = await fetch(`${app.base}/backups/${backup.name}/restore`, { method: 'POST', headers: { 'x-api-key': db.data.apiKey! } });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'session_required' });
    expect(db.data.settings.naming.movie).toBe('DE');
  });

  it('changes nothing when a job does not stop', async () => {
    const db = await start(async () => false);
    const { backup } = (await app.post('/backups')).body;
    db.data.settings.naming.movie = 'DE';
    const before = db.data;

    const res = await app.post(`/backups/${backup.name}/restore`);
    expect(res).toMatchObject({ status: 409, body: { error: 'worker_busy' } });
    expect(db.data).toBe(before);
    expect(db.data.settings.naming.movie).toBe('DE');
    expect(worker.calls.resume).toBe(1);
    expect((await listBackups(backupDir)).some((item) => item.kind === 'safety')).toBe(false);
  });

  it('keeps the data and starts the worker again when the file can not be written', async () => {
    const db = await start();
    const { backup } = (await app.post('/backups')).body;
    db.data.settings.naming.movie = 'DE';
    const before = db.data;
    db.write = async () => {
      throw new Error('disk full');
    };

    const res = await app.post(`/backups/${backup.name}/restore`);
    expect(res.status).toBe(500);
    expect(db.data).toBe(before);
    expect(db.data.settings.naming.movie).toBe('DE');
    expect(worker.calls.resume).toBe(1);
    // The gate opens again.
    expect((await app.post('/backups')).status).toBe(201);
  });

  it('refuses writes, the indexer manager adapters and a second restore while a restore runs, but not reads', async () => {
    let release!: (idle: boolean) => void;
    const db = await start(() => new Promise<boolean>((resolve) => (release = resolve)));
    const { backup } = (await app.post('/backups')).body;
    db.data.settings.naming.movie = 'DE';

    const running = app.post(`/backups/${backup.name}/restore`);
    await until(() => worker.calls.pause === 1);

    expect(await app.post('/backups')).toMatchObject({ status: 503, body: { error: 'restore_in_progress' } });
    expect(await app.post(`/backups/${backup.name}/restore`)).toMatchObject({ status: 503, body: { error: 'restore_in_progress' } });
    // The adapters for the indexer manager change the indexers, so they wait too.
    const sync = await fetch(`${app.base.replace('/api', '/sonarr/api/v3')}/indexer/1`, { method: 'DELETE', headers: { 'x-api-key': db.data.apiKey! } });
    expect(sync.status).toBe(503);
    expect((await app.get('/backups')).status).toBe(200);
    // Nothing was written yet.
    expect(db.data.settings.naming.movie).toBe('DE');

    release(true);
    expect((await running).status).toBe(200);
    expect(db.data.settings.naming.movie).toBe('{title} ({year})');
    expect(worker.calls.pause).toBe(1);
  });

  it('asks for the jobs that read the disk and the client: unfinished imports, and a scan of each folder without an import', async () => {
    const db = await start();
    const withFolder = movie({ rootId: 'movie', folder: 'Movie Name (2019)' });
    const withoutFolder = title({ key: 'tv:9', tmdbId: 9, folder: null });
    const importing = title({ key: 'tv:10', tmdbId: 10, folder: 'Show Ten' });
    db.data.titles = { [withFolder.key]: withFolder, [withoutFolder.key]: withoutFolder, [importing.key]: importing };
    db.data.imports = { a: { id: 'a', hash: 'h1', titleKey: importing.key, steps: [], createdAt: 1 }, b: { id: 'b', hash: 'h1', titleKey: importing.key, steps: [], createdAt: 1 } };
    const { backup } = (await app.post('/backups')).body;
    db.data.titles = {};
    db.data.imports = {};

    await app.post(`/backups/${backup.name}/restore`);
    expect(worker.calls.enqueued).toEqual([
      { type: 'import.run', payload: { hash: 'h1' }, dedupeKey: 'import:h1' },
      { type: 'library.scan', payload: { key: withFolder.key }, dedupeKey: `scan:${withFolder.key}` },
    ]);
  });
});

describe('requests that change data', () => {
  const setup = async (drainMs?: number) => {
    const backupDir = fresh();
    const db = await open('unused.json');
    const worker = fakeWorker();
    const restorer = createRestorer({ dir: backupDir, worker, drainMs });
    const { name } = await createBackup(backupDir, 'manual');
    return { db, worker, restorer, name };
  };
  const response = () => new EventEmitter() as unknown as Response;

  it('are awaited by the restore, so none writes into the restored data', async () => {
    const { db, worker, restorer, name } = await setup();
    const pending = response();
    restorer.track(pending);
    db.data.settings.naming.movie = 'DE';

    const done = restorer.restore(name);
    await sleep(80);
    expect(worker.calls.pause).toBe(0);
    expect(db.data.settings.naming.movie).toBe('DE');

    pending.emit('close');
    await done;
    expect(db.data.settings.naming.movie).toBe('{title} ({year})');
  });

  it('stop the restore when one does not end, and the data stays', async () => {
    const { db, worker, restorer, name } = await setup(60);
    restorer.track(response());
    db.data.settings.naming.movie = 'DE';

    await expect(restorer.restore(name)).rejects.toMatchObject({ code: 'requests_busy' });
    expect(db.data.settings.naming.movie).toBe('DE');
    expect(worker.calls.pause).toBe(0);
    expect(restorer.busy()).toBe(false);
  });

  it('are tracked by the gate, and a read is not', () => {
    const tracked: unknown[] = [];
    const gate = restoreGate({ busy: () => false, track: (res: unknown) => tracked.push(res) } as never);
    gate({ method: 'GET' } as never, {} as never, () => {});
    gate({ method: 'POST' } as never, {} as never, () => {});
    expect(tracked).toHaveLength(1);
  });
});

describe('the file on the disk', () => {
  it('holds the restored data after a restore, and the old data when the write fails', async () => {
    const backupDir = fresh();
    const file = join(fresh(), 'db.json');
    const db = new Low<Data>(new JSONFile<Data>(file), emptyData());
    set(db);
    db.data.settings.naming.movie = 'FR';
    await db.write();
    const worker = fakeWorker();
    const restorer = createRestorer({ dir: backupDir, worker });
    const { name } = await createBackup(backupDir, 'manual');

    db.data.settings.naming.movie = 'DE';
    await db.write();
    await restorer.restore(name);
    expect(JSON.parse(readFileSync(file, 'utf8')).settings.naming.movie).toBe('FR');
    expect(readdirSync(join(file, '..'))).toEqual(['db.json']);

    // A failed write: the file keeps the old data, and so does the memory.
    db.data.settings.naming.movie = 'DE';
    await db.write();
    db.adapter.write = async () => {
      throw new Error('disk full');
    };
    await expect(restorer.restore(name)).rejects.toThrow('disk full');
    expect(db.data.settings.naming.movie).toBe('DE');
    expect(JSON.parse(readFileSync(file, 'utf8')).settings.naming.movie).toBe('DE');
  });

  it('fills a collection that an older backup lacks', async () => {
    const backupDir = fresh();
    const db = await open('unused.json');
    const old: Partial<Data> = { ...emptyData() };
    delete old.blocklist;
    const json = strToU8(JSON.stringify(old));
    const manifest = { format: 1, app: 'ladarr', appVersion: '0.0.0', schemaVersion: 1, createdAt: new Date().toISOString(), kind: 'manual', files: { 'db.json': { bytes: json.length, sha256: createHash('sha256').update(json).digest('hex') } }, excludes: [] };
    const name = 'ladarr-manual-20200101T000000000Z.zip';
    writeFileSync(join(backupDir, name), zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest)), 'db.json': json }));

    await createRestorer({ dir: backupDir, worker: fakeWorker() }).restore(name);
    expect(db.data.blocklist).toEqual({});
  });
});

describe('worker pause', () => {
  const newWorker = async (handlers: Parameters<typeof createWorker>[1], graceMs = 2_000) => {
    const db = await open('unused.json');
    const worker = createWorker(async () => {}, handlers, { tickMs: 10, graceMs });
    worker.start();
    return { db, worker };
  };

  it('stops a running job, gives it back, and starts no job until the resume', async () => {
    let started = 0;
    const { db, worker } = await newWorker({
      a: {
        run: (_job, { signal }) => {
          started++;
          return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
        },
      },
    });
    worker.enqueue({ type: 'a' });
    await until(() => started === 1);

    expect(await worker.pause()).toBe(true);
    const [job] = Object.values(db.data.jobs);
    expect(job).toMatchObject({ state: 'waiting', attempts: 0 });

    worker.enqueue({ type: 'a', dedupeKey: 'other' });
    await sleep(60);
    expect(started).toBe(1);

    worker.resume();
    await until(() => started === 2);
    await worker.stop();
  });

  it('returns false when a job does not stop in the grace time', async () => {
    let finish!: () => void;
    const { worker } = await newWorker({ a: { run: () => new Promise<void>((resolve) => (finish = resolve)) } }, 40);
    worker.enqueue({ type: 'a' });
    await until(() => finish);
    expect(await worker.pause()).toBe(false);
    finish();
    worker.resume();
    await worker.stop();
  });

  it('keeps the heartbeat moving while it is paused', async () => {
    const { worker } = await newWorker({});
    await worker.pause();
    const before = worker.heartbeat;
    await sleep(40);
    expect(worker.heartbeat).toBeGreaterThan(before);
    await worker.stop();
  });

  it('puts the periodic jobs back when the data came from an older backup', async () => {
    const { db, worker } = await newWorker({ tidy: { run: async () => {}, every: 60_000 } });
    await worker.pause();
    db.data = emptyData();
    worker.resume();
    expect(Object.values(db.data.jobs).map((job) => job.type)).toEqual(['tidy']);
    await worker.stop();
  });
});

// A restore of a backup that was made in the middle of an import. The journal in the backup and the files on the disk can differ.
describe('restore with an interrupted import journal', () => {
  let pipe: Awaited<ReturnType<typeof startPipeline>> | undefined;
  afterEach(async () => {
    await pipe?.stop();
    pipe = undefined;
  });

  const NAME = 'Movie.Name.2019.1080p.BluRay.x264-GRP';
  // The retry of a failed import job is due after 5 s. A wait of 3 s proves that the restore asked for the job.
  const SOON = 3_000;

  // Stops the import after a step, and makes a backup at that point.
  async function interrupted(stopAfter: 'staged' | 'published' | 'committed', options: Parameters<typeof startPipeline>[0] = {}, beforeBackup?: (data: Data) => void) {
    let armed = true;
    pipe = await startPipeline({
      ...options,
      afterStep: (state) => {
        if (armed && state === stopAfter) {
          armed = false;
          throw new Error('stop');
        }
      },
    });
    const film = movie({ rootId: 'movie', manualRelease: true });
    pipe.db.data.titles[film.key] = film;
    pipe.tracker.state.items = [{ title: NAME, size: 100 * 120 * MIB }];
    const [entry] = pipe.finder.requestSearch(film.key);
    await until(() => entry!.stage === 'downloading');
    pipe.complete(NAME, { [`${NAME}.mkv`]: 'video-data' });
    await until(() => !armed);
    await sleep(50);
    expect(Object.keys(pipe.db.data.imports)).toHaveLength(1);

    beforeBackup?.(pipe.db.data);
    const backupDir = fresh();
    const { name } = await createBackup(backupDir, 'manual');
    // The backup holds the queue entry and the journal, because it holds the database.
    const saved = await readBackup(readFileSync(join(backupDir, name)));
    expect(Object.keys(saved.data.imports)).toHaveLength(1);
    expect(saved.data.queue[entry!.id]).toBeDefined();
    const restorer = createRestorer({ dir: backupDir, worker: pipe.worker });
    const finishLive = async () => {
      pipe!.worker.enqueue({ type: 'import.run', payload: { hash: hashOf(NAME) }, dedupeKey: `import:${hashOf(NAME)}` });
      await until(() => pipe!.db.data.queue[entry!.id]!.stage === 'available' && Object.keys(pipe!.db.data.imports).length === 0, 12_000);
    };
    return { film, entry: entry!, backup: name, restorer, finishLive };
  }

  const expectDone = (entryId: string, filmKey: string) => {
    const { db, folders } = pipe!;
    expect(db.data.queue[entryId]!.stage).toBe('available');
    expect(db.data.imports).toEqual({});
    const files = Object.values(db.data.files);
    expect(files).toHaveLength(1);
    expect(db.data.titles[filmKey]!.fileId).toBe(files[0]!.id);
    // The file has its data, nothing is staged, and the source of the seed is whole.
    expect(readFileSync(join(folders.movies, files[0]!.path), 'utf8')).toBe('video-data');
    expect(readdirSync(join(folders.movies, 'Movie Name (2019)'))).toEqual(['Movie Name (2019).mkv']);
    expect(readFileSync(join(folders.downloads, NAME, `${NAME}.mkv`), 'utf8')).toBe('video-data');
  };

  // The disk is as it was at the backup: the import goes on from the journal.
  it.each(['staged', 'published', 'committed'] as const)('finishes the import when the disk is as it was after %s', async (stopAfter) => {
    const { film, entry, backup, restorer } = await interrupted(stopAfter);
    await restorer.restore(backup);
    await until(() => pipe!.db.data.queue[entry.id]!.stage === 'available' && Object.keys(pipe!.db.data.imports).length === 0, SOON);
    expectDone(entry.id, film.key);
  }, 25_000);

  // The import ended after the backup. The journal in the backup is old, and the files are final.
  it.each(['staged', 'published', 'committed'] as const)('finishes the import when the disk is further than the journal of %s', async (stopAfter) => {
    const { film, entry, backup, restorer, finishLive } = await interrupted(stopAfter);
    await finishLive();
    const finalFile = readFileSync(join(pipe!.folders.movies, 'Movie Name (2019)', 'Movie Name (2019).mkv'), 'utf8');

    await restorer.restore(backup);
    // The data went back: the file is not in the library again until the import reads the disk.
    await until(() => pipe!.db.data.queue[entry.id]!.stage === 'available' && Object.keys(pipe!.db.data.imports).length === 0, SOON);
    expect(finalFile).toBe('video-data');
    expectDone(entry.id, film.key);
  }, 40_000);

  it('stops with a reason and keeps the file when a copy is at the destination and the journal is older', async () => {
    const noLink = async (source: import('node:fs').PathLike, target: import('node:fs').PathLike) => {
      if (String(target).includes('.ladarr-')) throw Object.assign(new Error('no link'), { code: 'EXDEV' });
      return link(source, target);
    };
    // The backup was made before the file was staged.
    const { film, entry, backup, restorer, finishLive } = await interrupted('staged', { fs: { link: noLink } }, (data) => {
      Object.values(data.imports)[0]!.steps[0]!.state = 'planned';
    });
    await finishLive();
    const dest = join(pipe!.folders.movies, 'Movie Name (2019)', 'Movie Name (2019).mkv');
    expect(readFileSync(dest, 'utf8')).toBe('video-data');

    await restorer.restore(backup);
    await until(() => pipe!.db.data.queue[entry.id]!.reason?.code === 'destination_exists' && Object.keys(pipe!.db.data.imports).length === 0, SOON);
    expect(pipe!.db.data.queue[entry.id]!.reason?.code).toBe('destination_exists');
    // No data is lost: the file is whole, nothing is staged, and the source of the seed is whole.
    expect(readFileSync(dest, 'utf8')).toBe('video-data');
    expect(readdirSync(join(pipe!.folders.movies, 'Movie Name (2019)'))).toEqual(['Movie Name (2019).mkv']);
    expect(readFileSync(join(pipe!.folders.downloads, NAME, `${NAME}.mkv`), 'utf8')).toBe('video-data');
    expect(pipe!.db.data.titles[film.key]!.fileId).toBeNull();
  }, 40_000);
});
