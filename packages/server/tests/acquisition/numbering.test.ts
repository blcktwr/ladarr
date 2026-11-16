import { afterEach, describe, expect, it } from 'vitest';
import { emptyData, withDefaults } from '../../src/core/db.ts';
import { decide } from '../../src/library/grab/decide.ts';
import { stageOf } from '../../src/library/downloads/queue.ts';
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
    const item = title({ rootId: 'tv', episodes: range(1, 23).map((number) => episode(1, number, '2020-01-01')), numbering: numbering() });
    pipe.db.data.titles[item.key] = item;
    const name = 'Show.Name.S02E01.1080p.WEB-DL-GRP';
    const files = ['Show.Name.S02E01.mkv'];
    pipe.tracker.state.items = [{ title: name, size: 60 * 45 * MIB, files }];

    const [entry] = pipe.finder.requestSearch(item.key, { season: 1, number: 13 });
    expect(entry).toBeDefined();
    await until(() => stageOf(entry!) === 'downloading');

    // The indexers get the release coordinates of the target. The catalog coordinates are never asked for.
    const asked = pipe.tracker.state.searches;
    expect(asked.some((url) => url.searchParams.get('season') === '2' && url.searchParams.get('ep') === '1')).toBe(true);
    expect(asked.some((url) => url.searchParams.get('season') === '1' && url.searchParams.get('ep') === '13')).toBe(false);

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
    pipe.db.data.titles[item.key] = item;
    api = await pipe.api();

    const saved = await api.patch(`/library/${item.key}`, { numbering: { revision: 0, ranges: [RANGE] } });
    expect(saved.status).toBe(200);

    const read = await api.get(`/library/${item.key}`);
    expect((read.body as { title: { numbering: Numbering } }).title.numbering).toEqual({ revision: 1, ranges: [RANGE] });

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
});
