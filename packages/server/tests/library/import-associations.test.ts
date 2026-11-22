import { copyFileSync, linkSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { libraryScanHandler } from '../../src/jobs/library-scan.ts';
import { queueSweepHandler } from '../../src/jobs/queue-sweep.ts';
import { createClients } from '../../src/library/downloads/client-api.ts';
import { reasonOfEntry } from '../../src/library/downloads/queue.ts';
import { createImporter } from '../../src/library/imports/importer.ts';
import { importLocal } from '../../src/library/imports/local.ts';
import { seriesCounts } from '../../src/library/library.ts';
import { scanTitle } from '../../src/library/scan.ts';
import type { ImporterDeps, QueueEntry, Title } from '../../src/types.ts';
import { episode, movie, title } from '../helpers/test-fixtures.ts';
import { hashOf, startPipeline } from '../helpers/test-pipeline.ts';

let pipe: Awaited<ReturnType<typeof startPipeline>> | undefined;
afterEach(async () => {
  await pipe?.stop();
  pipe = undefined;
});

const NAME = 'Show.Name.S01.1080p.WEB-DL-GRP';
const ref = (season: number, number: number) => ({ season, number });

async function setup(item: Title, files: Record<string, string>, options: Pick<ImporterDeps, 'probe' | 'fs' | 'afterStep'> = {}) {
  pipe = await startPipeline();
  pipe.poller.stop();
  await pipe.worker.stop();
  pipe.db.data.titles[item.key] = item;
  const hash = hashOf(NAME);
  pipe.qbit.torrents.set(hash, {
    hash, name: NAME, size: 1_000_000, progress: 1, state: 'uploading', category: 'ladarr', tags: '',
    save_path: pipe.folders.downloads, content_path: join(pipe.folders.downloads, NAME),
    dlspeed: 0, eta: 0, num_seeds: 1, num_leechs: 0, added_on: Math.floor(Date.now() / 1000),
  });
  pipe.complete(NAME, files, hash);
  const partial = vi.fn(pipe.finder.partial);
  const deps: ImporterDeps = {
    queue: pipe.queue,
    events: pipe.events,
    clients: createClients(),
    save: async () => {},
    status: pipe.importStatus,
    partial,
    checkDelayMs: 0,
    probe: async () => ({ ok: true, durationSeconds: 2700, container: 'matroska', videoCodec: 'h264', audioLanguages: ['eng'] }),
    ...options,
  };
  const importer = createImporter(deps);
  const target = (season: number | null, number: number | null): QueueEntry => {
    const entry = pipe!.queue.ensure(item.key, season, number);
    pipe!.queue.request(entry, 'selected acquisition');
    pipe!.queue.enter(entry, 'importing', 'download complete');
    entry.clientId = 'client-1';
    entry.transferHash = hash;
    entry.numbering = { revision: 0, ranges: [] };
    entry.release = {
      guid: NAME, indexerId: 1, indexerName: 'Tracker', title: NAME, sizeBytes: 1_000_000,
      infoHash: hash, link: null, magnet: null, kind: item.mediaType === 'movie' ? 'single' : 'pack',
      seeders: 1, manual: false,
    };
    return entry;
  };
  return { importer, deps, hash, target, partial };
}

describe('import association provenance', () => {
  it('restores verified legacy episode links on scan and keeps them without the torrent on the next scan', async () => {
    const item = title({ rootId: 'tv', episodes: [episode(1, 1), episode(1, 2), episode(1, 3)] });
    const { importer, hash, target } = await setup(item, {
      'Show.S01E01.mkv': 'one', 'Show.S01E02.mkv': 'two', 'Show.S01E03.mkv': 'three',
    });
    const entries = item.episodes.map((one) => target(one.season, one.number));
    await importer.run(hash);
    expect(entries.map((entry) => entry.importResult?.method)).toEqual(['hardlink', 'hardlink', 'hardlink']);
    const files = item.episodes.map((one) => pipe!.db.data.files[one.fileId!]!);
    for (const file of files) {
      delete file.association;
      file.episodes = [];
    }
    for (const one of item.episodes) one.fileId = null;

    // This file has the same name, size, and contents as the import but is no longer the torrent's hardlink.
    const replaced = join(pipe!.folders.tv, files[2]!.path);
    copyFileSync(replaced, `${replaced}.part`);
    renameSync(`${replaced}.part`, replaced);
    const scan = () => libraryScanHandler(pipe!).run({ payload: { key: item.key } } as never, { signal: new AbortController().signal });
    await scan();

    expect(item.episodes.map((one) => one.fileId)).toEqual([files[0]!.id, files[1]!.id, null]);
    for (const [index, file] of files.slice(0, 2).entries()) {
      const stat = statSync(join(pipe!.folders.tv, file.path));
      expect(file.episodes).toEqual([ref(1, index + 1)]);
      expect(file.association?.identity).toMatchObject({ dev: stat.dev, ino: stat.ino });
    }
    expect(files[2]!.episodes).toEqual([]);
    pipe!.qbit.torrents.delete(hash);
    await scan();
    expect(item.episodes.map((one) => one.fileId)).toEqual([files[0]!.id, files[1]!.id, null]);
    expect(seriesCounts(item, { now: Date.now(), files: pipe!.db.data.files }).available).toBe(2);
    expect(pipe!.tracker.state.downloads).toEqual([]);
    expect(pipe!.qbit.calls.filter((call) => call.path === 'torrents/add')).toEqual([]);
  });

  it.each(['hash', 'client', 'path', 'outcome'] as const)('does not recover an episode from a hardlink with a different import %s', async (mismatch) => {
    const item = title({ rootId: 'tv', episodes: [episode(1, 1)] });
    const { importer, hash, target } = await setup(item, { 'Show.S01E01.mkv': 'episode' });
    const entry = target(1, 1);
    await importer.run(hash);
    const one = item.episodes[0]!;
    const file = pipe!.db.data.files[one.fileId!]!;
    delete file.association;
    file.episodes = [];
    one.fileId = null;
    if (mismatch === 'hash') entry.transferHash = hashOf('Another release');
    if (mismatch === 'client') entry.clientId = 'another-client';
    if (mismatch === 'path') entry.importResult!.path = 'another.mkv';
    if (mismatch === 'outcome') entry.importResult = null;

    await libraryScanHandler(pipe!).run({ payload: { key: item.key } } as never, { signal: new AbortController().signal });
    expect(one.fileId).toBeNull();
    expect(file.episodes).toEqual([]);
  });

  it('does not assign another episode from the same torrent to the old import destination', async () => {
    const item = title({ rootId: 'tv', episodes: [episode(1, 1), episode(1, 2)] });
    const { importer, hash, target } = await setup(item, { 'Show.S01E01.mkv': 'one', 'Show.S01E02.mkv': 'two' });
    target(1, 1);
    await importer.run(hash);
    const one = item.episodes[0]!;
    const file = pipe!.db.data.files[one.fileId!]!;
    const destination = join(pipe!.folders.tv, file.path);
    linkSync(join(pipe!.folders.downloads, NAME, 'Show.S01E02.mkv'), `${destination}.part`);
    renameSync(`${destination}.part`, destination);
    file.episodes = [];
    delete file.association;
    one.fileId = null;

    await libraryScanHandler(pipe!).run({ payload: { key: item.key } } as never, { signal: new AbortController().signal });
    expect(one.fileId).toBeNull();
    expect(file.episodes).toEqual([]);
  });

  it.each(['automatic', 'numbering', 'manual'] as const)('persists %s evidence with the source name, map revision, and file identity', async (source) => {
    const sourceName = `Original/Show.Name.S${source === 'automatic' ? '01' : '02'}E01.1080p.mkv`;
    const item = title({
      rootId: 'tv',
      episodes: [episode(1, 1), episode(1, 21)],
      numbering: { revision: 9, ranges: [{ season: 1, from: 1, to: 1, releaseSeason: 2, releaseFrom: 1 }] },
    });
    const { importer, hash, target } = await setup(item, { [sourceName]: 'video-data' });
    const entry = target(1, source === 'numbering' ? 21 : 1);
    if (source !== 'automatic') entry.numbering = { revision: 4, ranges: [{ season: 1, from: 21, to: 21, releaseSeason: 2, releaseFrom: 1 }] };
    if (source === 'manual') entry.manualMatch = { file: sourceName, covers: [ref(1, 1)] };

    await importer.run(hash);

    expect(entry.state.kind).toBe('available');
    const [file] = Object.values(pipe!.db.data.files);
    expect(file).toBeDefined();
    const info = statSync(join(pipe!.folders.tv, file!.path));
    expect(file).toMatchObject({
      episodes: [ref(1, source === 'numbering' ? 21 : 1)],
      download: { clientId: 'client-1', hash, name: NAME, file: sourceName },
      association: {
        source,
        originalName: expect.stringContaining(sourceName),
        numberingRevision: source === 'automatic' ? 0 : 4,
        identity: { sizeBytes: info.size, mtimeMs: info.mtimeMs, dev: info.dev, ino: info.ino },
      },
    });
    expect(file!.path).not.toContain(sourceName);
  });

  it('retains the acquisition provenance after journal recovery and a later series map', async () => {
    const sourceName = 'Show.Name.S02E01.mkv';
    const item = title({ rootId: 'tv', episodes: [episode(1, 1), episode(1, 21)] });
    const crash = new Error('published before restart');
    const { importer, deps, hash, target } = await setup(item, { [sourceName]: 'video-data' }, {
      afterStep: (state) => { if (state === 'published') throw crash; },
    });
    const entry = target(1, 21);
    entry.numbering = { revision: 4, ranges: [{ season: 1, from: 21, to: 21, releaseSeason: 2, releaseFrom: 1 }] };

    await expect(importer.run(hash)).rejects.toThrow(crash);
    expect(Object.keys(pipe!.db.data.imports)).toHaveLength(1);
    item.numbering = { revision: 9, ranges: [{ season: 1, from: 1, to: 1, releaseSeason: 2, releaseFrom: 1 }] };

    await createImporter({ ...deps, afterStep: undefined }).run(hash);

    expect(entry.state.kind).toBe('available');
    expect(Object.values(pipe!.db.data.files)).toHaveLength(1);
    expect(Object.values(pipe!.db.data.files)[0]).toMatchObject({
      episodes: [ref(1, 21)],
      association: { source: 'numbering', originalName: expect.stringContaining(sourceName), numberingRevision: 4 },
    });
  });
});

describe('stale import workers', () => {
  it.each(['numbering', 'manual choice'] as const)('cannot commit after an explicit change to the acquisition %s during a probe', async (change) => {
    let reached!: () => void;
    const probing = new Promise<void>((resolve) => { reached = resolve; });
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => { resume = resolve; });
    const original = change === 'numbering' ? 'Show.Name.S02E01.mkv' : 'Show.Name.S01E01.mkv';
    const replacement = 'Show.Name.S01E02.mkv';
    const item = title({ rootId: 'tv', episodes: [episode(1, 1), episode(1, 2)] });
    const { importer, hash, target } = await setup(item, { [original]: 'old-choice', [replacement]: 'new-choice' }, {
      probe: async () => {
        reached();
        await paused;
        return { ok: true, durationSeconds: 2700, container: 'matroska', videoCodec: 'h264', audioLanguages: ['eng'] };
      },
    });
    const entry = target(1, 1);
    if (change === 'numbering') entry.numbering = { revision: 1, ranges: [{ season: 1, from: 1, to: 1, releaseSeason: 2, releaseFrom: 1 }] };
    else entry.manualMatch = { file: original, covers: [ref(1, 1)] };

    const worker = importer.run(hash);
    await probing;

    if (change === 'numbering') entry.numbering = { revision: 2, ranges: [{ season: 1, from: 2, to: 2, releaseSeason: 2, releaseFrom: 1 }] };
    else entry.manualMatch = { file: replacement, covers: [ref(1, 1)] };
    pipe!.queue.touch(entry);
    pipe!.queue.resolve(entry, 'importing', change === 'numbering' ? 'apply numbering' : 'apply mapping');
    const approved = structuredClone(entry);
    resume();
    await Promise.allSettled([worker]);

    expect(pipe!.db.data.files).toEqual({});
    expect(item.episodes.map((one) => one.fileId)).toEqual([null, null]);
    expect(entry).toEqual(approved);
    expect(entry.completedAt).toBeNull();
    expect(entry.importResult).toBeNull();
  });
});

