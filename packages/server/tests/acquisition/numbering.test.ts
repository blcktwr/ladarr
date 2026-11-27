import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { emptyData, withDefaults } from '../../src/core/db.ts';
import { decide } from '../../src/library/grab/decide.ts';
import { readPackCoverage } from '../../src/library/grab/match.ts';
import { stageOf } from '../../src/library/downloads/queue.ts';
import { entryOf } from '../helpers/test-queue.ts';
import { releaseEpisodes } from '../../src/library/parse.ts';
import { episode, indexer, release, title } from '../helpers/test-fixtures.ts';
import { hashOf, MIB, startPipeline, until } from '../helpers/test-pipeline.ts';
import type { DecideContext, Numbering, QueueEntry, Want } from '../../src/types.ts';
import type { NumberingRange } from '@ladarr/shared/types';

let pipe: Awaited<ReturnType<typeof startPipeline>> | undefined;
let api: Awaited<ReturnType<Awaited<ReturnType<typeof startPipeline>>['api']>> | undefined;
afterEach(async () => {
  api?.close();
  await pipe?.stop();
  pipe = api = undefined;
});

// The confirmed range: catalog 1x13..1x23 are the episodes 1..11 of release season 2.
const RANGE: NumberingRange = { season: 1, from: 13, to: 23, releaseSeason: 2, releaseFrom: 1 };
const numbering = (ranges: NumberingRange[] = [RANGE], revision = 1): Numbering => ({ revision, ranges });
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => from + index);

const settings = { ...emptyData().settings };
const ctx = (extra: Partial<DecideContext> = {}): DecideContext => ({
  settings,
  quality: emptyData(),
  indexers: { 1: indexer() },
  downloading: () => false,
  hasFile: (one) => Boolean(one.fileId),
  hasMovieFile: (one) => Boolean(one.fileId),
  coverage: () => null,
  now: Date.UTC(2024, 5, 1),
  ...extra,
});

const show = title({ episodes: range(1, 23).map((number) => episode(1, number)) });

describe('season pack file matching', () => {
  it.each(['Show.S01/Bonus/E03.mkv', 'Bonus/E03.mkv', 'Show.S01/Bonus.E03.mkv'])('does not fill a missing episode with %s', (bonus) => {
    const files = ['Show.S01/E01.mkv', 'Show.S01/E02.mkv', bonus];
    const series = title({ episodes: range(1, 3).map((n) => episode(1, n)) });
    const manifest = readPackCoverage(files, series, numbering([]), 1);
    expect([...manifest.byFile.keys()]).toEqual(files.slice(0, 2));
    expect(manifest.status({ season: 1, number: 3 })).toBe('absent');
  });

  it('keeps episodes in the Specials folder for season zero', () => {
    const series = title({ episodes: [episode(0, 1), episode(0, 2)] });
    const files = ['Show/Specials/E01.mkv', 'Show/Specials/Bonus/E02.mkv'];
    const manifest = readPackCoverage(files, series, numbering([]), 0);
    expect(manifest.episodes).toEqual([{ season: 0, number: 1 }]);
  });

  it.each([1, 63])('does not use disc numbers for a season starting at episode %i', (first) => {
    const series = title({ episodes: [episode(1, first), episode(1, first + 1)] });
    const files = ['Show.S01/Disc 1.mkv', 'Show.S01/Disc 2.mkv'];
    const manifest = readPackCoverage(files, series, numbering([]), 1);
    expect(manifest.byFile.size).toBe(0);
    expect(manifest.unknown).toEqual(files);
  });

  it('uses the advertised season for unqualified files and respects explicit season numbers', () => {
    const series = title({ episodes: [episode(1, 1), episode(1, 2), episode(2, 1), episode(2, 2)] });
    const files = ['Show/E01.mkv', 'Show/S01E02.mkv'];
    const manifest = readPackCoverage(files, series, numbering([]), 2);
    expect([...manifest.byFile.values()]).toEqual([[{ season: 2, number: 1 }], [{ season: 1, number: 2 }]]);
    expect(manifest.status({ season: 2, number: 2 })).toBe('absent');
  });

  it('keeps manual file assignments and uses the release season for saved numbering', () => {
    const series = title({ episodes: [episode(1, 13), episode(1, 14)] });
    const files = ['Show/E01.mkv', 'Show/Bonus/E02.mkv'];
    const matches = { [files[1]!]: [{ season: 1, number: 14 }] };
    const manifest = readPackCoverage(files, series, numbering(), 2, matches);
    expect(manifest.byFile.get(files[0]!)).toEqual([{ season: 1, number: 13 }]);
    expect(manifest.byFile.get(files[1]!)).toEqual(matches[files[1]!]);
  });
});

