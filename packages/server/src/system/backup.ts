import type { BackupKind } from '@ladarr/shared/enums';
import type { BackupRow } from '@ladarr/shared/types';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Router } from 'express';
import { strFromU8, strToU8, unzip, zip } from 'fflate';
import { emptyData, SCHEMA_VERSION, type Data, type Db } from '../core/db.ts';
import { APP_VERSION } from './version.ts';

// A safety backup is the copy that a restore makes of the current data before it replaces the data.
export class BackupError extends Error {
  code: 'invalid_archive' | 'checksum_mismatch' | 'unsupported_schema';
  constructor(code: BackupError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

// The name holds the time with milliseconds, so two backups never share a name.
const NAME = /^ladarr-(auto|manual|safety)-(\d{8})T(\d{9})Z\.zip$/;
export const isBackupName = (name: string) => NAME.test(name);

const KEEP_AUTO = 7;
// A backup is a copy of the database. This limit stops an archive that expands without end.
const MAX_UNPACKED_BYTES = 1024 ** 3;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

// Each collection and counter must have the type that the code expects. A file with a matching checksum can still be wrong.
const hasShape = (data: unknown): data is Data =>
  isObject(data) &&
  Object.entries(emptyData()).every(([key, fallback]) => !(key in data) || (typeof fallback === 'number' ? typeof data[key] === 'number' : isObject(fallback) ? isObject(data[key]) : true));

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const stamp = (date: Date) => date.toISOString().replace(/[-:.]/g, '');
const parseTime = (name: string) => {
  const [, , day, time] = NAME.exec(name)!;
  return Date.parse(`${day!.slice(0, 4)}-${day!.slice(4, 6)}-${day!.slice(6, 8)}T${time!.slice(0, 2)}:${time!.slice(2, 4)}:${time!.slice(4, 6)}.${time!.slice(6)}Z`);
};

const zipAsync = (files: Record<string, Uint8Array>) =>
  new Promise<Uint8Array>((resolve, reject) => zip(files, { level: 6 }, (err, data) => (err ? reject(err) : resolve(data))));

// Reads and checks a backup. It never writes to the disk, so a bad archive cannot change the installation.
export async function readBackup(bytes: Uint8Array): Promise<{ manifest: Manifest; data: Data }> {
  const files = await new Promise<Record<string, Uint8Array>>((resolve, reject) =>
    unzip(
      bytes,
      // Only the two known files, and only below the size limit.
      { filter: (file) => (file.name === 'manifest.json' || file.name === 'db.json') && file.originalSize <= MAX_UNPACKED_BYTES },
      (err, data) => (err ? reject(new BackupError('invalid_archive', 'The file is not a backup of this app.')) : resolve(data)),
    ),
  );
  if (!files['manifest.json'] || !files['db.json']) throw new BackupError('invalid_archive', 'The backup lacks a file.');
  let manifest: Manifest;
  let data: Data;
  try {
    manifest = JSON.parse(strFromU8(files['manifest.json']));
    if (manifest.app !== 'ladarr' || manifest.format !== 1 || !Number.isInteger(manifest.schemaVersion)) throw new Error('format');
    if (sha256(files['db.json']) !== manifest.files['db.json']?.sha256) throw new BackupError('checksum_mismatch', 'The backup is damaged.');
    data = JSON.parse(strFromU8(files['db.json']));
    if (!hasShape(data)) throw new Error('shape');
  } catch (err) {
    if (err instanceof BackupError) throw err;
    throw new BackupError('invalid_archive', 'The file is not a backup of this app.');
  }
  if (Math.max(manifest.schemaVersion, data.schemaVersion ?? 0) > SCHEMA_VERSION) throw new BackupError('unsupported_schema', 'The backup is from a newer version.');
  return { manifest, data };
}

type Manifest = {
  format: 1;
  app: 'ladarr';
  appVersion: string;
  schemaVersion: number;
  createdAt: string;
  kind: BackupKind;
  files: Record<string, { bytes: number; sha256: string }>;
  // The backup holds no media files and no login sessions.
  excludes: string[];
};

export async function listBackups(dir: string): Promise<BackupRow[]> {
  const names = (await readdir(dir).catch(() => [])).filter(isBackupName);
  const items = await Promise.all(
    names.map(async (name) => ({ name, kind: NAME.exec(name)![1] as BackupKind, createdAt: parseTime(name), bytes: (await stat(join(dir, name))).size })),
  );
  return items.sort((a, b) => b.createdAt - a.createdAt);
}

export async function createBackup(db: Db, dir: string, kind: BackupKind, now = new Date()): Promise<BackupRow> {
  // The snapshot is one synchronous step, so no change can land in the middle of it.
  const json = strToU8(JSON.stringify({ ...db.data, sessions: {} }));
  const manifest: Manifest = {
    format: 1,
    app: 'ladarr',
    appVersion: APP_VERSION,
    schemaVersion: SCHEMA_VERSION,
    createdAt: now.toISOString(),
    kind,
    files: { 'db.json': { bytes: json.length, sha256: sha256(json) } },
    excludes: ['sessions', 'media'],
  };
  const archive = await zipAsync({ 'manifest.json': strToU8(JSON.stringify(manifest, null, 2)), 'db.json': json });

  const name = `ladarr-${kind}-${stamp(now)}.zip`;
  await mkdir(dir, { recursive: true });
  const file = join(dir, name);
  // The file holds the password hash and the API key, so only the owner of the process can read it.
  await writeFile(`${file}.tmp`, archive, { mode: 0o600 });
  await rename(`${file}.tmp`, file);
  try {
    // Read it back, so a backup that is damaged on the disk is found now and not at a restore.
    await readBackup(await readFile(file));
  } catch (err) {
    await rm(file, { force: true });
    throw err;
  }
  return { name, kind, createdAt: now.getTime(), bytes: archive.length };
}

// Keeps the newest automatic backups. A backup that the user made stays until the user deletes it.
export async function pruneBackups(dir: string, keep = KEEP_AUTO) {
  const auto = (await listBackups(dir)).filter((backup) => backup.kind === 'auto');
  for (const old of auto.slice(keep)) await rm(join(dir, old.name), { force: true });
}

export function backupRouter(db: Db, dir: string) {
  const router = Router();

  router.get('/', async (_req, res) => {
    res.json({ backups: await listBackups(dir) });
  });

  router.post('/', async (_req, res) => {
    res.status(201).json({ backup: await createBackup(db, dir, 'manual') });
  });

  router.param('name', (_req, res, next, name) => (isBackupName(name) ? next() : void res.status(404).json({ error: 'not_found' })));

  router.get('/:name/download', (req, res) => {
    res.download(join(dir, req.params.name), req.params.name, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'not_found' });
    });
  });

  router.delete('/:name', async (req, res) => {
    const file = join(dir, req.params.name);
    if (!(await stat(file).catch(() => undefined))) return void res.status(404).json({ error: 'not_found' });
    await rm(file);
    res.json({ ok: true });
  });

  return router;
}
