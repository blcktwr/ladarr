import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { open } from '../../src/core/db.ts';
import { createEvents } from '../../src/core/events.ts';
import { createClients } from '../../src/library/downloads/client-api.ts';
import { createQueue } from '../../src/library/downloads/queue.ts';
import { createImporter } from '../../src/library/imports/importer.ts';
import { seriesCounts } from '../../src/library/library.ts';
import { applyCorrection, correctionJournal, correctionOf, prepareCorrection, recoverCorrection } from '../../src/library/mapping.ts';
import type { Db, ImporterDeps, ImportJournal, QueueEntry } from '../../src/types.ts';
import { episode, title } from '../helpers/test-fixtures.ts';

const KEY = 'tv:1';
const FILE = 'approved-file';
const PATH = 'Show/generated.S01E01.mkv';
const HASH = 'c'.repeat(40);
const coverage = [{ season: 1, number: 2 }, { season: 2, number: 1 }, { season: 2, number: 2 }];
const selectedId = `${KEY}:1x2`;
const siblingId = `${KEY}:2x1`;
const removedId = `${KEY}:1x1`;

let dir: string;
let database: string;
let root: string;
let db: Db;
let events: ReturnType<typeof createEvents>;
let queue: ReturnType<typeof createQueue>;
let sibling: QueueEntry;

async function reopen() {
  db = await open(database);
  events = createEvents();
  queue = createQueue(events, () => {});
}

const importer = (options: Pick<ImporterDeps, 'probe' | 'afterStep'> = {}) => createImporter({
  queue,
  events,
  clients: createClients(),
  save: () => db.write(),
  checkDelayMs: 0,
  probe: async () => ({ ok: true, durationSeconds: 2700, container: 'matroska', videoCodec: 'h264', audioLanguages: ['eng'] }),
  ...options,
});

const counts = () => seriesCounts(db.data.titles[KEY]!, { now: Date.now(), files: db.data.files });

function expectRecovered() {
  expect(Object.keys(db.data.files)).toEqual([FILE]);
  expect(db.data.files[FILE]).toMatchObject({ episodes: coverage, association: { source: 'manual', originalName: 'Original/airing.mkv', numberingRevision: 4 } });
  expect(db.data.titles[KEY]!.episodes.map((one) => one.fileId)).toEqual([null, FILE, FILE, FILE]);
  expect(db.data.queue[selectedId]).toMatchObject({
    state: { kind: 'importing' },
    numbering: { revision: 4 },
    manualMatch: { file: PATH, covers: coverage },
    completedAt: null,
    importResult: null,
  });
  expect(db.data.queue[siblingId]).toEqual(sibling);
  expect(db.data.queue[removedId]).toMatchObject({
    state: { kind: 'blocked', at: 'importing', problem: { code: 'file_unmapped' } },
    completedAt: null,
  });
  expect(counts().available).toBe(3);
}

