import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { itemFor } from '../../src/library/downloads/queue.ts';
import { episode, movie, title } from '../helpers/test-fixtures.ts';
import { hashOf, MIB, startPipeline } from '../helpers/test-pipeline.ts';

type Pipeline = Awaited<ReturnType<typeof startPipeline>>;
let pipe: Pipeline | undefined;
let api: Awaited<ReturnType<Pipeline['api']>> | undefined;

afterEach(async () => {
  api?.close();
  await pipe?.stop();
  vi.restoreAllMocks();
  api = pipe = undefined;
});

describe('accepted file evidence', () => {
  it('does not publish Downloading from a poll before the running sender accepts the hash', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
      const response = await fetch(input, options);
      if (response.url.endsWith('/torrents/add')) await gate;
      return response;
    });
    const pipeline = pipe = await startPipeline();
    const app = api = await pipeline.api();
    await pipeline.poller.pause();
    const film = movie({ rootId: 'movie', manualRelease: true });
    const name = 'Movie.Name.2019.1080p.BluRay-GRP';
    const hash = hashOf(name);
    pipeline.db.data.titles[film.key] = film;
    pipeline.tracker.state.items = [{ title: name, size: 100 * 120 * MIB, category: 2040 }];
    pipeline.finder.requestSearch(film.key);
    const detail = async () => (await app.get(`/queue/entries/${film.key}`)).body.entry;

    try {
      await vi.waitFor(() => expect(pipeline.qbit.torrents.has(hash)).toBe(true));
      expect(Object.values(pipeline.db.data.jobs)).toContainEqual(expect.objectContaining({ type: 'queue.send', state: 'running' }));
      const item = itemFor(pipeline.queue.get(film.key)!)!;
      expect(item.selected[hash]?.status).toBe('uncertain');
      await pipeline.poller.tick();
      expect((await detail()).status).toBe('fetching');
      expect(item.selected[hash]?.status).toBe('uncertain');
    } finally {
      release();
    }

    await vi.waitFor(async () => expect((await detail()).status).toBe('downloading'));
    expect(pipeline.qbit.calls.filter(({ path }) => path === 'torrents/add')).toHaveLength(1);
  });

  it.each(['automatic', 'manual'] as const)('uses one verified multi-episode file for progress and import (%s)', async (kind) => {
    const journalSources: string[] = [];
    const probe = vi.fn(async () => ({ ok: true as const, durationSeconds: 5400, container: 'matroska', videoCodec: 'h264', audioLanguages: ['eng'] }));
    const pipeline = pipe = await startPipeline({
      probe,
      afterStep(state, step) {
        if (state === 'committed') journalSources.push(step.source);
      },
    });
    const app = api = await pipeline.api();
    const series = title({ rootId: 'tv', episodes: [episode(1, 1), episode(1, 2)] });
    const name = 'Show.Name.S01.1080p.WEB-DL-GRP';
    const chosen = kind === 'manual' ? 'Main/Feature.mkv' : 'Main/Show.Name.S01E01E02.mkv';
    const other = kind === 'manual' ? `Backup/${chosen}` : 'Other/Show.Name.S01E01.mkv';
    const files = [chosen, other];
    const hash = hashOf(name, files);
    const ids = ['tv:1:1x1', 'tv:1:1x2'];
    pipeline.db.data.titles[series.key] = series;
    pipeline.tracker.state.items = [{ title: name, size: 2 * 60 * 45 * MIB, files }];
    pipeline.finder.requestSearch(series.key);
    const group = async () => (await app.get(`/queue/groups/${series.key}?season=1`)).body.group;
    if (kind === 'manual') {
      await vi.waitFor(async () => expect(await group()).toMatchObject({ status: 'stuck' }));
      expect(pipeline.qbit.calls.filter(({ path }) => path === 'torrents/add')).toEqual([]);
      const match = { source: 'download', file: `${name}/${chosen}`, covers: [{ season: 1, number: 1 }, { season: 1, number: 2 }], ids };
      const path = `/queue/entries/${ids[0]}/match`;
      const preview = await app.post(path, { ...match, preview: true });
      expect(preview).toMatchObject({ status: 200, body: { file: match.file } });
      expect(await app.post(path, { ...match, version: preview.body.version })).toMatchObject({ status: 200, body: { done: true } });
    }
    await vi.waitFor(async () => expect(await group()).toMatchObject({ status: 'downloading' }));
    const accepted = itemFor(pipeline.queue.get(ids[0]!)!)!.selected[hash];
    expect(accepted).toMatchObject({ status: 'accepted', matches: {
      [ids[0]!]: `${name}/${chosen}`,
      [ids[1]!]: `${name}/${chosen}`,
    } });

    // The client lists the other file first. Its progress does not belong to either episode.
    await pipeline.poller.pause();
    pipeline.qbit.progress(hash, 0.5);
    pipeline.qbit.setFiles(hash, [
      { name: `${name}/${other}`, size: 1000, progress: 0.85 },
      { name: `${name}/${chosen}`, size: 1000, progress: 0.25 },
    ]);
    await pipeline.poller.tick();
    expect.soft(pipeline.poller.transfer(hash)?.entryProgress).toEqual({ [ids[0]!]: 0.25, [ids[1]!]: 0.25 });

    pipeline.complete(name, { [other]: 'other'.padEnd(1000), [chosen]: 'verified'.padEnd(1000) }, hash);
    await pipeline.poller.tick();
    await vi.waitFor(() => expect(['available', 'blocked']).toContain(pipeline.queue.get(ids[0]!)?.state.kind));
    await pipeline.worker.drain();

    expect.soft(ids.map((id) => pipeline.queue.get(id)?.state)).toEqual([{ kind: 'available' }, { kind: 'available' }]);
    const imported = Object.values(pipeline.db.data.files);
    expect(imported).toHaveLength(1);
    expect.soft(imported[0]).toMatchObject({ episodes: [{ season: 1, number: 1 }, { season: 1, number: 2 }], download: { hash, external: false } });
    expect.soft(readFileSync(join(pipeline.folders.tv, imported[0]!.path), 'utf8').trim()).toBe('verified');
    expect.soft(journalSources).toEqual([`${name}/${chosen}`]);
    expect.soft(series.episodes.map(({ fileId }) => fileId)).toEqual([imported[0]!.id, imported[0]!.id]);
    expect(probe).toHaveBeenCalledWith(join(pipeline.folders.downloads, name, chosen));
    expect(pipeline.qbit.calls.filter(({ path }) => path === 'torrents/add')).toHaveLength(1);
  });

  it('leaves a season Stuck after its last successful import when another episode failed its probe', async () => {
    const first = 'Show.Name.S01E01.mkv';
    const second = 'Show.Name.S01E02.mkv';
    const probe = vi.fn(async (path: string) => path.endsWith(first)
      ? { ok: false as const, reason: 'unreadable' as const }
      : { ok: true as const, durationSeconds: 2700, container: 'matroska', videoCodec: 'h264', audioLanguages: ['eng'] });
    const pipeline = pipe = await startPipeline({ probe });
    const app = api = await pipeline.api();
    const series = title({ rootId: 'tv', episodes: [episode(1, 1), episode(1, 2)] });
    const name = 'Show.Name.S01.1080p.WEB-DL-GRP';
    const files = [first, second];
    const hash = hashOf(name, files);
    pipeline.db.data.titles[series.key] = series;
    pipeline.tracker.state.items = [{ title: name, size: 2 * 60 * 45 * MIB, files }];
    pipeline.finder.requestSearch(series.key);
    const detail = async () => (await app.get(`/queue/groups/${series.key}?season=1`)).body;
    await vi.waitFor(async () => expect((await detail()).group.status).toBe('downloading'));

    pipeline.complete(name, { [first]: 'unreadable'.padEnd(1000), [second]: 'readable'.padEnd(1000) }, hash);
    await vi.waitFor(async () => expect((await detail()).items).toMatchObject([
      { number: 1, status: 'stuck', reason: { code: 'file_unreadable' } },
      { number: 2, status: 'available' },
    ]));
    await pipeline.worker.drain();

    expect(series.episodes[0]?.fileId).toBeNull();
    const imported = pipeline.db.data.files[series.episodes[1]!.fileId!];
    expect(imported).toMatchObject({ episodes: [{ season: 1, number: 2 }], download: { hash, external: false } });
    expect((await detail()).group).toMatchObject({ status: 'stuck', tabs: ['stuck'] });
    expect((await app.get('/queue?stage=importing')).body.total).toBe(0);
    expect((await app.get('/queue?stage=stuck')).body.total).toBe(1);
  });
});
