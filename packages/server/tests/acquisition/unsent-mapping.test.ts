import { expect, it, vi } from 'vitest';
import { episode, title } from '../helpers/test-fixtures.ts';
import { hashOf, MIB, startPipeline } from '../helpers/test-pipeline.ts';

it('maps an unsent pack from its manifest and adds it only after all requested files are mapped', async () => {
  const pipe = await startPipeline();
  const api = await pipe.api();
  try {
    const series = title({
      rootId: 'tv',
      meta: { ...title().meta, seasons: [{ seasonNumber: 1, episodeCount: 2, airDate: '2020-01-01' }] },
      episodes: [episode(1, 1), episode(1, 2)],
    });
    pipe.db.data.titles[series.key] = series;
    const pack = 'Show.Name.S01.1080p.WEB-DL-GRP';
    const files = ['part-alpha.mkv', 'part-beta.mkv'];
    const hash = hashOf(pack, files);
    const ids = series.episodes.map(({ number }) => `${series.key}:1x${number}`);
    const targetsPack = (job: { payload?: unknown }) => {
      const payload = job.payload as { hash?: string; titleKey?: string; entryIds?: string[] } | null | undefined;
      return Boolean(payload && (payload.hash === hash || payload.titleKey === series.key || payload.entryIds?.some((id) => ids.includes(id))));
    };
    using enqueue = vi.spyOn(pipe.worker, 'enqueue');
    pipe.tracker.state.items = [{ title: pack, size: 2 * 60 * 45 * MIB, files }];
    const group = async () => (await api.get(`/queue/groups/${series.key}?season=1`)).body.group;
    const status = async () => (await group()).status;
    const adds = () => pipe.acquisition.filter((event) => event.type === 'add');
    const expectNoImport = () => {
      const importsPack = (job: { type: string; payload?: unknown }) => ['import.local', 'import.run'].includes(job.type) && targetsPack(job);
      expect(enqueue.mock.calls.map(([job]) => job).filter(importsPack)).toEqual([]);
      expect(Object.values(pipe.db.data.jobs).filter(importsPack)).toEqual([]);
      expect(Object.values(pipe.db.data.imports).filter((journal) => journal.titleKey === series.key || journal.hash === hash)).toEqual([]);
      expect(Object.values(pipe.db.data.files).filter((file) => file.titleKey === series.key)).toEqual([]);
      expect(series.episodes.map(({ fileId }) => fileId)).toEqual([null, null]);
    };

    pipe.finder.requestSearch(series.key, { season: 1, fresh: true });
    await expect.poll(status).toBe('stuck');
    expect(await group()).toMatchObject({ problem: { code: 'file_unmapped' } });
    expect(pipe.tracker.state.downloads).toEqual([pack]);
    expect(adds()).toEqual([]);
    pipe.poller.stop();
    await pipe.worker.drain();
    const clientCallCount = pipe.qbit.calls.length;
    const expectNoTransferLookup = () => {
      expect(pipe.qbit.calls.slice(clientCallCount).filter(({ path }) => ['torrents/info', 'torrents/files'].includes(path))).toEqual([]);
    };

    const base = `/queue/entries/${series.key}:1x`;
    const manifest = await api.get(`${base}1/files?source=download`);
    expect(manifest.status, JSON.stringify(manifest.body)).toBe(200);
    const listed: { rel: string }[] = manifest.body.files;
    expect(listed.map(({ rel }) => rel.split('/').at(-1)).sort()).toEqual(files);

    function mapping(number: number) {
      const match = `${base}${number}/match`;
      const file = listed.find(({ rel }) => rel.split('/').at(-1) === files[number - 1])!.rel;
      const body = { source: 'download', file, covers: [{ season: 1, number }], ids: [`${series.key}:1x${number}`] };
      return {
        preview: () => api.post(match, { ...body, preview: true }),
        apply: (version: string) => api.post(match, { ...body, version }),
      };
    }

    const first = mapping(1);
    const second = mapping(2);
    const firstPreview = await first.preview();
    const oldSecondPreview = await second.preview();
    expect(firstPreview.status, JSON.stringify(firstPreview.body)).toBe(200);
    expect(oldSecondPreview.status, JSON.stringify(oldSecondPreview.body)).toBe(200);
    expect(firstPreview.body.version).toEqual(expect.any(String));
    expect(oldSecondPreview.body.version).toEqual(expect.any(String));
    expectNoTransferLookup();
    expectNoImport();

    expect((await first.apply(firstPreview.body.version)).status).toBe(200);
    pipe.worker.resume();
    await expect.poll(() => Object.values(pipe.db.data.jobs).filter((job) =>
      job.type.startsWith('queue.') && targetsPack(job) && ['waiting', 'running'].includes(job.state))).toEqual([]);
    await pipe.worker.drain();
    expect(adds()).toEqual([]);
    expectNoTransferLookup();
    expectNoImport();

    const stale = await second.apply(oldSecondPreview.body.version);
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe('preview_changed');
    expect(adds()).toEqual([]);
    expectNoTransferLookup();
    expectNoImport();

    const secondPreview = await second.preview();
    expect(secondPreview.status, JSON.stringify(secondPreview.body)).toBe(200);
    expect(secondPreview.body.version).not.toBe(oldSecondPreview.body.version);
    expect((await second.apply(secondPreview.body.version)).status).toBe(200);
    expect(adds()).toEqual([]);
    expectNoTransferLookup();
    expectNoImport();

    pipe.worker.resume();
    pipe.poller.start();
    await expect.poll(async () => {
      const current = await group();
      return { status: current.status, problem: current.problem?.code ?? null, adds: adds() };
    }).toEqual({ status: 'downloading', problem: null, adds: [{ type: 'add', hash }] });
    expect([...pipe.qbit.torrents.keys()]).toEqual([hash]);
    expect(pipe.tracker.state.downloads).toEqual([pack]);
    expectNoImport();
  } finally {
    api.close();
    await pipe.stop();
  }
}, 10_000);