describe('the decision of a release', () => {
  it('accepts the release episode that the range maps to the catalog target', () => {
    const want: Want = { kind: 'episode', title: show, season: 1, number: 13, numbering: numbering() };
    expect(decide(release('Show.Name.S02E01.1080p.WEB-DL-GRP'), want, ctx())).toMatchObject({
      accepted: true,
      kind: 'single',
      covers: [{ season: 1, number: 13 }],
    });
  });

  it('keeps the identity of an episode outside the ranges', () => {
    const want: Want = { kind: 'episode', title: show, season: 1, number: 12, numbering: numbering() };
    expect(decide(release('Show.Name.S01E12.1080p.WEB-DL-GRP'), want, ctx())).toMatchObject({
      accepted: true,
      covers: [{ season: 1, number: 12 }],
    });
  });

  it('accepts a pack of the release season for the catalog episodes of the range', () => {
    const want: Want = { kind: 'season', title: show, season: 1, releaseSeason: 2, numbering: numbering() };
    const decision = decide(release('Show.Name.S02.1080p.WEB-DL-GRP', { sizeBytes: 11 * 60 * 45 * MIB }), want, ctx());
    expect(decision).toMatchObject({ accepted: true, kind: 'pack' });
    expect(decision.covers).toEqual(range(13, 23).map((number) => ({ season: 1, number })));
  });

  it('rejects the release episode after the end of the range', () => {
    const want: Want = { kind: 'episode', title: show, season: 1, number: 24, numbering: numbering() };
    const decision = decide(release('Show.Name.S02E12.1080p.WEB-DL-GRP'), want, ctx());
    expect(decision.accepted).toBe(false);
    expect(decision.rejections.some((code) => code === 'wrong_episode' || code === 'wrong_season')).toBe(true);
  });
});

describe('the reading of a file name', () => {
  it('converts the release episode of the file to the catalog episode', () => {
    const episodes = [episode(1, 12), episode(1, 13)];
    expect(releaseEpisodes('Show.Name.S02E01.mkv', episodes, numbering())).toEqual({ season: 1, numbers: [13] });
  });
});

