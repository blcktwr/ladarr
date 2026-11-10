import { mkdtempSync, realpathSync, rmSync, statSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BackupError, createBackup, isBackupName, listBackups, pruneBackups, readBackup } from '../../src/system/backup.ts';
import { backupAutoHandler } from '../../src/jobs/backup-auto.ts';
import { open, SCHEMA_VERSION } from '../../src/core/db.ts';
import { startTestApp } from '../helpers/test-app.ts';

let dir: string;
beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'ladarr-backup-')));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const fresh = () => {
  const path = mkdtempSync(join(dir, 'case-'));
  return path;
};
const DAY = 24 * 60 * 60_000;

async function dbWithTitle() {
  const db = await open('unused.json');
  db.data.owner = { passwordHash: 'hash', createdAt: 1 };
  db.data.sessions = { abc: { csrfToken: 'x', createdAt: 1, expiresAt: 2 } };
  db.data.apiKey = 'key';
  return db;
}

describe('backup file', () => {
  it('holds a manifest and the database, without the login sessions', async () => {
    const db = await dbWithTitle();
    const target = fresh();
    const made = await createBackup(db, target, 'manual');
    expect(isBackupName(made.name)).toBe(true);

    const files = unzipSync(readFileSync(join(target, made.name)));
    expect(Object.keys(files).sort()).toEqual(['db.json', 'manifest.json']);
    const manifest = JSON.parse(strFromU8(files['manifest.json']!));
    expect(manifest).toMatchObject({ app: 'ladarr', format: 1, schemaVersion: SCHEMA_VERSION, kind: 'manual', excludes: ['sessions', 'media'] });
    expect(manifest.appVersion).toMatch(/^\d+\.\d+\.\d+/);

    const { data } = await readBackup(readFileSync(join(target, made.name)));
    expect(data.sessions).toEqual({});
    expect(data.owner).toMatchObject({ passwordHash: 'hash', createdAt: 1 });
    expect(data.owner).not.toHaveProperty('username');
    expect(data.apiKey).toBe('key');
    // The live database keeps its sessions.
    expect(Object.keys(db.data.sessions)).toEqual(['abc']);
  });

  it('can be read by its owner only', async () => {
    const target = fresh();
    const made = await createBackup(await dbWithTitle(), target, 'manual');
    expect(statSync(join(target, made.name)).mode & 0o777).toBe(0o600);
  });

  it('keeps the data as it was when the backup started, even if the data changes while it is written', async () => {
    const db = await dbWithTitle();
    const target = fresh();
    const pending = createBackup(db, target, 'manual');
    db.data.apiKey = 'changed after the start';
    const made = await pending;
    const { data } = await readBackup(readFileSync(join(target, made.name)));
    expect(data.apiKey).toBe('key');
  });

  it('leaves no temporary file', async () => {
    const target = fresh();
    await createBackup(await dbWithTitle(), target, 'manual');
    expect(readdirSync(target).every((name) => isBackupName(name))).toBe(true);
  });
});

describe('reading a bad backup', () => {
  const good = async () => {
    const target = fresh();
    const made = await createBackup(await dbWithTitle(), target, 'manual');
    return unzipSync(readFileSync(join(target, made.name)));
  };
  const code = (bytes: Uint8Array) => readBackup(bytes).then(() => 'ok', (err: BackupError) => err.code);

  it('refuses a file that is not a ZIP', async () => {
    expect(await code(strToU8('not a zip'))).toBe('invalid_archive');
  });

  it('refuses an archive that lacks a file', async () => {
    const files = await good();
    expect(await code(zipSync({ 'manifest.json': files['manifest.json']! }))).toBe('invalid_archive');
  });

  it('refuses a database that does not match its checksum', async () => {
    const files = await good();
    expect(await code(zipSync({ ...files, 'db.json': strToU8('{"owner":null}') }))).toBe('checksum_mismatch');
  });

  it('refuses a manifest of another program', async () => {
    const files = await good();
    const manifest = JSON.parse(strFromU8(files['manifest.json']!));
    expect(await code(zipSync({ ...files, 'manifest.json': strToU8(JSON.stringify({ ...manifest, app: 'other' })) }))).toBe('invalid_archive');
  });

  it('refuses a backup from a newer schema', async () => {
    const files = await good();
    const manifest = JSON.parse(strFromU8(files['manifest.json']!));
    const bumped = { ...manifest, schemaVersion: SCHEMA_VERSION + 1 };
    expect(await code(zipSync({ ...files, 'manifest.json': strToU8(JSON.stringify(bumped)) }))).toBe('unsupported_schema');
  });

  it('ignores a file that it does not know, and a path that leaves the folder', async () => {
    const files = await good();
    const bytes = zipSync({ ...files, '../../evil.txt': strToU8('x'), 'extra.bin': strToU8('x') });
    const result = await readBackup(bytes);
    expect(Object.keys(result)).toEqual(['manifest', 'data']);
  });
});

