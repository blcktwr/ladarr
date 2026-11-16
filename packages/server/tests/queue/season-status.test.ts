import { afterEach, describe, expect, it } from 'vitest';
import { episode, title } from '../helpers/test-fixtures.ts';
import { startPipeline } from '../helpers/test-pipeline.ts';
import { move } from '../helpers/test-queue.ts';
import { queueStatusOf } from '../../src/library/tools/queue-status.ts';

let pipe: Awaited<ReturnType<typeof startPipeline>> | undefined;
afterEach(async () => {
  await pipe?.stop();
  pipe = undefined;
});

describe('season status', () => {
  it('shows the same aggregate in the row and in the inspector, whatever tab is open', async () => {
    pipe = await startPipeline();
    const api = await pipe.api();
    const series = title({ rootId: 'tv', episodes: [episode(1, 1), episode(1, 2)] });
    pipe.db.data.titles[series.key] = series;

    const downloading = pipe.queue.ensure(series.key, 1, 1);
    pipe.queue.request(downloading, 'test');
    move(pipe.queue, downloading, { stage: 'downloading' }, 'test');

    const blocked = pipe.queue.ensure(series.key, 1, 2);
    pipe.queue.request(blocked, 'test');
    move(pipe.queue, blocked, { stage: 'importing', reason: { code: 'file_not_found' } }, 'test');

    // The row aggregates the whole season, so a blocked episode wins over a download.
    const list = (await api.get('/queue')).body;
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ kind: 'group', status: 'stuck', total: 2, counts: { downloading: 1, stuck: 1 } });

    // Only the aggregate status selects the tab of the row.
    for (const stage of ['', 'stuck']) {
      const body = (await api.get(`/queue?stage=${stage}`)).body;
      expect(body.total).toBe(1);
      expect(body.items[0].status).toBe('stuck');
    }
    expect((await api.get('/queue?stage=importing')).body.total).toBe(0);
    expect((await api.get('/queue?stage=downloading')).body.total).toBe(0);

    // The inspector reads the aggregate of the whole season, and it lists every episode of the season: the tab
    // filters the rows, not the children.
    const group = (await api.get('/queue/groups/tv:1?stage=downloading')).body;
    expect(group.group).toMatchObject({ status: 'stuck', total: 2, counts: { downloading: 1, stuck: 1 }, problem: { code: 'file_not_found' } });
    expect(group.items.map((entry: { status: string }) => entry.status)).toEqual(['downloading', 'stuck']);

    // The season counts only in the tab of its aggregate status.
    const summary = (await api.get('/queue/summary')).body;
    expect(summary.counts).toEqual({ stuck: 1 });
    expect(summary.targets).toBe(2);
    // A badge is the number of rows that its tab shows.
    for (const tab of ['queued', 'searching', 'downloading', 'importing', 'stuck']) {
      expect(summary.counts[tab] ?? 0).toBe((await api.get(`/queue?stage=${tab}`)).body.total);
    }
  });
  it('keeps a blocked season out of searching and waiting tabs', async () => {
    pipe = await startPipeline();
    const api = await pipe.api();
    const series = title({ rootId: 'tv', episodes: [episode(1, 1), episode(1, 2), episode(1, 3)] });
    pipe.db.data.titles[series.key] = series;
    for (const number of [1, 2, 3]) pipe.queue.request(pipe.queue.ensure(series.key, 1, number), 'test');
    const entries = [1, 2, 3].map((number) => pipe!.queue.ensure(series.key, 1, number));
    entries[0]!.state = { kind: 'blocked', at: 'searching', problem: { code: 'file_not_found' } };
    entries[1]!.state = { kind: 'searching' };
    entries[2]!.state = { kind: 'waiting', outcome: 'no_results' };

    expect((await api.get('/queue')).body.items[0]).toMatchObject({ status: 'stuck', tabs: ['stuck'] });
    expect((await api.get('/queue?stage=searching')).body.total).toBe(0);
    expect((await api.get('/queue?stage=queued')).body.total).toBe(0);
    expect((await api.get('/queue?stage=stuck')).body.total).toBe(1);
    expect((await api.get('/queue/summary')).body.counts).toEqual({ stuck: 1 });
    expect(queueStatusOf(series.key)).toBe('stuck');
  });
});