describe('the acquisition of a mapped episode', () => {
  it('asks for the release number and imports the file as the catalog episode', async () => {
    pipe = await startPipeline();
    const item = title({ rootId: 'tv', episodes: range(1, 23).map((number) => episode(1, number, '2020-01-01')) });
    pipe.db.data.titles[item.key] = item;
    const name = 'Show.Name.S02E01.1080p.WEB-DL-GRP';
    const files = ['Show.Name.S02E01.mkv'];
    const bad = { title: 'Show.Name.S01E13.1080p.WEB-DL-BAD', size: 60 * 45 * MIB, files: ['Show.Name.S01E12.mkv'] };
    pipe.tracker.state.answer = (query) => {
      if (query.searchParams.get('season') === '1' && query.searchParams.get('ep') === '13') return [bad];
      if (query.searchParams.get('season') === '2' && query.searchParams.get('ep') === '1') return [{ title: name, size: 60 * 45 * MIB, files }];
      return [];
    };
    const [entry] = pipe.finder.requestSearch(item.key, { season: 1, number: 13 });
    expect(entry).toBeDefined();
    await expect.poll(() => pipe!.queue.findItem(item.key, 1)?.state).toMatchObject({ kind: 'blocked', problem: { code: 'all_rejected' } });
    expect(pipe.acquisition.filter((event) => event.type === 'add')).toEqual([]);

    const earlier = entryOf({ id: `${item.key}:1x12`, titleKey: item.key, season: 1, number: 12, stage: 'available' });
    pipe.db.data.queue[earlier.id] = earlier;
    item.episodes.find(({ number }) => number === 12)!.fileId = 'earlier';
    pipe.db.data.files.earlier = { id: 'earlier', titleKey: item.key, path: 'Show Name (2020)/Season 01/Show Name - S01E12.mkv', sizeBytes: 1, mtimeMs: 0, episodes: [{ season: 1, number: 12 }], missing: false, addedAt: 1 };
    api = await pipe.api();
    const before = pipe.tracker.state.searches.length;
    const saved = await api.patch(`/library/${item.key}`, { episodeSeasons: { revision: 0, edits: [{ season: 1, number: 13, releaseSeason: 2, search: true }] } });
    expect(saved.status).toBe(200);
    await until(() => stageOf(entry!) === 'downloading');
    const page = await api.get('/queue?stage=downloading');
    expect(page.body.items).toMatchObject([{ key: `${item.key}:1`, season: 1 }]);
    const group = await api.get(`/queue/groups/${item.key}?season=1`);
    expect(group.body.items).toMatchObject([{ id: earlier.id, status: 'available' }, { id: entry!.id, season: 1, number: 13, label: 'Show Name S02E01' }]);
    expect((await api.get(`/queue/groups/${item.key}?season=2`)).body.items).toEqual([]);

    // The indexers get the release coordinates of the target. The catalog coordinates are never asked for.
    const asked = pipe.tracker.state.searches.slice(before);
    expect(asked.map((url) => [url.searchParams.get('season'), url.searchParams.get('ep')])).toEqual([['2', '1']]);
    expect(pipe.acquisition.filter((event) => event.type === 'add')).toEqual([{ type: 'add', hash: hashOf(name, files) }]);

    pipe.complete(name, { 'Show.Name.S02E01.mkv': 'mapped-data' }, hashOf(name, files));
    await until(() => stageOf(entry!) === 'available', 20_000);

    const fileId = item.episodes.find((one) => one.season === 1 && one.number === 13)?.fileId;
    expect(fileId).toBeTruthy();
    const file = pipe.db.data.files[fileId!];
    expect(file?.path).toContain('S01E13');
    expect(file?.episodes).toEqual([{ season: 1, number: 13 }]);
  }, 20_000);
});