describe('pending episodes with library files', () => {
  it('completes a pending episode outside the journal targets only after the shared file passes the final check', async () => {
    const item = title({ rootId: 'tv', episodes: [episode(1, 13), episode(1, 14)] });
    const crash = new Error('stop after commit');
    const { importer, deps, hash, target } = await setup(item, { 'shared.mkv': 'both episodes' }, {
      afterStep: (state) => { if (state === 'committed') throw crash; },
    });
    const selected = target(1, 13);
    selected.manualMatch = { file: 'shared.mkv', covers: [ref(1, 13), ref(1, 14)] };
    const sibling = pipe!.queue.ensure(item.key, 1, 14);
    pipe!.queue.request(sibling, 'missing episode');

    await expect(importer.run(hash)).rejects.toThrow(crash);
    expect(Object.values(pipe!.db.data.imports)[0]!.steps[0]!.entryIds).toEqual([selected.id]);
    await libraryScanHandler(pipe!).run({ payload: { key: item.key } } as never, { signal: new AbortController().signal });
    expect(selected.state.kind).toBe('importing');
    expect(sibling.state.kind).toBe('queued');

    await createImporter({ ...deps, afterStep: undefined }).run(hash);

    expect(sibling.state.kind).toBe('available');
    expect(sibling.attempts.at(-1)?.outcome).toBe('imported');
    expect(sibling.importResult?.path).toBe(selected.importResult?.path);
    expect(item.episodes[1]!.fileId).toBe(item.episodes[0]!.fileId);
    expect(pipe!.tracker.state.downloads).toEqual([]);
  });

  it('repairs a saved pending episode before retrying lost searches and rejects changed files', async () => {
    const item = title({ rootId: 'tv', episodes: [episode(1, 1), episode(1, 2)] });
    const { importer, hash, target } = await setup(item, { 'Show.S01E01.mkv': 'one', 'Show.S01E02.mkv': 'two' });
    const stale = target(1, 1);
    const changed = target(1, 2);
    await importer.run(hash);
    for (const entry of [stale, changed]) {
      pipe!.queue.request(entry, 'missing episode');
      expect(entry.state.kind).toBe('queued');
    }
    const file = pipe!.db.data.files[item.episodes[1]!.fileId!]!;
    writeFileSync(join(pipe!.folders.tv, file.path), 'replacement data');
    const sweep = () => queueSweepHandler(pipe!.finder, pipe!.queue).run({} as never, { signal: new AbortController().signal });
    await sweep();

    expect(stale.state.kind).toBe('available');
    expect(stale.attempts.at(-1)?.outcome).toBe('imported');
    expect(changed.state.kind).toBe('queued');
    const searches = Object.values(pipe!.db.data.jobs).filter((job) => job.type === 'queue.search');
    expect(searches.map((job) => job.payload)).toEqual([expect.objectContaining({ entryIds: [changed.id] })]);
    const before = structuredClone(stale);
    await sweep();
    expect(stale).toEqual(before);
  });
});

