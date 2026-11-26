import { afterEach, describe, expect, it } from 'vitest';
import { itemFor } from '../../src/library/downloads/queue.ts';
import { episode, movie, title } from '../helpers/test-fixtures.ts';
import { startPipeline } from '../helpers/test-pipeline.ts';

type Pipeline = Awaited<ReturnType<typeof startPipeline>>;
let pipe: Pipeline | undefined;
let api: Awaited<ReturnType<Pipeline['api']>> | undefined;
afterEach(async () => {
  api?.close();
  await pipe?.stop();
  api = pipe = undefined;
});

describe('season status', () => {
  it('shows an episode problem in the inspector without promoting it to a season stop', async () => {
    pipe = await startPipeline();
    api = await pipe.api();
    pipe.db.data.queuePaused = true;
    const series = title({ rootId: 'tv', episodes: [episode(1, 1), episode(1, 2), episode(2, 1)] });
    pipe.db.data.titles[series.key] = series;
    pipe.finder.requestSearch(series.key, { season: 1 });
    pipe.finder.requestSearch(series.key, { season: 2 });

    const first = pipe.queue.ensure(series.key, 1, 1);
    pipe.queue.block(first, { code: 'file_not_found' }, 'episode import failed');

    const list = (await api.get('/queue?stage=queued')).body;
    expect.soft(list.total).toBe(2);
    expect.soft(list.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ season: 1, status: 'queued', tabs: ['queued'], counts: { stuck: 1, queued: 1 } }),
      expect.objectContaining({ season: 2, status: 'queued', tabs: ['queued'] }),
    ]));
    expect.soft((await api.get('/queue?stage=stuck')).body.total).toBe(0);
    expect.soft((await api.get('/queue/summary')).body.counts).toEqual({ queued: 2 });
    const detail = (await api.get(`/queue/groups/${series.key}?season=1&stage=queued`)).body;
    expect.soft(detail.group).toMatchObject({ status: 'queued' });
    expect(detail.items).toMatchObject([
      { id: first.id, number: 1, status: 'stuck', reason: { code: 'file_not_found' } },
      { number: 2, status: 'queued' },
    ]);
  });

  it('does not let a newly queued movie enter downloading without an accepted transfer', async () => {
    pipe = await startPipeline();
    api = await pipe.api();
    pipe.db.data.queuePaused = true;
    const film = movie({ rootId: 'movie', manualRelease: true });
    pipe.db.data.titles[film.key] = film;
    pipe.finder.requestSearch(film.key);

    const entry = pipe.queue.ensure(film.key, null, null);
    expect(pipe.queue.transitionItem(itemFor(entry)!, { kind: 'downloading' })).toBe(false);
    expect((await api.get('/queue?stage=queued')).body.items).toMatchObject([{ titleKey: film.key, status: 'queued' }]);
    expect((await api.get('/queue?stage=downloading')).body.total).toBe(0);
  });
});
