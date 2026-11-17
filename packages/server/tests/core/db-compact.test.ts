import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { emptyData, open } from '../../src/core/db.ts';
import { entryOf } from '../helpers/test-queue.ts';
import type { Data, Job } from '../../src/types.ts';

const entry = entryOf({ id: 'movie:603', titleKey: 'movie:603', numbering: null });

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

const seed = (data: Data) => {
  data.queue[entry.id] = entry;
  data.jobs[job.id] = job;
  data.queueRev = 7;
  data.queuePaused = true;
  data.jobSeq = 3;
  data.prioritySeq = 2;
  data.settings.naming.movie = 'DE';
};

const text = (file: string) => readFileSync(file, 'utf8');

// Compact JSON is what JSON.stringify gives with no indent argument: no line break and no space between tokens.
const expectCompact = (file: string) => {
  const content = text(file);
  expect(content).not.toMatch(/[\r\n]/);
  expect(content).toBe(JSON.stringify(JSON.parse(content)));
};

describe('database files hold compact JSON', () => {
  it('writes db.json and queue.json with no indentation and no line break, and a reopen gives the same data', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ladarr-db-compact-'));
    const file = join(dir, 'db.json');
    const queueFile = join(dir, 'queue.json');
    try {
      vi.stubEnv('NODE_ENV', 'production');
      const first = await open(file);
      seed(first.data);
      await first.write();

      expectCompact(file);
      expectCompact(queueFile);
      expect(JSON.parse(text(queueFile))).toEqual(queueWork);
      expect(JSON.parse(text(file)).settings.naming.movie).toBe('DE');

      const second = await open(file);
      expect(second.data).toEqual(first.data);
    } finally {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads the pretty-printed files of an older version, and writes them again as compact JSON', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ladarr-db-compact-'));
    const file = join(dir, 'db.json');
    const queueFile = join(dir, 'queue.json');
    try {
      const data = emptyData();
      seed(data);
      const { queue: _queue, queueRev: _queueRev, queuePaused: _queuePaused, jobs: _jobs, jobSeq: _jobSeq, prioritySeq: _prioritySeq, ...app } = data;
      writeFileSync(file, JSON.stringify(app, null, 2));
      writeFileSync(queueFile, JSON.stringify(queueWork, null, 2));
      expect(text(file)).toMatch(/\n {2}"/);

      vi.stubEnv('NODE_ENV', 'production');
      const db = await open(file);
      expect(db.data.queue[entry.id]).toEqual(entry);
      expect(db.data.jobs[job.id]).toEqual(job);
      expect(db.data.queueRev).toBe(7);
      expect(db.data.queuePaused).toBe(true);
      expect(db.data.jobSeq).toBe(3);
      expect(db.data.prioritySeq).toBe(2);
      expect(db.data.settings.naming.movie).toBe('DE');

      await db.write();
      expectCompact(file);
      expectCompact(queueFile);
      expect(JSON.parse(text(queueFile))).toEqual(queueWork);
    } finally {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