describe('manual import coverage', () => {
  it('records catalog coverage outside the queue without resuming an unauthorized sibling', async () => {
    const coverage = [ref(1, 12), ref(2, 1), ref(2, 2)];
    const item = title({ rootId: 'tv', episodes: coverage.map((one) => episode(one.season, one.number)) });
    const { importer, hash, target } = await setup(item, { 'airing.mkv': 'three-segments' });
    const selected = target(1, 12);
    const sibling = target(2, 1);
    selected.manualMatch = { file: 'airing.mkv', covers: coverage };
    pipe!.queue.block(sibling, { code: 'file_not_found' }, 'manual resolution is necessary');
    const before = structuredClone(sibling);

    await importer.run(hash);

    expect(sibling).toEqual(before);
    expect(selected.state.kind).toBe('available');
    expect(pipe!.queue.get(`${item.key}:2x2`)).toBeUndefined();
    const [file] = Object.values(pipe!.db.data.files);
    expect(file!.episodes).toEqual(coverage);
    expect(item.episodes.map((one) => one.fileId)).toEqual([file!.id, file!.id, file!.id]);
    expect(Object.keys(pipe!.db.data.files)).toHaveLength(1);

    await scanTitle(item.key);

    expect(sibling).toEqual(before);
    expect(file!.episodes).toEqual(coverage);
    expect(seriesCounts(item, { now: Date.now(), files: pipe!.db.data.files }).available).toBe(3);
  });
});

