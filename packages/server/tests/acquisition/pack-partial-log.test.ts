import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { closeLog, logToFile, recentLogs } from '../../src/core/log.ts';
import { episode, title } from '../helpers/test-fixtures.ts';
import { MIB, startPipeline } from '../helpers/test-pipeline.ts';

it('does not log a verified partial pack as a failed release when the missing episode stops the season', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ladarr-pack-partial-'));
  const pipe = await startPipeline();
  const api = await pipe.api();
  const pack = 'Show.Name.S01.1080p.WEB-DL-GRP';
  try {
    logToFile(join(dir, 'ladarr.log'));
    const series = title({ rootId: 'tv', episodes: [1, 2, 3].map((number) => episode(1, number)) });
    pipe.db.data.titles[series.key] = series;
    const files = ['Show.Name.S01E01.mkv', 'Show.Name.S01E02.mkv'];
    pipe.tracker.state.answer = (url) => url.searchParams.has('ep') ? [] : [{ title: pack, size: 2 * 60 * 45 * MIB, files }];
    pipe.finder.requestSearch(series.key);

    const status = async () => (await api.get(`/queue/groups/${series.key}?season=1`)).body.group.status;
    await expect.poll(status).toBe('stuck');
    await closeLog();
    const failed = (await recentLogs(100, { itemType: 'tv' })).filter((line) => line.event === 'release_failed' && line.code === 'pack_partial');
    expect(failed).toEqual([]);
  } finally {
    api.close();
    await pipe.stop();
    await closeLog();
    rmSync(dir, { recursive: true, force: true });
  }
});