async function persistIntent() {
  const before = structuredClone(db.data);
  const correction = correctionOf(KEY, [{ path: PATH, episodes: coverage }], [selectedId]);
  const prepared = prepareCorrection(correction);
  const journal = correctionJournal(prepared);
  expect(db.data).toEqual(before);
  expect(correction.lostAvailability).toEqual([{ season: 1, number: 1 }]);
  expect(correction.continued).toEqual([{ id: selectedId, phase: 'importing' }]);
  expect(journal.steps).toHaveLength(1);
  expect(journal.steps[0]).toMatchObject({ entryIds: [selectedId], episodes: coverage, sourceIdentity: db.data.files[FILE]!.association!.identity });
  db.data.imports[journal.id] = journal;
  await db.write();
  return { id: journal.id, hash: journal.hash };
}

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'ladarr-mapping-recovery-')));
  database = join(dir, 'db.json');
  root = join(dir, 'tv');
  mkdirSync(join(root, 'Show'), { recursive: true });
  writeFileSync(join(root, PATH), 'original-video');
  utimesSync(join(root, PATH), 1_600_000_000, 1_600_000_000);
  vi.stubEnv('NODE_ENV', 'production');
  await reopen();
  db.data.roots.tv = { id: 'tv', path: root, mediaType: 'tv', dev: statSync(root).dev };
  db.data.titles[KEY] = title({
    rootId: 'tv',
    folder: 'Show',
    episodes: [episode(1, 1), episode(1, 2), episode(2, 1), episode(2, 2)],
    numbering: { revision: 4, ranges: [{ season: 1, from: 2, to: 2, releaseSeason: 3, releaseFrom: 1 }] },
  });
  const info = statSync(join(root, PATH));
  db.data.files[FILE] = {
    id: FILE, titleKey: KEY, path: PATH, sizeBytes: info.size, mtimeMs: info.mtimeMs,
    episodes: [{ season: 1, number: 1 }], missing: false, addedAt: 1,
    association: { source: 'automatic', originalName: 'Original/airing.mkv', numberingRevision: 0, identity: { sizeBytes: info.size, mtimeMs: info.mtimeMs, dev: info.dev, ino: info.ino } },
  };
  db.data.titles[KEY]!.episodes[0]!.fileId = FILE;
  for (const [season, number] of [[1, 2], [2, 1]]) {
    const entry = queue.ensure(KEY, season!, number!);
    queue.request(entry, 'selected acquisition');
    queue.enter(entry, 'importing', 'download complete');
    entry.transferHash = HASH;
    entry.clientId = 'client-1';
    entry.numbering = { revision: 1, ranges: [] };
    queue.block(entry, { code: 'file_not_found' }, 'manual resolution is necessary');
  }
  sibling = structuredClone(db.data.queue[siblingId]!);
  expect(db.data.queue[removedId]).toBeUndefined();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('zero-byte mapping sources', () => {
  it('does not approve nonempty coverage for an actual empty video', () => {
    writeFileSync(join(root, PATH), '');
    const info = statSync(join(root, PATH));
    Object.assign(db.data.files[FILE]!, { sizeBytes: 0, mtimeMs: info.mtimeMs, episodes: [], association: undefined });
    for (const one of db.data.titles[KEY]!.episodes) one.fileId = null;
    const before = structuredClone(db.data);

    const correction = correctionOf(KEY, [{ path: PATH, episodes: coverage }], [selectedId]);

    expect(db.data).toEqual(before);
    expect(['blocked', 'review']).toContain(correction.rows.find((row) => row.path === PATH)!.status);
    expect(correction.continued).toEqual([]);
    expect(correction.pointers.some((pointer) => pointer.to === PATH)).toBe(false);
    if (correction.rows.some((row) => row.status === 'blocked')) expect(() => applyCorrection(correction, { queue })).toThrow();
    else applyCorrection(correction, { queue });
    expect(counts().available).toBe(0);
    expect(db.data.titles[KEY]!.episodes.every((one) => one.fileId === null)).toBe(true);
    expect(db.data.queue[selectedId]!.state.kind).toBe('blocked');
  });

  it('permits explicit unassignment when the video is empty', () => {
    writeFileSync(join(root, PATH), '');

    const correction = correctionOf(KEY, [{ path: PATH, episodes: [] }]);

    expect(correction.rows.find((row) => row.path === PATH)).toMatchObject({ status: 'change', reason: null, to: [] });
    applyCorrection(correction, { queue });
    expect(db.data.files[FILE]!.episodes).toEqual([]);
    expect(db.data.titles[KEY]!.episodes.every((one) => one.fileId === null)).toBe(true);
    expect(counts().available).toBe(0);
    expect(db.data.queue[siblingId]).toEqual(sibling);
  });
});