describe('whole-source numbering consistency', () => {
  const nameOf = (number: number, season = 2) => `Example.Series.S${String(season).padStart(2, '0')}E${String(number).padStart(2, '0')}.mkv`;
  const catalog = (first = 5) => title({
    rootId: 'tv',
    episodes: Array.from({ length: 21 }, (_, index) => episode(2, first + index, `2020-01-${String(index + 1).padStart(2, '0')}`)),
  });
  const filesOf = (first = 1) => Object.fromEntries(Array.from({ length: 21 }, (_, index) => [nameOf(first + index), `video-${first + index}`]));

  it('blocks all numeric overlaps when an unmapped source contradicts a non-one-based catalog season', async () => {
    const item = catalog();
    const { importer, hash, target, partial } = await setup(item, filesOf());
    const entries = item.episodes.map((one) => target(one.season, one.number));

    await importer.run(hash);

    expect(Object.keys(pipe!.db.data.files)).toHaveLength(0);
    expect(item.episodes.every((one) => one.fileId === null)).toBe(true);
    expect(seriesCounts(item, { now: Date.now(), files: pipe!.db.data.files }).available).toBe(0);
    for (const entry of entries) {
      expect(entry.state).toMatchObject({ kind: 'blocked', at: 'importing' });
      expect(reasonOfEntry(entry)?.code).not.toMatch(/^(file_not_found|pack_partial)$/);
      expect(entry.transferHash).toBe(hash);
      expect(entry.importResult).toBeNull();
    }
    expect(partial).not.toHaveBeenCalled();
  });

  it('recovers only selected targets through an explicit source map without another download', async () => {
    const item = catalog();
    const { importer, hash, target } = await setup(item, filesOf());
    const entries = item.episodes.map((one) => target(one.season, one.number));
    for (const entry of entries) pipe!.queue.block(entry, { code: 'file_unmapped' }, 'source numbering is ambiguous');
    const selected = entries.filter((entry) => [5, 9, 25].includes(entry.number!));
    const siblings = entries.filter((entry) => !selected.includes(entry));
    const before = structuredClone(siblings);
    const numbering = { revision: 1, ranges: [{ season: 2, from: 5, to: 25, releaseSeason: 2, releaseFrom: 1 }] };
    item.numbering = structuredClone(numbering);
    for (const entry of selected) {
      entry.numbering = structuredClone(numbering);
      pipe!.queue.touch(entry);
      pipe!.queue.resolve(entry, 'importing', 'apply numbering');
    }

    await importer.run(hash);

    expect(selected.every((entry) => entry.state.kind === 'available')).toBe(true);
    expect(siblings).toEqual(before);
    expect(Object.keys(pipe!.db.data.files)).toHaveLength(3);
    for (const entry of selected) {
      const one = item.episodes.find((episode) => episode.number === entry.number)!;
      const file = pipe!.db.data.files[one.fileId!]!;
      const original = nameOf(entry.number! - 4);
      expect(file.episodes).toEqual([ref(2, entry.number!)]);
      expect(file).toMatchObject({ download: { hash }, association: { source: 'numbering', originalName: expect.stringContaining(original), numberingRevision: 1 } });
      expect(statSync(join(pipe!.folders.tv, file.path)).ino).toBe(statSync(join(pipe!.folders.downloads, NAME, original)).ino);
      expect(entry.attempt).toBe(1);
      expect(entry.transferHash).toBe(hash);
    }
    expect(seriesCounts(item, { now: Date.now(), files: pipe!.db.data.files }).available).toBe(3);
    expect(pipe!.tracker.state.downloads).toEqual([]);
    expect(pipe!.qbit.calls.filter((call) => call.path === 'torrents/add')).toEqual([]);
    expect([...pipe!.qbit.torrents.keys()]).toEqual([hash]);
  });

  it('permits independent exact identity without approving the other numeric overlaps', async () => {
    const item = catalog();
    item.episodes[0]!.name = 'Known Arrival';
    const { importer, hash, target } = await setup(item, filesOf(), {
      probe: async (path) => ({
        ok: true, durationSeconds: 2700, container: 'matroska', videoCodec: 'h264', audioLanguages: ['eng'],
        tags: { title: path.endsWith(`/${nameOf(5)}`) ? 'Known Arrival' : null, season: null, episode: null },
      }),
    });
    const entries = item.episodes.map((one) => target(one.season, one.number));

    await importer.run(hash);

    expect(entries[0]!.state.kind).toBe('available');
    expect(entries.slice(1).every((entry) => entry.state.kind === 'blocked')).toBe(true);
    expect(Object.values(pipe!.db.data.files)).toHaveLength(1);
    expect(Object.values(pipe!.db.data.files)[0]!.episodes).toEqual([ref(2, 5)]);
    expect(seriesCounts(item, { now: Date.now(), files: pipe!.db.data.files }).available).toBe(1);
  });

  it.each([
    { label: 'one-based catalog numbers with a loose extra', first: 1, extra: 'unrelated.mkv' },
    { label: 'non-one-based catalog numbers with a loose extra', first: 5, extra: 'unrelated.mkv' },
    { label: 'non-one-based catalog numbers with another season as an extra', first: 5, extra: nameOf(1, 3) },
  ])('keeps a valid pack usable with $label', async ({ first, extra }) => {
    const item = catalog(first);
    const { importer, hash, target } = await setup(item, { ...filesOf(first), [extra]: 'unrelated-extra' });
    const entries = item.episodes.map((one) => target(one.season, one.number));

    await importer.run(hash);

    expect(entries.every((entry) => entry.state.kind === 'available')).toBe(true);
    expect(Object.values(pipe!.db.data.files)).toHaveLength(21);
    expect(seriesCounts(item, { now: Date.now(), files: pipe!.db.data.files }).available).toBe(21);
  });

  it('does not approve a whole-source offset conflict in a local folder until an explicit map resolves it', async () => {
    pipe = await startPipeline();
    pipe.poller.stop();
    await pipe.worker.stop();
    const item = catalog();
    item.folder = 'Show';
    pipe.db.data.titles[item.key] = item;
    mkdirSync(join(pipe.folders.tv, item.folder), { recursive: true });
    for (const [name, data] of Object.entries(filesOf())) writeFileSync(join(pipe.folders.tv, item.folder, name), data);
    const entries = item.episodes.map((one) => {
      const entry = pipe!.queue.ensure(item.key, one.season, one.number);
      pipe!.queue.request(entry, 'import from the local folder');
      pipe!.queue.enter(entry, 'importing', 'read the local folder');
      entry.numbering = { revision: 0, ranges: [] };
      return entry;
    });
    const deps = { queue: pipe.queue, clients: createClients() };

    const unresolved = await importLocal(deps, { titleKey: item.key, localOnly: true });

    expect(unresolved.imported).toHaveLength(0);
    expect(seriesCounts(item, { now: Date.now(), files: pipe.db.data.files }).available).toBe(0);
    expect(entries.every((entry) => entry.state.kind === 'blocked')).toBe(true);
    item.numbering = { revision: 1, ranges: [{ season: 2, from: 5, to: 25, releaseSeason: 2, releaseFrom: 1 }] };
    for (const entry of entries) {
      entry.numbering = structuredClone(item.numbering);
      pipe.queue.touch(entry);
      pipe.queue.resolve(entry, 'importing', 'apply numbering');
    }

    const resolved = await importLocal(deps, { titleKey: item.key, localOnly: true });

    expect(resolved.imported).toHaveLength(21);
    expect(entries.every((entry) => entry.state.kind === 'available')).toBe(true);
    for (const one of item.episodes) {
      const file = pipe.db.data.files[one.fileId!]!;
      expect(file.path).toBe(`Show/${nameOf(one.number - 4)}`);
      expect(file.episodes).toEqual([ref(2, one.number)]);
    }
    expect(pipe.tracker.state.downloads).toEqual([]);
  });
});

