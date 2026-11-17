import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyData, open } from '../../src/core/db.ts';
import { createEvents } from '../../src/core/events.ts';
import { createPoller } from '../../src/library/downloads/poller.ts';
import { createQueue } from '../../src/library/downloads/queue.ts';
import { releaseEpisodes } from '../../src/library/parse.ts';
import { episode, title } from '../helpers/test-fixtures.ts';
import { entryOf } from '../helpers/test-queue.ts';
import type { Clients, ClientHandle, QueueEntry, Title, Torrent } from '../../src/types.ts';
import type { Numbering } from '@ladarr/shared/types';

// The real parser, wrapped, so a test counts the files that the poller reads.
vi.mock('../../src/library/parse.ts', async (importActual) => {
  const actual = await importActual<typeof import('../../src/library/parse.ts')>();
  return { ...actual, releaseEpisodes: vi.fn(actual.releaseEpisodes) };
});

const MIB = 1024 * 1024;
const PACK = 'Show.Name.S01.1080p.WEB-DL-GRP';
const HASH = 'a'.repeat(40);

const pad = (number: number) => String(number).padStart(2, '0');
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => from + index);
const calls = () => vi.mocked(releaseEpisodes).mock.calls.length;

type File = { name: string; sizeBytes: number; progress: number };

// One poll tick of a client that holds one pack. The client lists `files`, and each entry is a target of the pack.
async function tick(series: Title, entries: QueueEntry[], files: File[]) {
  const db = await open('unused.json');
  Object.assign(db.data, emptyData());
  db.data.titles[series.key] = series;
  for (const entry of entries) db.data.queue[entry.id] = entry;
  const torrent = {
    hash: HASH,
    name: PACK,
    sizeBytes: 100 * MIB,
    progress: 0.5,
    amountLeft: 50 * MIB,
    downloadRate: 1,
    uploadRate: 0,
    etaSeconds: 10,
    state: 'downloading',
    status: 'downloading',
    complete: false,
    savePath: '/downloads',
    contentPath: `/downloads/${PACK}`,
    category: '',
    tags: '',
    seeds: 1,
    peers: 1,
    addedAt: 0,
    ratio: 0,
    seedingSeconds: 0,
    tracker: '',
    queuePosition: null,
    swarmSeeds: null,
    swarmPeers: null,
    availability: null,
  } as Torrent;
  const handle = { id: 'client-1', api: { files: async () => files }, config: {} } as unknown as ClientHandle;
  const clients = { all: () => [handle], list: async () => [torrent] } as unknown as Clients;
  const events = createEvents();
  const poller = createPoller({ queue: createQueue(events, () => {}), events, clients, enqueue: vi.fn() as never });
  vi.mocked(releaseEpisodes).mockClear();
  await poller.tick();
  return poller.transfer(HASH)!;
}

const target = (number: number, extra: Partial<QueueEntry> = {}) =>
  entryOf({ id: `tv:1:1x${number}`, titleKey: 'tv:1', season: 1, number, stage: 'downloading', transferHash: HASH, clientId: 'client-1', ...extra });

// The file of a release episode, as the client lists it in the folder of the pack.
const file = (number: number, season = 1): File => ({ name: `${PACK}/Show.Name.S${pad(season)}E${pad(number)}.mkv`, sizeBytes: number * MIB, progress: number / 100 });
const nameOf = (number: number, season = 1) => `Show.Name.S${pad(season)}E${pad(number)}.mkv`;

beforeEach(() => {
  vi.mocked(releaseEpisodes).mockClear();
});

describe('the files of a pack in the poll', () => {
  it('reads each file once for a pack with one target for each file, and gives each target its own file', async () => {
    const N = 40;
    const series = title({ episodes: range(1, N).map((number) => episode(1, number)) });
    const entries = range(1, N).map((number) => target(number));
    // The client lists the files in the reverse order of the episodes, and each file has its own part.
    const transfer = await tick(series, entries, range(1, N).reverse().map((number) => file(number)));

    expect(transfer.entryIds).toEqual(entries.map((entry) => entry.id));
    expect(Object.keys(transfer.entryProgress!)).toHaveLength(N);
    for (const number of range(1, N)) {
      expect(transfer.entryProgress![`tv:1:1x${number}`]).toBe(number / 100);
      expect(transfer.entryFiles![`tv:1:1x${number}`]).toEqual({ name: nameOf(number), sizeBytes: number * MIB });
    }
    // One read for each file at most, and not one for each pair of a target and a file.
    expect(calls()).toBeGreaterThan(0);
    expect(calls()).toBeLessThanOrEqual(N);
  });

  it('keeps the files of two numberings apart, and reads each file once for each numbering', async () => {
    // The files are the release episodes 1 to 10 of season 2. The first numbering maps them to the catalog episodes 1 to
    // 10 of season 1, and the second numbering maps the same names to the catalog episodes 11 to 20.
    const FILES = 10;
    const series = title({ episodes: range(1, 2 * FILES).map((number) => episode(1, number)) });
    const first: Numbering = { revision: 1, ranges: [{ season: 1, from: 1, to: FILES, releaseSeason: 2, releaseFrom: 1 }] };
    const second: Numbering = { revision: 1, ranges: [{ season: 1, from: FILES + 1, to: 2 * FILES, releaseSeason: 2, releaseFrom: 1 }] };
    // Each target has its own copy of its numbering, as a database that was read from the disk gives.
    const entries = [...range(1, FILES).map((number) => target(number, { numbering: structuredClone(first) })), ...range(FILES + 1, 2 * FILES).map((number) => target(number, { numbering: structuredClone(second) }))];
    const transfer = await tick(series, entries, range(1, FILES).map((number) => file(number, 2)));

    expect(Object.keys(transfer.entryProgress!)).toHaveLength(2 * FILES);
    for (const number of range(1, FILES)) {
      // The first numbering selects the file with the same number, and the second one selects it for the next ten targets.
      expect(transfer.entryProgress![`tv:1:1x${number}`]).toBe(number / 100);
      expect(transfer.entryFiles![`tv:1:1x${number}`]).toEqual({ name: nameOf(number, 2), sizeBytes: number * MIB });
      expect(transfer.entryProgress![`tv:1:1x${FILES + number}`]).toBe(number / 100);
      expect(transfer.entryFiles![`tv:1:1x${FILES + number}`]).toEqual({ name: nameOf(number, 2), sizeBytes: number * MIB });
    }
    // Two numberings, and ten files: twenty reads at most.
    expect(calls()).toBeGreaterThan(0);
    expect(calls()).toBeLessThanOrEqual(2 * FILES);
  });
});