describe('persistent mapping recovery', () => {
  it('does not let an old queued journal override a newer approved mapping before its first execution', async () => {
    const saved = await persistIntent();
    await reopen();
    await recoverCorrection(db.data.imports[saved.id]!, { queue });
    expect(db.data.imports[saved.id]!.steps[0]!.state).toBe('planned');

    const selected = db.data.queue[selectedId]!;
    queue.block(selected, { code: 'file_unmapped' }, 'the user reviews a newer mapping');
    const newerCoverage = [{ season: 1, number: 2 }];
    const newer = prepareCorrection(correctionOf(KEY, [{ path: PATH, episodes: newerCoverage }], [selectedId]));
    const journal = correctionJournal(newer);
    db.data.imports[journal.id] = journal;
    await db.write();
    await recoverCorrection(journal, { queue });
    await reopen();
    expect(db.data.queue[selectedId]).toMatchObject({ state: { kind: 'importing' }, manualMatch: { file: PATH, covers: newerCoverage } });
    expect(db.data.files[FILE]!.episodes).toEqual(newerCoverage);
    const before = structuredClone({ files: db.data.files, titles: db.data.titles, queue: db.data.queue, jobs: db.data.jobs });

    await importer().run(saved.hash);

    expect({ files: db.data.files, titles: db.data.titles, queue: db.data.queue, jobs: db.data.jobs }).toEqual(before);
    expect(db.data.files[FILE]!.episodes).toEqual(newerCoverage);
    expect(db.data.queue[selectedId]).toMatchObject({ state: { kind: 'importing' }, manualMatch: { file: PATH, covers: newerCoverage }, completedAt: null, importResult: null });
    expect(db.data.queue[siblingId]).toEqual(before.queue[siblingId]);
    expect(counts().available).toBe(1);
  });

  it('restores coverage, pointers, and selected continuation from a persisted intent after restart', async () => {
    const saved = await persistIntent();

    await reopen();

    expect(db.data.files[FILE]!.episodes).toEqual([{ season: 1, number: 1 }]);
    expect(db.data.queue[selectedId]!.state.kind).toBe('blocked');
    expect(db.data.queue[removedId]).toBeUndefined();
    const journal = db.data.imports[saved.id]!;
    expect(journal.correction).toBeDefined();

    await recoverCorrection(journal, { queue });

    expectRecovered();
    expect(journal.correction).toBeUndefined();
    await reopen();
    expectRecovered();

    await importer().run(saved.hash);

    expect(db.data.queue[selectedId]!.state.kind).toBe('available');
    expect(db.data.queue[siblingId]).toEqual(sibling);
    expect(db.data.queue[removedId]!.state).toMatchObject({ kind: 'blocked', at: 'importing' });
    expect(db.data.files[FILE]!.episodes).toEqual(coverage);
    expect(Object.keys(db.data.files)).toEqual([FILE]);
    expect(db.data.imports).toEqual({});
    expect(db.data.jobs).toEqual({});
  });

  it.each(['library', 'queue'] as const)('recovers when only the %s write survives an interrupted application', async (part) => {
    const saved = await persistIntent();
    const crash = new Error(`interrupted ${part} write`);
    const write = vi.spyOn(db, 'write').mockImplementationOnce(async () => {
      const path = part === 'library' ? database : join(dir, 'queue.json');
      const persisted = JSON.parse(readFileSync(path, 'utf8'));
      if (part === 'library') Object.assign(persisted, { titles: db.data.titles, files: db.data.files, imports: db.data.imports });
      else Object.assign(persisted, { queue: db.data.queue, queueRev: db.data.queueRev });
      writeFileSync(path, JSON.stringify(persisted));
      throw crash;
    });

    await expect(recoverCorrection(db.data.imports[saved.id]!, { queue })).rejects.toThrow(crash);
    write.mockRestore();
    await reopen();
    expect(db.data.imports[saved.id]!.correction).toBeDefined();
    if (part === 'library') {
      expect(db.data.files[FILE]!.episodes).toEqual(coverage);
      expect(db.data.queue[selectedId]!.state.kind).toBe('blocked');
    } else {
      expect(db.data.files[FILE]!.episodes).toEqual([{ season: 1, number: 1 }]);
      expect(db.data.queue[selectedId]!.state.kind).toBe('importing');
    }

    await importer().run(saved.hash);

    expect(db.data.files[FILE]!.episodes).toEqual(coverage);
    expect(db.data.titles[KEY]!.episodes.map((one) => one.fileId)).toEqual([null, FILE, FILE, FILE]);
    expect(db.data.queue[selectedId]!.state.kind).toBe('available');
    expect(db.data.queue[siblingId]).toEqual(sibling);
    expect(db.data.queue[removedId]!.state).toMatchObject({ kind: 'blocked', at: 'importing', problem: { code: 'file_unmapped' } });
    expect(db.data.queue[selectedId]!.attempts).toHaveLength(1);
    expect(db.data.queue[removedId]!.attempts).toHaveLength(1);
    expect(Object.keys(db.data.files)).toEqual([FILE]);
    expect(db.data.imports).toEqual({});
    expect(counts().available).toBe(3);
  });

  it('replays an uncleared intent and an interrupted import without duplicate files or attempts', async () => {
    const saved = await persistIntent();
    const crash = new Error('recovery saved before intent cleanup');
    const originalWrite = db.write.bind(db);
    const write = vi.spyOn(db, 'write').mockImplementationOnce(async () => {
      await originalWrite();
      throw crash;
    });
    await expect(recoverCorrection(db.data.imports[saved.id]!, { queue })).rejects.toThrow(crash);
    write.mockRestore();
    await reopen();

    const journal = db.data.imports[saved.id]!;
    expect(journal.correction).toBeDefined();
    await recoverCorrection(journal, { queue });
    const recovered = structuredClone({ files: db.data.files, queue: db.data.queue });
    await recoverCorrection(journal, { queue });
    expect({ files: db.data.files, queue: db.data.queue }).toEqual(recovered);
    expectRecovered();
    const published = new Error('published before restart');

    await expect(importer({ afterStep: (state) => { if (state === 'published') throw published; } }).run(saved.hash)).rejects.toThrow(published);
    await reopen();
    expect(db.data.imports[saved.id]!.steps[0]!.sourceIdentity).toBeDefined();
    await importer().run(saved.hash);
    const completed = structuredClone({ files: db.data.files, queue: db.data.queue });
    await importer().run(saved.hash);

    expect({ files: db.data.files, queue: db.data.queue }).toEqual(completed);
    expect(db.data.queue[selectedId]!.state.kind).toBe('available');
    expect(db.data.queue[selectedId]!.attempts).toHaveLength(1);
    expect(db.data.queue[removedId]!.attempts).toHaveLength(1);
    expect(db.data.queue[siblingId]).toEqual(sibling);
    expect(Object.keys(db.data.files)).toEqual([FILE]);
    expect(db.data.imports).toEqual({});
  });

  it('does not approve a physical replacement before continuation even when size and mtime are unchanged', async () => {
    const saved = await persistIntent();
    const original = statSync(join(root, PATH));
    const replacement = join(root, 'Show', 'replacement.part');
    writeFileSync(replacement, Buffer.alloc(original.size, 1));
    utimesSync(replacement, original.atime, original.mtime);
    renameSync(replacement, join(root, PATH));
    const changed = statSync(join(root, PATH));
    expect(changed.size).toBe(original.size);
    expect(changed.mtimeMs).toBe(original.mtimeMs);
    expect(changed.ino).not.toBe(original.ino);
    await reopen();
    const journal: ImportJournal = db.data.imports[saved.id]!;
    expect(journal.steps[0]!.sourceIdentity).toEqual({ sizeBytes: original.size, mtimeMs: original.mtimeMs, dev: original.dev, ino: original.ino });

    await importer().run(saved.hash);

    expect(db.data.queue[selectedId]!.state).toMatchObject({ kind: 'blocked', at: 'importing' });
    expect(db.data.queue[selectedId]!.completedAt).toBeNull();
    expect(db.data.queue[selectedId]!.importResult?.ok).not.toBe(true);
    expect(db.data.queue[siblingId]).toEqual(sibling);
    expect(counts().available).toBe(0);
    expect(db.data.files[FILE]!.association?.identity.ino).not.toBe(changed.ino);
  });
});
