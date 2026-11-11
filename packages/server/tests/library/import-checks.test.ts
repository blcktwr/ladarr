import { afterEach, describe, expect, it } from 'vitest';
import type { QueueEntryView } from '@ladarr/shared/types';
import type { ImportCheck } from '@ladarr/shared/types';
import { unfinishedImports } from '../../src/library/imports/importer.ts';
import { view } from '../../src/helpers/queue.ts';
import { episode, movie, title } from '../helpers/test-fixtures.ts';
import { hashOf, MIB, startPipeline, until } from '../helpers/test-pipeline.ts';

let pipe: Awaited<ReturnType<typeof startPipeline>> | undefined;
afterEach(async () => {
  await pipe?.stop();
  pipe = undefined;
});

// The order and IDs of the checks, from the plan.
const CHECK_IDS = [
  'download_complete',
  'title_folder',
  'root_available',
  'download_in_client',
  'download_readable',
  'download_inside',
  'files_found',
  'destination_inside',
  'file_readable',
  'destination_free',
  'names_unique',
  'staged',
  'published',
  'committed',
  'retired',
] as const;

// The payload of an `import.checks` event, from the plan. The API is not implemented yet, so the test has its own shape.
type CheckEvent = { at: number; entries: { id: string; stage: string; key: string; checks: ImportCheck[] }[] };
const checksPublished = () => pipe!.published.filter((event) => event.type === 'import.checks').map((event) => event.data as CheckEvent);

const NAME = 'Movie.Name.2019.1080p.BluRay-GRP';
// How long each check stays in `running`, and the room for the clock of the timers.
const CHECK_DELAY_MS = 10;
const TIMER_TOLERANCE_MS = 5;

async function startMovie(options: Parameters<typeof startPipeline>[0] = {}) {
  pipe = await startPipeline(options);
  const film = movie({ rootId: 'movie', manualRelease: true });
  pipe.db.data.titles[film.key] = film;
  pipe.tracker.state.items = [{ title: NAME, size: 100 * 120 * MIB }];
  const [entry] = pipe.finder.requestSearch(film.key);
  await until(() => entry!.stage === 'downloading');
  return entry!;
}

