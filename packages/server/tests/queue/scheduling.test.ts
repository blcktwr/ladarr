import { afterEach, describe, expect, it, vi } from 'vitest';
import { episode, movie, NOW, title } from '../helpers/test-fixtures.ts';
import { startPipeline } from '../helpers/test-pipeline.ts';

type Pipeline = Awaited<ReturnType<typeof startPipeline>>;
let pipe: Pipeline | undefined;
let api: Awaited<ReturnType<Pipeline['api']>> | undefined;

afterEach(async () => {
  api?.close();
  await pipe?.stop();
  api = pipe = undefined;
  vi.useRealTimers();
});

const turns = (pipeline: Pipeline) => pipeline.tracker.state.searches.flatMap(({ searchParams: p }) => {
  if (p.get('t') === 'movie') return ['movie'];
  return p.get('t') === 'tvsearch' && p.has('season') ? [`S${p.get('season')!.padStart(2, '0')}`] : [];
}).filter((target, index, requests) => index === 0 || target !== requests[index - 1]);

async function lineup() {
  vi.setSystemTime(NOW);
  const pipeline = pipe = await startPipeline();
  pipeline.db.data.queuePaused = true;
  const series = title({ rootId: 'tv', episodes: [episode(1, 1), episode(1, 2), episode(2, 1), episode(2, 2)] });
  const film = movie({ rootId: 'movie', manualRelease: true });
  pipeline.db.data.titles = { [series.key]: series, [film.key]: film };
  const admit = () => {
    pipeline.finder.requestSearch(series.key, { season: 2 });
    pipeline.finder.requestSearch(film.key);
    pipeline.finder.requestSearch(series.key, { season: 1 });
  };
  return { pipeline, series, film, admit };
}

describe('movie and season scheduling', () => {
  it('keeps the catalog season identity when its episodes map to different release seasons', async () => {
    const { pipeline, series } = await lineup();
    const app = api = await pipeline.api();
    pipeline.finder.requestSearch(series.key, { season: 1 });
    const before = (await app.get('/queue?stage=queued')).body;
    expect(before.items).toMatchObject([{ titleKey: series.key, season: 1, total: 2 }]);

    series.numbering = { revision: 1, ranges: [{ season: 1, from: 2, to: 2, releaseSeason: 3, releaseFrom: 1 }] };
    pipeline.finder.requestSearch(series.key, { season: 1 });
    const after = (await app.get('/queue?stage=queued')).body;
    expect(after.items).toMatchObject([{ key: before.items[0].key, titleKey: series.key, season: 1, total: 2 }]);
    const detail = (await app.get(`/queue/groups/${series.key}?season=1`)).body;
    expect(detail.items).toMatchObject([{ season: 1, number: 1 }, { season: 1, number: 2 }]);
  });

  it('keeps one stable row and one search turn per movie or season at the same admission time', async () => {
    const { pipeline, series, film, admit } = await lineup();
    const app = api = await pipeline.api();
    admit();
    const waiting = async () => (await app.get('/queue?stage=queued')).body;
    const before = await waiting();
    expect(before.total).toBe(3);
    expect(before.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ titleKey: series.key, season: 2 }),
      expect.objectContaining({ titleKey: film.key, season: null }),
      expect.objectContaining({ titleKey: series.key, season: 1 }),
    ]));

    admit();
    const after = await waiting();
    expect(after.total).toBe(3);
    expect(after.items.map((row: { key?: string; id?: string }) => row.key ?? row.id))
      .toEqual(before.items.map((row: { key?: string; id?: string }) => row.key ?? row.id));
    expect(pipeline.tracker.state.searches).toEqual([]);

    pipeline.db.data.queuePaused = false;
    await vi.waitFor(() => expect(turns(pipeline)).toHaveLength(3));
    await pipeline.worker.drain();
    expect(turns(pipeline)).toEqual(['S02', 'movie', 'S01']);
    expect(pipeline.tracker.state.searches.filter(({ searchParams: p }) => p.has('season') && !p.has('ep'))
      .map(({ searchParams }) => Number(searchParams.get('season')))).toEqual([2, 1]);
    expect(pipeline.qbit.calls.filter(({ path }) => path === 'torrents/add')).toEqual([]);
  });

  it.each([false, true])('puts an empty turn at the tail (retry due before the next turn: %s)', async (retryDue) => {
    const { pipeline, series, film } = await lineup();
    const app = api = await pipeline.api();
    pipeline.finder.requestSearch(series.key, { season: 2 });

    let drained: Promise<void> | undefined;
    pipeline.tracker.state.answer = (url) => {
      if (url.searchParams.get('season') === '2' && !drained) {
        drained = pipeline.worker.drain();
        pipeline.finder.requestSearch(film.key);
        pipeline.finder.requestSearch(series.key, { season: 1 });
      }
      return [];
    };
    pipeline.db.data.queuePaused = false;
    await vi.waitFor(() => expect(drained).toBeDefined());
    await drained;

    const waiting = await app.get('/queue?stage=queued');
    expect(waiting.body.items).toContainEqual(expect.objectContaining({ titleKey: series.key, season: 2, status: 'not_found' }));
    const detail = await app.get(`/queue/groups/${series.key}?season=2`);
    const due = detail.body.group.nextAt;
    expect(due).toBeGreaterThan(NOW);

    if (retryDue) vi.setSystemTime(due);
    pipeline.worker.resume();

    const expected = retryDue ? ['S02', 'movie', 'S01', 'S02'] : ['S02', 'movie', 'S01'];
    await vi.waitFor(() => expect(turns(pipeline)).toHaveLength(expected.length));
    expect(turns(pipeline)).toEqual(expected);
  });
});
