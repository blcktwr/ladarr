import { afterEach, expect, it } from 'vitest';
import { createClients } from '../../src/library/downloads/client-api.ts';
import { readSource } from '../../src/library/grab/source.ts';
import { infoHashOf, torrentInfo } from '../../src/library/grab/torrent.ts';
import { movie, release } from '../helpers/test-fixtures.ts';
import { hashOf, makeTorrent, MIB, startPipeline, type FakeItem } from '../helpers/test-pipeline.ts';

const NAME = 'Movie.Name.2019.1080p.BluRay-GRP';
const CUTS = ['Theatrical/Feature.mkv', 'Extended/Feature.mkv'];
const EXTRAS = ['readme.txt', 'Sample/sample.mkv'];
const FEATURE = 'Main/Movie.Name.2019.mkv';
const SIZE = 100 * 120 * MIB;
const ID = 'movie:2';
const URL = `/queue/entries/${ID}`;

let pipe: Awaited<ReturnType<typeof startPipeline>> | undefined;
let api: Awaited<ReturnType<Awaited<ReturnType<typeof startPipeline>>['api']>> | undefined;

afterEach(async () => {
  api?.close();
  await pipe?.stop();
  pipe = api = undefined;
});

async function start(items: FakeItem[]) {
  pipe = await startPipeline();
  api = await pipe.api();
  const film = movie({ rootId: 'movie', manualRelease: true });
  pipe.db.data.titles[film.key] = film;
  pipe.tracker.state.items = items;
  const entries = pipe.finder.requestSearch(film.key);
  expect(entries.map(({ id }) => id)).toEqual([ID]);
  return { pipeline: pipe, app: api, entry: entries[0]! };
}

const adds = () => pipe!.acquisition.filter(({ type }) => type === 'add');
const detail = async () => (await api!.get(URL)).body.entry;
const settled = () => expect.poll(async () => (await detail())?.status).toMatch(/^(stuck|no_match|downloading)$/);

it.each([
  ['text and a sample only', EXTRAS],
  ['two plausible movie files', CUTS],
  ['an empty file list', []],
] as const)('does not add a movie torrent with %s', async (_, files) => {
  const { pipeline, entry } = await start([{ title: NAME, size: SIZE, files: [...files] }]);

  await settled();

  expect(pipeline.tracker.state.downloads).toEqual([NAME]);
  expect(adds()).toEqual([]);
  expect((await detail()).status).toMatch(/^(stuck|no_match)$/);
  expect(pipeline.queue.itemFor(entry)?.entryIds).toEqual([ID]);
  expect(entry.clientId).toBeNull();
});

it('does not add a movie torrent whose piece count does not match its file size', async () => {
  const torrent = Buffer.from(makeTorrent(NAME, [FEATURE]).toString().replace('i16384e6:pieces', 'i512e6:pieces'));
  const infoHash = infoHashOf(torrent);
  expect(infoHash).toMatch(/^[a-f0-9]{40}$/);
  expect(torrentInfo(torrent).files).toEqual([{ path: `${NAME}/${FEATURE}`, sizeBytes: 1000 }]);
  expect(() => torrentInfo(torrent, true)).toThrow('invalid torrent');

  const { pipeline, entry } = await start([{ title: NAME, size: SIZE, torrent }]);
  const ref = { ...release(NAME, { infoHash }), indexerName: 'Tracker', kind: 'single' as const, manual: false };
  const result = await readSource(ref, undefined, pipeline.indexers, createClients(), AbortSignal.timeout(2_000), { torrent });
  await settled();

  expect.soft(result).toEqual({ problem: 'invalid_torrent' });
  expect(pipeline.tracker.state.downloads).toEqual([NAME]);
  expect(pipeline.qbit.calls.filter(({ path }) => path === 'torrents/add')).toEqual([]);
  expect(entry.clientId).toBeNull();
});

it('skips higher-ranked unusable movie torrents and adds only the verified feature', async () => {
  const ambiguous = 'Movie.Name.2019.1080p.BluRay-TWOCUTS';
  const sample = 'Movie.Name.2019.1080p.BluRay-SAMPLEFILES';
  const files = [...EXTRAS, FEATURE];
  const hash = hashOf(NAME, files);
  const { pipeline, entry } = await start([
    { title: NAME, size: SIZE, files, seeders: 20 },
    { title: sample, size: SIZE, files: EXTRAS, seeders: 50 },
    { title: ambiguous, size: SIZE, files: CUTS, seeders: 100 },
  ]);

  await expect.poll(async () => (await detail())?.status).toBe('downloading');

  expect(adds()).toEqual([{ type: 'add', hash }]);
  expect(pipeline.tracker.state.downloads).toEqual([ambiguous, sample, NAME]);
  expect(pipeline.tracker.state.searches).toHaveLength(1);
  expect(pipeline.queue.itemFor(entry)).toMatchObject({ entryIds: [ID], selected: {
    [hash]: { status: 'accepted', matches: { [ID]: `${NAME}/${FEATURE}` } },
  } });
});

it('checks the movie files when the user overrides a quality rejection', async () => {
  const low = 'Movie.Name.2019.720p.BluRay-LOW';
  const { pipeline, app } = await start([{ title: low, size: 100 * 60 * MIB, files: EXTRAS }]);

  await settled();
  expect(pipeline.tracker.state.downloads).toEqual([]);
  const choice = await app.post(`${URL}/releases/grab`, { indexerId: 1, guid: low });
  expect(choice).toMatchObject({ status: 202, body: { started: [ID] } });
  await expect.poll(() => pipeline.tracker.state.downloads).toEqual([low]);
  await settled();

  expect(adds()).toEqual([]);
  expect((await detail()).status).toMatch(/^(stuck|no_match)$/);
});

it('revalidates the exact movie file selected from an unsent torrent and adds it once', async () => {
  const hash = hashOf(NAME, CUTS);
  const { pipeline, app, entry } = await start([{ title: NAME, size: SIZE, files: CUTS }]);

  await settled();
  expect(adds()).toEqual([]);
  expect(await detail()).toMatchObject({ status: 'stuck', reason: { code: 'file_unmapped' } });
  pipeline.poller.stop();
  await pipeline.worker.drain();

  const manifest = await app.get(`${URL}/files?source=download`);
  expect(manifest.status).toBe(200);
  const paths = CUTS.map((file) => `${NAME}/${file}`);
  expect(manifest.body.files.map(({ rel }: { rel: string }) => rel).sort()).toEqual([...paths].sort());
  const file = paths[1]!;
  const body = { source: 'download', file, covers: [], ids: [ID] };
  const preview = await app.post(`${URL}/match`, { ...body, preview: true });
  expect(preview).toMatchObject({ status: 200, body: { file, version: expect.any(String) } });
  expect(adds()).toEqual([]);
  expect(await app.post(`${URL}/match`, { ...body, version: preview.body.version })).toMatchObject({ status: 200, body: { done: true } });
  expect(adds()).toEqual([]);

  pipeline.worker.resume();
  pipeline.poller.start();
  await expect.poll(async () => (await detail())?.status).toBe('downloading');
  expect(adds()).toEqual([{ type: 'add', hash }]);
  expect(pipeline.tracker.state.downloads).toEqual([NAME]);
  expect(pipeline.tracker.state.searches).toHaveLength(1);
  expect(pipeline.queue.itemFor(entry)).toMatchObject({ entryIds: [ID], selected: {
    [hash]: { status: 'accepted', matches: { [ID]: file } },
  } });
  expect(entry.manualMatch).toEqual({ file, covers: [] });
});