describe('the numbering of a title', () => {
  it('saves and reads the ranges, and refuses a stale revision', async () => {
    pipe = await startPipeline();
    const item = title({ rootId: 'tv', episodes: range(1, 23).map((number) => episode(1, number)), numbering: numbering([], 0) });
    item.meta.seasons = [{ seasonNumber: 1, episodeCount: 23, airDate: '2020-01-01' }];
    pipe.db.data.titles[item.key] = item;
    api = await pipe.api();

    const saved = await api.patch(`/library/${item.key}`, { numbering: { revision: 0, ranges: [RANGE] } });
    expect(saved.status).toBe(200);

    const read = await api.get(`/library/${item.key}`);
    expect((read.body as { title: { numbering: Numbering } }).title.numbering).toEqual({ revision: 1, ranges: [RANGE] });
    expect(read.body.title.seasons).toMatchObject([
      { seasonNumber: 1, episodeCount: 12, counts: { total: 12 } },
      { seasonNumber: 2, episodeCount: 11, counts: { total: 11 } },
    ]);
    const first = await api.get(`/library/${item.key}/episodes?season=1`);
    const second = await api.get(`/library/${item.key}/episodes?season=2`);
    expect(first.body.episodes.map((ep: { number: number }) => ep.number)).toEqual(range(1, 12));
    expect(second.body.episodes).toMatchObject(range(1, 11).map((number) => ({ season: 2, number, name: `Episode ${number + 12}` })));

    // The stale request came from the version before the save.
    const stale = await api.patch(`/library/${item.key}`, { numbering: { revision: 0, ranges: [] } });
    expect(stale.status).toBe(409);
    expect(stale.body).toEqual({ error: 'numbering_changed' });
  });

  it('gives an older title the empty numbering and does not read a continuation as a range', () => {
    const data = emptyData();
    const item = title({ rootId: 'tv', episodes: [episode(1, 48)] });
    data.titles[item.key] = item;
    const entry = { id: 'tv:1:1x48', titleKey: item.key, season: 1, number: 48, continuation: { releaseSeason: 2, season: 1, from: 48 } } as unknown as QueueEntry;
    data.queue[entry.id] = entry;

    const next = withDefaults(data);

    expect(next.titles[item.key]!.numbering).toEqual({ revision: 0, ranges: [] });
    expect(next.titles[item.key]!.numbering!.ranges).toEqual([]);
  });

  it('adds and searches only the episodes of the selected release season', async () => {
    pipe = await startPipeline();
    await pipe.worker.pause();
    const item = title({ rootId: 'tv', episodes: range(1, 23).map((n) => episode(1, n)), numbering: numbering(), seasonOverrides: { 1: 'unmonitored' } });
    pipe.db.data.titles[item.key] = item;
    api = await pipe.api();
    const target = { titleKey: item.key, season: 2, numberingRevision: 1 };
    const path = `/library/${item.key}/seasons/2`;
    expect((await api.patch(path, { override: 'monitored', numberingRevision: 0 })).status).toBe(409);
    expect((await api.post('/queue/search', { ...target, numberingRevision: 0 })).status).toBe(409);
    expect((await api.patch(path, { override: 'monitored', numberingRevision: 1 })).status).toBe(200);
    expect(item.episodes.filter((ep) => ep.override === 'monitored').map((ep) => ep.number)).toEqual(range(13, 23));
    const result = await api.post('/queue/search', target);
    expect(result.status).toBe(202);
    expect(result.body.started).toEqual(range(13, 23).map((n) => `${item.key}:1x${n}`));
  });
});