describe('content evidence before import', () => {
  it('identifies a multi-episode file from exact metadata titles', async () => {
    const names = ['Arrival', 'The Signal', 'Departure'];
    const item = title({ rootId: 'tv', episodes: names.map((name, index) => episode(1, index + 1, '2020-01-01', { name, runtime: 7 })) });
    const { importer, hash, target } = await setup(item, { 'airing.mkv': 'three-segments' }, {
      probe: async () => ({
        ok: true, durationSeconds: 1260, container: 'matroska', videoCodec: 'h264', audioLanguages: ['eng'],
        tags: { title: names.join('/'), season: null, episode: null },
      }),
    });
    const entries = names.map((_name, index) => target(1, index + 1));

    await importer.run(hash);

    expect(entries.map((entry) => entry.state.kind)).toEqual(['available', 'available', 'available']);
    expect(Object.values(pipe!.db.data.files)).toHaveLength(1);
    expect(Object.values(pipe!.db.data.files)[0]).toMatchObject({
      episodes: [ref(1, 1), ref(1, 2), ref(1, 3)],
      association: { source: 'automatic', originalName: expect.stringContaining('airing.mkv') },
    });
  });

  it('does not treat an unknown file as evidence that an episode is absent', async () => {
    const item = title({ rootId: 'tv', episodes: [episode(1, 1), episode(1, 2)] });
    const { importer, hash, target, partial } = await setup(item, { 'Show.Name.S01E01.mkv': 'known', 'unidentified.mkv': 'unknown' });
    const known = target(1, 1);
    const unknown = target(1, 2);

    await importer.run(hash);

    expect(known.state.kind).toBe('available');
    expect(unknown.state).toMatchObject({ kind: 'blocked', at: 'importing' });
    expect(reasonOfEntry(unknown)?.code).not.toMatch(/^(file_not_found|pack_partial)$/);
    expect(unknown.transferHash).toBe(hash);
    expect(partial.mock.calls.flatMap((call) => call[1])).not.toContain(unknown);
    expect(item.episodes[1]!.fileId).toBeNull();
  });

  it('does not approve a proposal based only on duration and elimination', async () => {
    const item = title({
      rootId: 'tv',
      episodes: ['Arrival', 'The Signal', 'Departure'].map((name, index) => episode(1, index + 1, '2020-01-01', { name, runtime: 7 })),
    });
    const { importer, hash, target, partial } = await setup(item, { 'unidentified.mkv': 'three-segments' }, {
      probe: async () => ({
        ok: true, durationSeconds: 1260, container: 'matroska', videoCodec: 'h264', audioLanguages: ['eng'],
        tags: { title: 'Unknown One/Unknown Two/Unknown Three', season: null, episode: null },
      }),
    });
    const entries = [1, 2, 3].map((number) => target(1, number));

    await importer.run(hash);

    expect(pipe!.db.data.files).toEqual({});
    expect(entries.every((entry) => entry.state.kind === 'blocked')).toBe(true);
    expect(entries.every((entry) => !['file_not_found', 'pack_partial'].includes(reasonOfEntry(entry)?.code ?? ''))).toBe(true);
    expect(partial).not.toHaveBeenCalled();
  });

  it('does not identify a movie by the size of two plausible videos', async () => {
    const item = movie({ rootId: 'movie' });
    const { importer, hash, target } = await setup(item, { 'part-a.mkv': 'small', 'part-b.mkv': 'much-larger-video' });
    const entry = target(null, null);

    await importer.run(hash);

    expect(entry.state).toMatchObject({ kind: 'blocked', at: 'importing' });
    expect(item.fileId).toBeNull();
    expect(pipe!.db.data.files).toEqual({});
  });
});