async function withOpaqueVideo(run: (fixture: {
  pipe: Awaited<ReturnType<typeof startPipeline>>;
  api: Awaited<ReturnType<Awaited<ReturnType<typeof startPipeline>>['api']>>;
  group: string;
  first: string;
  second: string;
  match: { source: 'download'; file: string; covers: { season: number; number: number }[]; ids: string[] };
  pack: string;
  packHash: string;
  single: string;
  singleHash: string;
}) => Promise<void>, single = 'Show.Name.S01E02.1080p.WEB-DL-SINGLE') {
  const pipe = await startPipeline();
  const api = await pipe.api();
  try {
    const series = title({ rootId: 'tv', episodes: [episode(1, 1), episode(1, 2)] });
    pipe.db.data.titles[series.key] = series;
    const pack = 'Show.Name.S01.1080p.WEB-DL-PACK';
    const files = ['part-alpha.mkv'];
    const singleFiles = ['Show.Name.S01E02.mkv'];
    pipe.tracker.state.answer = (query) => {
      if (query.searchParams.get('season') !== '1') return [];
      const ep = query.searchParams.get('ep');
      if (ep === null) return [{ title: pack, size: 60 * 45 * MIB, files }];
      return Number(ep) === 2 ? [{ title: single, size: 60 * 45 * MIB, files: singleFiles }] : [];
    };
    const group = `/queue/groups/${series.key}?season=1`;
    const first = `/queue/entries/${series.key}:1x1`;
    const second = `/queue/entries/${series.key}:1x2`;
    pipe.finder.requestSearch(series.key, { season: 1, fresh: true });
    await expect.poll(async () => (await api.get(group)).body.group.status).toBe('stuck');
    expect((await api.get(group)).body.group.problem.code).toBe('file_unmapped');
    await pipe.worker.drain();
    const manifest = await api.get(`${first}/files?source=download`);
    expect(manifest.status, JSON.stringify(manifest.body)).toBe(200);
    expect(manifest.body.files).toHaveLength(1);
    const match = { source: 'download' as const, file: manifest.body.files[0].rel, covers: [{ season: 1, number: 1 }], ids: [`${series.key}:1x1`] };
    await run({ pipe, api, group, first, second, match, pack, packHash: hashOf(pack, files), single, singleHash: hashOf(single, singleFiles) });
  } finally {
    api.close();
    await pipe.stop();
  }
}

it('queries E02 separately after mapping the only opaque video to E01', async () => {
  await withOpaqueVideo(async ({ pipe, api, group, first, match, pack, packHash, single, singleHash }) => {
    const matchPath = `${first}/match`;
    const initial = [{ type: 'search', season: '1', episode: null }, { type: 'torrent', title: pack }];
    expect(pipe.acquisition).toEqual(initial);
    const preview = await api.post(matchPath, { ...match, preview: true });
    expect(preview.status).toBe(200);
    expect((await api.post(matchPath, { ...match, version: preview.body.version })).status).toBe(200);
    expect(pipe.acquisition).toEqual(initial);

    pipe.worker.resume();
    const inspected = [...initial, { type: 'search', season: '1', episode: '2' }, { type: 'torrent', title: single }];
    await expect.poll(() => pipe.acquisition.slice(0, inspected.length)).toEqual(inspected);
    await expect.poll(async () => (await api.get(group)).body.group.status).toBe('downloading');
    expect(pipe.acquisition.slice(inspected.length)).toHaveLength(2);
    expect(pipe.acquisition.slice(inspected.length)).toEqual(expect.arrayContaining([{ type: 'add', hash: packHash }, { type: 'add', hash: singleHash }]));
  });
}, 10_000);

it('does not count an E01 mapping apply as a manual retry of unselected E02', async () => {
  await withOpaqueVideo(async ({ api, first, second, match }) => {
    const before = (await api.get(second)).body.entry.attempt;
    expect(before).toEqual(expect.any(Number));
    const matchPath = `${first}/match`;
    const preview = await api.post(matchPath, { ...match, preview: true });
    expect(preview.status).toBe(200);
    expect((await api.get(second)).body.entry.attempt).toBe(before);

    const applied = await api.post(matchPath, { ...match, version: preview.body.version });
    expect(applied.status).toBe(200);
    expect((await api.get(second)).body.entry.attempt).toBe(before);
  });
}, 10_000);

it('keeps the pack that the user matched when the search for E02 stops the season', async () => {
  await withOpaqueVideo(async ({ pipe, api, group, first, match, pack, packHash }) => {
    const matchPath = `${first}/match`;
    const preview = await api.post(matchPath, { ...match, preview: true });
    expect((await api.post(matchPath, { ...match, version: preview.body.version })).status).toBe(200);

    pipe.worker.resume();
    await expect.poll(() => pipe.tracker.state.searches.some((url) => url.searchParams.get('ep') === '2')).toBe(true);
    await expect.poll(async () => (await api.get(group)).body.group.status).toBe('stuck');

    const [id] = match.ids;
    expect(pipe.queue.findItem('tv:1', 1)!.selected[packHash]).toMatchObject({ status: 'prepared', release: { title: pack }, matches: { [id!]: match.file } });
    expect(pipe.queue.get(id!)).toMatchObject({ transferHash: packHash, release: { title: pack } });
    expect(pipe.db.data.torrents[packHash]).toBeDefined();
  }, 'Show.Name.S01E02.480p.WEB-DL-SINGLE');
}, 10_000);
