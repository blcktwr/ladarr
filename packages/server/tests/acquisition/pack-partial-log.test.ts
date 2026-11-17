import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeLog, logToFile, recentLogs } from '../../src/core/log.ts';
import { reasonOfEntry } from '../../src/library/downloads/queue.ts';
import { episode, title } from '../helpers/test-fixtures.ts';
import { MIB, startPipeline, until } from '../helpers/test-pipeline.ts';

let pipe: Awaited<ReturnType<typeof startPipeline>> | undefined;
let dir: string | undefined;
afterEach(async () => {
  await pipe?.stop();
  await closeLog();
  if (dir) rmSync(dir, { recursive: true, force: true });
  pipe = dir = undefined;
});

const PACK = 'Show.Name.S01.1080p.WEB-DL-GRP';
const MIB_PER_EPISODE = 600 * MIB;

const pad = (number: number) => String(number).padStart(2, '0');
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => from + index);

// A season of `total` episodes, and one pack that holds the first `held` of them. The other targets are the missing
// episodes: each one stops with `pack_partial` and writes one line of the log.
async function lacking(total: number, held: number) {
  dir = mkdtempSync(join(tmpdir(), 'ladarr-pack-partial-'));
  logToFile(join(dir, 'ladarr.log'), 10_000_000);
  pipe = await startPipeline();
  const series = title({ rootId: 'tv', episodes: range(1, total).map((number) => episode(1, number, '2020-01-01')) });
  pipe.db.data.titles[series.key] = series;
  const files = range(1, held).map((number) => `Show.Name.S01E${pad(number)}.mkv`);
  pipe.tracker.state.items = [{ title: PACK, size: held * MIB_PER_EPISODE, files }];
  const targets = pipe.finder.requestSearch(series.key);
  const missing = targets.slice(held);
  await until(() => missing.every((entry) => reasonOfEntry(entry)?.code === 'pack_partial'));
  await closeLog();
  const lines = (await recentLogs(10_000, { itemType: 'tv' })).filter((line) => line.event === 'release_failed' && line.code === 'pack_partial');
  return { missing, lines, files };
}

describe('the log line of a partial pack', () => {
  it('lists the first 20 missing episodes and the number of all of them, for a pack that lacks 30 episodes', async () => {
    const { missing, lines, files } = await lacking(50, 20);

    expect(missing).toHaveLength(30);
    expect(lines.map((line) => line.itemId).sort()).toEqual(missing.map((entry) => entry.id).sort());
    for (const line of lines) {
      expect(line.files).toBe(files.length);
      expect(line.missingCount).toBe(30);
      expect(line.missing).toEqual(range(21, 40).map((number) => `1x${number}`));
    }
    // The entries still stop with the pack as the reason.
    for (const entry of missing) expect(entry.state).toMatchObject({ kind: 'blocked', at: 'fetching', problem: { code: 'pack_partial' } });
  });

  it('lists every missing episode for a pack that lacks 3 episodes', async () => {
    const { missing, lines, files } = await lacking(23, 20);

    expect(missing).toHaveLength(3);
    expect(lines.map((line) => line.itemId).sort()).toEqual(missing.map((entry) => entry.id).sort());
    for (const line of lines) {
      expect(line.files).toBe(files.length);
      expect(line.missingCount).toBe(3);
      expect(line.missing).toEqual(['1x21', '1x22', '1x23']);
    }
    for (const entry of missing) expect(entry.state).toMatchObject({ kind: 'blocked', at: 'fetching', problem: { code: 'pack_partial' } });
  });
});