describe('retention and the daily job', () => {
  it('keeps the newest automatic backups and every manual one', async () => {
    const target = fresh();
    const db = await dbWithTitle();
    const now = Date.now();
    for (let i = 0; i < 10; i++) await createBackup(db, target, 'auto', new Date(now - i * DAY));
    await createBackup(db, target, 'manual', new Date(now - 30 * DAY));
    await pruneBackups(target);
    const left = await listBackups(target);
    expect(left.filter((b) => b.kind === 'auto')).toHaveLength(7);
    expect(left.filter((b) => b.kind === 'manual')).toHaveLength(1);
    // The seven that stay are the newest.
    expect(Math.min(...left.filter((b) => b.kind === 'auto').map((b) => b.createdAt))).toBeGreaterThan(now - 7 * DAY);
  });

  it('makes a backup when none exists, and not again within a day', async () => {
    const target = fresh();
    const db = await dbWithTitle();
    const run = () => backupAutoHandler(db, target).run({} as never, { signal: new AbortController().signal });
    await run();
    await run();
    expect(await listBackups(target)).toHaveLength(1);
  });

  it('makes a backup when the last automatic one is older than a day', async () => {
    const target = fresh();
    const db = await dbWithTitle();
    await createBackup(db, target, 'auto', new Date(Date.now() - 2 * DAY));
    await backupAutoHandler(db, target).run({} as never, { signal: new AbortController().signal });
    expect(await listBackups(target)).toHaveLength(2);
  });
});

describe('backup API', () => {
  let app: Awaited<ReturnType<typeof startTestApp>>;
  let backupDir: string;
  beforeAll(async () => {
    backupDir = join(dir, 'api-backups');
    app = await startTestApp({ backupDir });
  });
  afterAll(() => app.close());

  it('needs a session', async () => {
    expect((await fetch(`${app.base}/backups`)).status).toBe(401);
  });

  it('makes, lists, downloads and deletes a backup', async () => {
    const made = await app.post('/backups');
    expect(made.status).toBe(201);
    const { name } = made.body.backup;
    expect((await app.get('/backups')).body.backups.map((b: { name: string }) => b.name)).toEqual([name]);

    const download = await fetch(`${app.base}/backups/${name}/download`, { headers: { cookie: app.cookie } });
    expect(download.status).toBe(200);
    expect(download.headers.get('content-disposition')).toContain(name);
    const { data } = await readBackup(new Uint8Array(await download.arrayBuffer()));
    expect(data.owner?.passwordHash).toEqual(expect.any(String));
    expect(data.owner).not.toHaveProperty('username');

    expect((await app.del(`/backups/${name}`)).status).toBe(200);
    expect((await app.get('/backups')).body.backups).toEqual([]);
    expect((await app.del(`/backups/${name}`)).status).toBe(404);
  });

  it.each(['..%2F..%2Fetc%2Fpasswd', 'db.json', 'ladarr-manual-1.zip'])('does not serve the name %s', async (name) => {
    const res = await fetch(`${app.base}/backups/${name}/download`, { headers: { cookie: app.cookie } });
    expect(res.status).toBe(404);
  });
});

describe('a folder that is empty', () => {
  it('lists no backups when the folder does not exist', async () => {
    expect(await listBackups(join(dir, 'nothing-here'))).toEqual([]);
  });
});