describe('import checks', () => {
  it('runs the 15 checks in order, while the target moves from validating to importing', async () => {
    const entry = await startMovie({ checkDelayMs: CHECK_DELAY_MS });

    // The entry view exposes the list while the import runs.
    const views: { stage: string; checks: ImportCheck[] | null }[] = [];
    pipe!.complete(NAME, { [`${NAME}.mkv`]: 'video-data' });
    await until(() => {
      const current = view(pipe!.poller, pipe!.importStatus, entry, new Map()) as QueueEntryView & { checks: ImportCheck[] | null };
      if (current.checks) views.push({ stage: current.stage, checks: current.checks });
      return entry.stage === 'available';
    });

    expect(views.length).toBeGreaterThan(0);
    expect(views.every((current) => current.checks?.map((check) => check.id).join() === CHECK_IDS.join())).toBe(true);

    const events = checksPublished();
    // One event for each state change: the whole list pending, then running and ok for each check.
    expect(events.length).toBeGreaterThanOrEqual(30);
    for (const event of events) {
      expect(event.entries.length).toBeGreaterThan(0);
      for (const item of event.entries) expect(item.checks.map((check) => check.id)).toEqual([...CHECK_IDS]);
    }

    // Every check is running and then ok. The running transition keeps the stage of the target.
    const transitions = new Map<string, string[]>(CHECK_IDS.map((id) => [id, []]));
    const order: string[] = [];
    const stageOf = new Map<string, string>();
    const runningAt = new Map<string, number>();
    for (const event of events) {
      for (const item of event.entries) {
        for (const check of item.checks) {
          const seen = transitions.get(check.id);
          if (!seen) continue;
          const previous = seen.at(-1);
          if (check.state !== previous) seen.push(check.state);
          if (check.state === 'running' && previous !== 'running') {
            order.push(check.id);
            stageOf.set(check.id, item.stage);
            // The check's own `at` is the moment of the state change; `event.at` is the publish time.
            runningAt.set(check.id, check.at!);
          }
        }
      }
    }
    expect(order).toEqual([...CHECK_IDS]);
    for (const id of CHECK_IDS) expect(transitions.get(id)!.filter((state) => state !== 'pending')).toEqual(['running', 'ok']);
    expect(stageOf.get('download_complete')).toBe('validating');
    for (const id of CHECK_IDS.slice(1)) expect(stageOf.get(id)).toBe('importing');

    // A check stays running for at least the configured delay, also between one check and the next.
    const starts = CHECK_IDS.map((id) => runningAt.get(id)!);
    // The 15 checks add up to 100 ms or more.
    expect(starts.at(-1)! - starts[0]!).toBeGreaterThanOrEqual(100);
    for (let index = 1; index < starts.length; index++) {
      const gap = starts[index]! - starts[index - 1]!;
      expect(gap, `gap ${CHECK_IDS[index - 1]} -> ${CHECK_IDS[index]} is ${gap} ms`).toBeGreaterThanOrEqual(CHECK_DELAY_MS - TIMER_TOLERANCE_MS);
    }

    expect(entry.stage).toBe('available');
  });

  it('marks the failed check, leaves the following checks pending, and blocks the target', async () => {
    const entry = await startMovie({ checkDelayMs: 10, probe: async () => ({ ok: false, reason: 'unreadable' }) });
    pipe!.complete(NAME, { [`${NAME}.mkv`]: 'broken' });
    await until(() => entry.reason?.code === 'file_unreadable');

    const events = checksPublished();
    expect(events.length).toBeGreaterThan(0);
    const item = events.at(-1)?.entries.find((current) => current.id === entry.id);
    expect(item).toBeDefined();

    const failedAt = CHECK_IDS.indexOf('file_readable');
    const expected = CHECK_IDS.map((_, index) => (index < failedAt ? 'ok' : index === failedAt ? 'failed' : 'pending'));
    expect(item?.checks.map((check) => check.state)).toEqual(expected);

    expect(entry.stage).toBe('importing');
    expect(entry.branch).toBeNull();
    expect(entry.reason).toMatchObject({ code: 'file_unreadable' });
  });

  it('shares one check list between the targets of a pack', async () => {
    pipe = await startPipeline();
    const series = title({ rootId: 'tv', episodes: [episode(1, 1, '2020-01-01'), episode(1, 2, '2020-01-02')] });
    pipe.db.data.titles[series.key] = series;
    const pack = 'Show.Name.S01.1080p.WEB-DL-GRP';
    pipe.tracker.state.items = [{ title: pack, size: 2 * 60 * 45 * MIB }];
    const entries = pipe.finder.requestSearch(series.key);
    expect(entries.map((entry) => entry.id)).toEqual(['tv:1:1x1', 'tv:1:1x2']);
    await until(() => entries.every((entry) => entry.stage === 'downloading'));

    pipe.complete(pack, { 'Show.Name.S01E01.mkv': 'one', 'Show.Name.S01E02.mkv': 'two' });
    await until(() => entries.every((entry) => entry.stage === 'available'));

    const events = checksPublished();
    expect(events.length).toBeGreaterThanOrEqual(30);
    const ids = entries.map((entry) => entry.id).sort();
    for (const event of events) {
      // Every event carries both targets of the pack, and both see the same list.
      expect(event.entries.map((item) => item.id).sort()).toEqual(ids);
      const first = event.entries[0];
      expect(first?.checks.map((check) => check.id)).toEqual([...CHECK_IDS]);
      for (const item of event.entries) expect(item.checks).toEqual(first?.checks);
    }
  });

  it('returns the hash of a target in importing with no journal', async () => {
    pipe = await startPipeline();
    const film = movie({ rootId: 'movie' });
    pipe.db.data.titles[film.key] = film;
    const hash = hashOf(NAME);
    const entry = pipe.queue.ensure(film.key, null, null);
    Object.assign(entry, { stage: 'importing', branch: null, reason: null, transferHash: hash, clientId: 'client-1', attempt: 1 });

    expect(pipe.db.data.imports).toEqual({});
    expect(unfinishedImports()).toContain(hash);
  });
});
