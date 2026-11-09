import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createImportStatus } from '../../src/library/imports/status.ts';
import { createEvents } from '../../src/core/events.ts';
import { movie } from '../helpers/test-fixtures.ts';
import { noLink, sleep } from '../helpers/test-import.ts';
import { MIB, startPipeline, until } from '../helpers/test-pipeline.ts';

let pipe: Awaited<ReturnType<typeof startPipeline>> | undefined;
let api: Awaited<ReturnType<NonNullable<typeof pipe>['api']>> | undefined;
afterEach(async () => {
  api?.close();
  await pipe?.stop();
  pipe = api = undefined;
});

// Like `until`, for a check that waits for the API.
async function untilAsync(check: () => Promise<unknown> | unknown, timeoutMs = 8_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(15);
  }
  throw new Error(`Timeout: ${check.toString()}`);
}

const NAME = 'Movie.Name.2019.1080p.BluRay-GRP';
const CHUNK = 4096;
const CHUNKS = 5;

// A copy that takes time: it writes the file in chunks. The staged file grows, as it does with a big file.
const slowCopy = async (source: import('node:fs').PathLike, target: import('node:fs').PathLike) => {
  const data = readFileSync(source);
  const file = await open(target, 'wx');
  try {
    for (let i = 0; i < CHUNKS; i++) {
      await file.write(data.subarray(i * CHUNK, (i + 1) * CHUNK));
      await sleep(80);
    }
  } finally {
    await file.close();
  }
};

async function start(options: Parameters<typeof startPipeline>[0]) {
  pipe = await startPipeline(options);
  api = await pipe.api();
  const film = movie({ rootId: 'movie', manualRelease: true });
  pipe.db.data.titles[film.key] = film;
  pipe.tracker.state.items = [{ title: NAME, size: 100 * 120 * MIB }];
  const [entry] = pipe.finder.requestSearch(film.key);
  await until(() => entry!.stage === 'downloading');
  return entry!;
}

describe('copy progress', () => {
  it('shows the bytes that the copy wrote, and the method and the step apart from them', async () => {
    const entry = await start({ fs: { link: noLink('EXDEV'), copyFile: slowCopy }, copyPollMs: 15 });
    const total = CHUNK * CHUNKS;
    pipe!.complete(NAME, { [`${NAME}.mkv`]: 'x'.repeat(total) });

    const seen: number[] = [];
    let during: Record<string, any> | undefined;
    await untilAsync(async () => {
      const copy = pipe!.importStatus.copyOf(entry.id);
      if (copy) {
        seen.push(copy.copiedBytes);
        if (copy.copiedBytes > 0 && copy.copiedBytes < total) during ??= (await api!.get(`/queue/entries/${entry.id}`)).body.entry;
      }
      return entry.stage === 'available';
    });

    // The numbers come from the size of the staged file: they rise, and they stay inside the size of the file.
    expect(seen.length).toBeGreaterThan(1);
    expect(Math.max(...seen)).toBeGreaterThan(0);
    expect(Math.max(...seen)).toBeLessThanOrEqual(total);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
    expect(new Set(seen).size).toBeGreaterThan(2);
    // The queue API shows them with the entry. The method is not known before the copy ends, and the step is Planned.
    expect(during).toMatchObject({ stage: 'importing', import: { state: 'planned', method: null } });
    expect(during!.import.copy.copiedBytes).toBeGreaterThan(0);
    expect(during!.import.copy).toMatchObject({ totalBytes: total });
    expect(during!.import.copy.copiedBytes).toBeLessThan(total);

    // The copy is over: the bytes are gone from memory and from the API, and the result has the method.
    expect(pipe!.importStatus.copyOf(entry.id)).toBeUndefined();
    const done = (await api!.get(`/queue/entries/${entry.id}`)).body.entry;
    expect(done).toMatchObject({ stage: 'available', import: null, importResult: { method: 'copy' } });
    // The events carry the copies, and the last one is empty.
    const events = pipe!.published.filter((event) => event.type === 'import.copy');
    expect(events.length).toBeGreaterThan(1);
    expect(events.some((event) => event.data.copies.some((copy: { entryIds: string[]; totalBytes: number }) => copy.entryIds.includes(entry.id) && copy.totalBytes === total))).toBe(true);
    expect(events.at(-1)!.data.copies).toEqual([]);
    expect(readFileSync(join(pipe!.folders.movies, 'Movie Name (2019)', 'Movie Name (2019).mkv'), 'utf8')).toBe('x'.repeat(total));
  });

  it('shows no bytes for a hard link, and shows the method after the step', async () => {
    const entry = await start({ afterStep: async (state) => void (state === 'staged' && (await sleep(150))), copyPollMs: 15 });
    pipe!.complete(NAME, { [`${NAME}.mkv`]: 'video-data' });
    // The import waits after "staged". The queue shows the step and the method, and no copy.
    let staged: Record<string, any> | undefined;
    await untilAsync(async () => {
      if (entry.stage === 'importing') {
        const view = (await api!.get(`/queue/entries/${entry.id}`)).body.entry;
        if (view.import?.state === 'staged') staged = view;
      }
      return staged || entry.stage === 'available';
    });
    expect(staged).toMatchObject({ stage: 'importing', import: { state: 'staged', method: 'hardlink', copy: null } });
    await until(() => entry.stage === 'available');
    expect(pipe!.published.filter((event) => event.type === 'import.copy')).toEqual([]);
  });

  it('removes the bytes of a copy that fails', async () => {
    const entry = await start({
      fs: {
        link: noLink('EXDEV'),
        copyFile: async (_source, target) => {
          const file = await open(target, 'wx');
          await file.write('half');
          await file.close();
          await sleep(60);
          throw Object.assign(new Error('full'), { code: 'ENOSPC' });
        },
      },
      copyPollMs: 15,
    });
    pipe!.complete(NAME, { [`${NAME}.mkv`]: 'video-data' });
    await until(() => entry.reason?.code === 'disk_full');
    expect(pipe!.importStatus.copyOf(entry.id)).toBeUndefined();
    expect(pipe!.published.filter((event) => event.type === 'import.copy').at(-1)!.data.copies).toEqual([]);
  });
});

describe('the status object', () => {
  it('reads the size of the file again at the interval, and stops at the end', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ladarr-status-'));
    const status = createImportStatus(createEvents(), { pollMs: 10 });
    const path = join(dir, 'stage');
    writeFileSync(path, 'ab');
    const stop = status.watchCopy('j', 'dest', ['e1'], path, 10);
    await until(() => status.copyOf('e1')?.copiedBytes === 2);
    appendFileSync(path, 'cdef');
    await until(() => status.copyOf('e1')?.copiedBytes === 6);
    // A file that grows past the size of the plan does not give more than 100 percent.
    appendFileSync(path, 'x'.repeat(50));
    await until(() => status.copyOf('e1')?.copiedBytes === 10);
    stop();
    expect(status.copyOf('e1')).toBeUndefined();
    expect(status.copyOfStep('j', 'dest')).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the last 50 runs', () => {
    const status = createImportStatus(createEvents());
    for (let i = 0; i < 60; i++) status.begin(`run${i}`, 'import', 'tv:1', 1);
    expect(status.run('run0')).toBeUndefined();
    expect(status.run('run9')).toBeUndefined();
    expect(status.run('run10')).toMatchObject({ total: 1 });
    expect(status.run('run59')).toMatchObject({ total: 1 });
  });
});
