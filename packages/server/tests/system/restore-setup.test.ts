import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strToU8 } from 'fflate';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.ts';
import { open, type Db } from '../../src/core/db.ts';
import { createBackup, listBackups, readBackup } from '../../src/system/backup.ts';
import { createRestorer } from '../../src/system/restore.ts';

let dir: string;
beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'ladarr-setup-restore-')));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const fresh = () => mkdtempSync(join(dir, 'case-'));

function fakeWorker() {
  return {
    pause: async () => true,
    resume: () => {},
    enqueue: () => {},
  };
}

// A backup of another installation, with an owner and data that is easy to see after the restore.
async function sourceBackup() {
  const db = await open('unused.json');
  db.data.owner = { passwordHash: 'hash', createdAt: 1 };
  db.data.settings.region = 'FR';
  db.data.blocklist = { a: { title: 'Blocked', reason: 'bad', at: 1 } };
  const sourceDir = fresh();
  const { name } = await createBackup(sourceDir, 'manual');
  return readFileSync(join(sourceDir, name));
}

// Starts the app inside the setup window: no owner and no session.
async function start(db: Db, backupDir: string) {
  const worker = fakeWorker();
  const server = createApp({ backupDir, restorer: createRestorer({ dir: backupDir, worker }) }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  return {
    base,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

// Sends the bytes as the setup page does: no session cookie and no CSRF token.
async function upload(base: string, body: Uint8Array) {
  const res = await fetch(`${base}/setup/restore`, { method: 'POST', headers: { 'content-type': 'application/zip' }, body: new Blob([body as BlobPart]) });
  return { status: res.status, body: (await res.json()) as any };
}

describe('restore during the setup', () => {
  let db: Db;
  let backupDir: string;
  let app: Awaited<ReturnType<typeof start>> | undefined;

  const startEmpty = async () => {
    backupDir = fresh();
    db = await open('unused.json');
    app = await start(db, backupDir);
  };
  afterEach(() => {
    app?.close();
    app = undefined;
  });

  it('restores the backup and writes a safety backup of the previous data', async () => {
    const bytes = await sourceBackup();
    await startEmpty();
    db.data.settings.region = 'DE';

    const res = await upload(app!.base, bytes);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, safetyBackup: expect.any(String) });
    expect(db.data.owner).not.toBeNull();
    expect(db.data.settings.region).toBe('FR');
    expect(db.data.blocklist).toEqual({ a: { title: 'Blocked', reason: 'bad', at: 1 } });
    // The backup holds no sessions, so the restore ends them all.
    expect(db.data.sessions).toEqual({});

    const safety = (await listBackups(backupDir)).find((item) => item.kind === 'safety')!;
    expect(safety.name).toBe(res.body.safetyBackup);
    const saved = await readBackup(readFileSync(join(backupDir, safety.name)));
    expect(saved.data.settings.region).toBe('DE');

    // The backup holds its owner, so the setup is done.
    const status = (await (await fetch(`${app!.base}/auth/status`)).json()) as any;
    expect(status.setupRequired).toBe(false);
  });

  it('refuses a file that is not a backup and changes nothing', async () => {
    await startEmpty();
    db.data.settings.region = 'DE';
    const before = db.data;

    const res = await upload(app!.base, strToU8('not a zip file'));
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: 'invalid_archive' });
    expect(db.data).toBe(before);
    expect(db.data.settings.region).toBe('DE');
    expect(db.data.owner).toBeNull();
    // Nothing was written, so no safety backup exists.
    expect(await listBackups(backupDir)).toEqual([]);
  });

  it('refuses the restore when an owner exists and changes nothing', async () => {
    await startEmpty();
    db.data.owner = { passwordHash: 'hash', createdAt: 1 };
    db.data.settings.region = 'DE';
    const bytes = await sourceBackup();

    const res = await upload(app!.base, bytes);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'setup_closed' });
    expect(db.data.settings.region).toBe('DE');
    expect(db.data.owner).toMatchObject({ passwordHash: 'hash' });
    expect(await listBackups(backupDir)).toEqual([]);
  });
});