describe('apply numbering to selected acquisitions', () => {
  async function blocked() {
    pipe = await startPipeline();
    await pipe.worker.pause();
    pipe.poller.stop();
    api = await pipe.api();
    const item = title({ rootId: 'tv', episodes: range(1, 23).map((number) => episode(1, number)), numbering: numbering([], 0) });
    pipe.db.data.titles[item.key] = item;
    const hash = hashOf('Show.Name.S02.1080p.WEB-DL-GRP');
    const entries = [13, 14].map((number) => entryOf({
      id: `tv:1:1x${number}`, titleKey: item.key, season: 1, number,
      stage: 'importing', reason: { code: 'numbering_required' },
      numbering: numbering([], 0), transferHash: hash, clientId: 'client-1',
    }));
    for (const entry of entries) pipe.db.data.queue[entry.id] = entry;
    pipe.qbit.torrents.set(hash, {
      hash, name: 'Show.Name.S02.1080p.WEB-DL-GRP', size: 1_000, progress: 1, state: 'uploading',
      category: 'ladarr', tags: '', save_path: pipe.folders.downloads, content_path: pipe.folders.downloads,
      dlspeed: 0, eta: 0, num_seeds: 1, num_leechs: 0, added_on: 1,
    });
    pipe.qbit.setFiles(hash, [{ name: 'Show.Name.S02E01.mkv', size: 1_000, progress: 1 }]);
    return { item, selected: entries[0]!, sibling: entries[1]! };
  }

  it('saves a map without a search, a job, or an acquisition snapshot change', async () => {
    const { item, selected, sibling } = await blocked();
    const before = structuredClone(pipe!.db.data.queue);
    const jobs = structuredClone(pipe!.db.data.jobs);

    expect((await api!.patch(`/library/${item.key}`, { numbering: numbering([RANGE], 0) })).status).toBe(200);

    expect(item.numbering).toEqual(numbering());
    expect(selected.numbering).toEqual(numbering([], 0));
    expect(sibling.numbering).toEqual(numbering([], 0));
    expect(pipe!.db.data.queue).toEqual(before);
    expect(pipe!.db.data.jobs).toEqual(jobs);
    expect(pipe!.tracker.state.searches).toEqual([]);
    expect(pipe!.tracker.state.downloads).toEqual([]);
  });

  it('previews and updates only the selected acquisition snapshot before import', async () => {
    const { item, selected, sibling } = await blocked();
    await api!.patch(`/library/${item.key}`, { numbering: numbering([RANGE], 0) });
    const siblingBefore = structuredClone(sibling);
    const body = { action: 'apply_numbering', ids: [selected.id] };
    const jobs = structuredClone(pipe!.db.data.jobs);

    const preview = await api!.post('/queue/actions', { ...body, preview: true });
    expect(preview.status).toBe(200);
    expect(preview.body.affected.map((entry: { id: string }) => entry.id)).toEqual([selected.id]);
    expect(selected.numbering).toEqual(numbering([], 0));
    expect(pipe!.db.data.jobs).toEqual(jobs);

    const applied = await api!.post('/queue/actions', { ...preview.body, ...body });
    expect(applied.status).toBe(200);
    expect(selected.numbering).toEqual(numbering());
    expect(selected.state).toEqual({ kind: 'importing' });
    expect(sibling).toEqual(siblingBefore);
    expect(pipe!.tracker.state.searches).toEqual([]);
    expect(pipe!.tracker.state.downloads).toEqual([]);
    expect(Object.values(pipe!.db.data.jobs).some((job) => ['queue.search', 'queue.grab', 'queue.send'].includes(job.type))).toBe(false);
  });

  it('applies numbering to a selected local source through import without a search', async () => {
    pipe = await startPipeline();
    await pipe.worker.pause();
    pipe.poller.stop();
    api = await pipe.api();
    const item = title({
      rootId: 'tv', folder: 'Show Name (2020)', episodes: [episode(1, 21), episode(1, 22)], numbering: numbering([], 0),
    });
    pipe.db.data.titles[item.key] = item;
    const folder = join(pipe.folders.tv, item.folder!, 'Season 01');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'Show.Name.S01E01.mkv'), 'episode-twenty-one');
    writeFileSync(join(folder, 'Show.Name.S01E02.mkv'), 'episode-twenty-two');
    const entries = [21, 22].map((number) => entryOf({
      id: `tv:1:1x${number}`, titleKey: item.key, season: 1, number,
      stage: 'importing', reason: { code: 'numbering_required' }, numbering: numbering([], 0),
      transferHash: null, clientId: null, source: null, release: null,
    }));
    for (const entry of entries) pipe.db.data.queue[entry.id] = entry;
    const [selected, sibling] = entries as [QueueEntry, QueueEntry];
    const before = structuredClone({ queue: pipe.db.data.queue, jobs: pipe.db.data.jobs });
    const saved = numbering([{ season: 1, from: 21, to: 22, releaseSeason: 1, releaseFrom: 1 }], 0);

    expect((await api.patch(`/library/${item.key}`, { numbering: saved })).status).toBe(200);
    expect({ queue: pipe.db.data.queue, jobs: pipe.db.data.jobs }).toEqual(before);
    const siblingBefore = structuredClone(sibling);
    const body = { action: 'apply_numbering', ids: [selected.id] };
    const preview = await api.post('/queue/actions', { ...body, preview: true });

    expect(preview.status).toBe(200);
    expect(preview.body.version).toEqual(expect.any(String));
    expect(preview.body.numbering).toEqual([
      expect.objectContaining({ id: selected.id, phase: 'importing', from: numbering([], 0), to: { ...saved, revision: 1 } }),
    ]);
    expect({ queue: pipe.db.data.queue, jobs: pipe.db.data.jobs }).toEqual(before);

    const applied = await api.post('/queue/actions', { ...preview.body, ...body });

    expect(applied.status).toBe(200);
    expect(selected.state).toEqual({ kind: 'importing' });
    expect(selected.numbering).toEqual({ ...saved, revision: 1 });
    expect(sibling).toEqual(siblingBefore);
    const local = Object.values(pipe.db.data.jobs).filter((job) => job.type === 'import.local');
    expect(local).toHaveLength(1);
    expect(local[0]!.payload).toEqual({ titleKey: item.key, entryIds: [selected.id], localOnly: true });
    expect(Object.values(pipe.db.data.jobs).some((job) => ['queue.search', 'queue.grab', 'queue.send', 'import.run'].includes(job.type))).toBe(false);
    expect(pipe.tracker.state.searches).toEqual([]);
    expect(pipe.tracker.state.downloads).toEqual([]);
    expect(pipe.qbit.torrents.size).toBe(0);
  });

  it('requires a preview before an acquisition map change and changes no data', async () => {
    const { item, selected } = await blocked();
    await api!.patch(`/library/${item.key}`, { numbering: numbering([RANGE], 0) });
    const before = structuredClone({ queue: pipe!.db.data.queue, jobs: pipe!.db.data.jobs, files: pipe!.db.data.files });

    const applied = await api!.post('/queue/actions', { action: 'apply_numbering', ids: [selected.id] });

    expect(applied.status).toBe(409);
    expect(applied.body.error).toBe('preview_required');
    expect({ queue: pipe!.db.data.queue, jobs: pipe!.db.data.jobs, files: pipe!.db.data.files }).toEqual(before);
  });

  it('rejects the preview after the saved map changes and changes no acquisition', async () => {
    const { item, selected } = await blocked();
    await api!.patch(`/library/${item.key}`, { numbering: numbering([RANGE], 0) });
    const body = { action: 'apply_numbering', ids: [selected.id] };
    const preview = await api!.post('/queue/actions', { ...body, preview: true });
    expect(preview.status).toBe(200);
    await api!.patch(`/library/${item.key}`, { numbering: numbering([{ ...RANGE, releaseSeason: 3 }], 1) });
    const before = structuredClone({ queue: pipe!.db.data.queue, jobs: pipe!.db.data.jobs });

    const applied = await api!.post('/queue/actions', { ...preview.body, ...body });

    expect(applied.status).toBe(409);
    expect({ queue: pipe!.db.data.queue, jobs: pipe!.db.data.jobs }).toEqual(before);
  });

  it('rejects a preview for a different selection', async () => {
    const { item, selected, sibling } = await blocked();
    await api!.patch(`/library/${item.key}`, { numbering: numbering([RANGE], 0) });
    const preview = await api!.post('/queue/actions', { action: 'apply_numbering', ids: [selected.id], preview: true });
    expect(preview.status).toBe(200);
    const before = structuredClone({ queue: pipe!.db.data.queue, jobs: pipe!.db.data.jobs });

    const applied = await api!.post('/queue/actions', {
      ...preview.body, action: 'apply_numbering', ids: [selected.id, sibling.id],
    });

    expect(applied.status).toBe(409);
    expect({ queue: pipe!.db.data.queue, jobs: pipe!.db.data.jobs }).toEqual(before);
  });
});
