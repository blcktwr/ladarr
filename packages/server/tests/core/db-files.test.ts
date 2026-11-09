import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { emptyData, openDb, SCHEMA_VERSION, type Data } from '../../src/core/db.ts';
import type { Job } from '../../src/core/jobs.ts';
import type { QueueEntry } from '../../src/downloads/queue.ts';

const queueKeys = ['queue', 'queueRev', 'queuePaused', 'jobs', 'jobSeq', 'prioritySeq'];

const entry = {
  id: 'movie:603',
  titleKey: 'movie:603',
  season: null,
  number: null,
  stage: 'queued',
  branch: null,
  reason: null,
  revision: 1,
  createdAt: 1,
  stageSince: 1,
  completedAt: null,
  clearedAt: null,
  priority: null,
  attempt: 0,
  attempts: [],
  history: [],
  search: null,
  release: null,
  transferHash: null,
  clientId: null,
  manualMatch: null,
  importResult: null,
} as unknown as QueueEntry;

const job = {
  id: 'job-1',
  type: 'queue.tick',
  payloadVersion: 1,
  payload: null,
  dedupeKey: null,
  state: 'waiting',
  seq: 1,
  runAt: 0,
  attempts: 0,
  leaseOwner: null,
  leaseExpiresAt: null,
  lastError: null,
  priority: null,
} as unknown as Job;

const queueWork = {
  queue: { [entry.id]: entry },
  queueRev: 7,
  queuePaused: true,
  jobs: { [job.id]: job },
  jobSeq: 3,
  prioritySeq: 2,
};

const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf8'));

const seed = (data: Data) => {
  data.queue[entry.id] = entry;
  data.jobs[job.id] = job;
  data.queueRev = 7;
  data.queuePaused = true;
  data.jobSeq = 3;
  data.prioritySeq = 2;
  data.settings.region = 'DE';
};

describe('database files', () => {
  it('splits the queue work into queue.json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ladarr-db-files-'));
    const file = join(dir, 'db.json');
    try {
      vi.stubEnv('NODE_ENV', 'production');
      const db = await openDb(file);
      seed(db.data);
      await db.write();

      const data = readJson(file);
      expect(data.settings.region).toBe('DE');
      for (const key of queueKeys) expect(data).not.toHaveProperty(key);
      expect(readJson(join(dir, 'queue.json'))).toEqual(queueWork);
    } finally {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loads the queue work again after a reopen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ladarr-db-files-'));
    const file = join(dir, 'db.json');
    try {
      vi.stubEnv('NODE_ENV', 'production');
      const first = await openDb(file);
      seed(first.data);
      await first.write();

      const db = await openDb(file);
      expect(db.data.queue[entry.id]).toEqual(entry);
      expect(db.data.jobs[job.id]).toEqual(job);
      expect(db.data.queueRev).toBe(7);
      expect(db.data.queuePaused).toBe(true);
      expect(db.data.jobSeq).toBe(3);
      expect(db.data.prioritySeq).toBe(2);
      expect(db.data.settings.region).toBe('DE');
    } finally {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('moves the queue work of an older file into queue.json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ladarr-db-files-'));
    const file = join(dir, 'db.json');
    try {
      const data = emptyData();
      seed(data);
      writeFileSync(file, JSON.stringify(data));

      vi.stubEnv('NODE_ENV', 'production');
      const db = await openDb(file);
      expect(db.data.queue[entry.id]).toEqual(entry);
      expect(db.data.jobs[job.id]).toEqual(job);
      expect(db.data.queueRev).toBe(7);
      expect(db.data.queuePaused).toBe(true);
      expect(db.data.jobSeq).toBe(3);
      expect(db.data.prioritySeq).toBe(2);

      await db.write();
      const config = readJson(file);
      for (const key of queueKeys) expect(config).not.toHaveProperty(key);
      expect(readJson(join(dir, 'queue.json'))).toEqual(queueWork);
    } finally {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the queue work of a restored db.json over queue.json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ladarr-db-files-'));
    const file = join(dir, 'db.json');
    try {
      const data = emptyData();
      seed(data);
      writeFileSync(file, JSON.stringify(data));
      const stale = { queue: {}, jobs: {}, queueRev: 99, queuePaused: false, jobSeq: 99, prioritySeq: 99 };
      writeFileSync(join(dir, 'queue.json'), JSON.stringify(stale));

      vi.stubEnv('NODE_ENV', 'production');
      const db = await openDb(file);
      expect(db.data.queue[entry.id]).toEqual(entry);
      expect(db.data.jobs[job.id]).toEqual(job);
      expect(db.data.queueRev).toBe(7);
      expect(db.data.settings.region).toBe('DE');

      await db.write();
      const config = readJson(file);
      for (const key of queueKeys) expect(config).not.toHaveProperty(key);
      expect(readJson(join(dir, 'queue.json'))).toEqual(queueWork);
    } finally {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps a schema that is newer than this version', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ladarr-db-files-'));
    const file = join(dir, 'db.json');
    try {
      writeFileSync(file, JSON.stringify({ ...emptyData(), schemaVersion: 99 }));
      vi.stubEnv('NODE_ENV', 'production');
      const db = await openDb(file);
      expect(db.data.schemaVersion).toBe(99);
    } finally {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('upgrades an old schema', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ladarr-db-files-'));
    const file = join(dir, 'db.json');
    try {
      writeFileSync(file, JSON.stringify({ ...emptyData(), schemaVersion: 1 }));
      vi.stubEnv('NODE_ENV', 'production');
      const db = await openDb(file);
      // SCHEMA_VERSION is the current version, so this test does not hardcode the next number.
      expect(db.data.schemaVersion).toBe(SCHEMA_VERSION);
    } finally {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
