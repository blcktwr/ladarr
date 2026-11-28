import type { QueueRejectedRelease } from '@ladarr/shared/types';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { withDefaults } from '../../src/core/db.ts';
import { enqueueSelection } from '../../src/library/grab/grab.ts';
import { infoHashOf } from '../../src/library/grab/torrent.ts';
import * as scan from '../../src/library/scan.ts';
import { episode, title } from '../helpers/test-fixtures.ts';
import { hashOf, makeTorrent, MIB, startPipeline } from '../helpers/test-pipeline.ts';

const pack = (name: string, files: string[], seeders = 20) => ({ title: name, files, size: 4 * 60 * 45 * MIB, seeders });
const first = pack('Show.Name.S01.1080p.WEB-DL-Alpha+Beta', ['Disc A/part.mkv', 'Disc B/part.mkv']);
const second = pack('Show.Name.S01.1080p.WEB-DL-Gamma', ['feature.mkv']);
const unused = pack('Show.Name.S01.1080p.WEB-DL-Other', ['unused.mkv'], 100);
const otherSeason = pack('Show.Name.S02.1080p.WEB-DL-Delta', ['other.mkv']);
const id = (n: number) => `tv:1:1x${n}`;
const base = `/queue/entries/${id(1)}/releases`;
const pathOf = (release: typeof first, index = 0) => `${release.title}/${release.files[index]}`;

let pipe: Awaited<ReturnType<typeof startPipeline>>;
let api: Awaited<ReturnType<typeof pipe.api>>;

async function rejections(season: number) {
  const { body } = await api.get(`/queue/groups/tv:1?season=${season}`);
  return (body.group.rejected as { release: QueueRejectedRelease }[]).map(({ release }) => release);
}

function selection(releases: QueueRejectedRelease[], pack: typeof first, files: { file: string; ids: string[] }[]) {
  const { indexerId, guid } = releases.find(({ title }) => title === pack.title)!;
  return { indexerId, guid, files };
}

beforeEach(async () => {
  pipe = await startPipeline();
  api = await pipe.api({ indexers: pipe.indexers });
  const series = title({ rootId: 'tv', episodes: [...[1, 2, 3, 4].map((n) => episode(1, n)), episode(2, 1)] });
  pipe.db.data.titles[series.key] = series;
  pipe.tracker.state.answer = (url) => url.searchParams.get('season') === '1' ? [first, second, unused] : [otherSeason];
  for (const season of [1, 2]) {
    pipe.finder.requestSearch(series.key, { season, fresh: true });
    await expect.poll(() => pipe.queue.findItem(series.key, season)?.state).toMatchObject({
      kind: 'blocked', problem: { code: 'file_unmapped' },
    });
  }
});

afterEach(async () => {
  api?.close();
  await pipe?.stop();
});

it('returns the manifest for the public rejection ID in its own season', async () => {
  const { indexerId, guid } = (await rejections(1)).find(({ title }) => title === first.title)!;
  expect(guid).not.toBe(first.title);
  const query = new URLSearchParams({ indexerId: String(indexerId), guid });
  const manifest = await api.get(`${base}/torrent?${query}`);
  expect(manifest).toMatchObject({
    status: 200,
    body: { hash: hashOf(first.title, first.files), files: first.files.map((_, i) => ({ path: pathOf(first, i) })) },
  });
  expect(await api.get(`/queue/entries/tv:1:2x1/releases/torrent?${query}`)).toMatchObject({
    status: 404, body: { error: 'release_not_found' },
  });
  expect(pipe.qbit.torrents.size).toBe(0);
});

it('returns the rejected mapping catalog and saved matches without selecting candidates or reading client inventory', async () => {
  await pipe.poller.pause();
  await pipe.worker.drain();
  const series = pipe.db.data.titles['tv:1']!;
  series.meta.seasons = [4, 2].map((episodeCount, i) => ({ seasonNumber: i + 1, episodeCount, airDate: '2020-01-01' }));
  series.episodes.push(episode(2, 2, '2020-01-01', { fileId: 'saved' }));
  const path = 'Show Name/Season 2/S02E02.mkv';
  const file = 'Original/part.mkv';
  pipe.db.data.files.saved = {
    id: 'saved', titleKey: series.key, path, episodes: [{ season: 2, number: 2 }], sizeBytes: 1000, mtimeMs: 1, addedAt: 1, missing: false,
    association: { source: 'manual', originalName: file, numberingRevision: 0, identity: { sizeBytes: 1000, mtimeMs: 1 } },
    download: { clientId: 'client-1', hash: hashOf('Original', ['part.mkv']), external: true },
  };
  const start = pipe.qbit.calls.length;
  using recovery = vi.spyOn(scan, 'recoverMappingSources');
  using write = vi.spyOn(pipe.db, 'write');
  const result = await api.get(`/queue/groups/${series.key}?mapping=rejected`);
  expect(result.status).toBe(200);
  expect(result.body.mapping).toMatchObject([
    ...[id(1), id(2), id(3), id(4), 'tv:1:2x1'].map((id) => ({ id, torrent: null, match: null })),
    { id: 'tv:1:2x2', match: { file, path } },
  ]);
  expect(pipe.qbit.calls.slice(start).filter(({ path }) => ['torrents/info', 'torrents/files'].includes(path))).toEqual([]);
  expect(recovery).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
});

it('downloads only the mapped torrents and imports each file for its explicit catalog episodes', async () => {
  const releases = await rejections(1);
  expect(releases.map(({ title }) => title).sort()).toEqual([first.title, second.title, unused.title].sort());
  const untouched = structuredClone(pipe.queue.findItem('tv:1', 2));
  const untouchedEpisode = structuredClone(pipe.queue.get('tv:1:2x1'));
  const result = await api.post(`${base}/map`, { torrents: [
    selection(releases, first, [{ file: pathOf(first, 1), ids: [id(1), id(2)] }, { file: pathOf(first), ids: [id(4)] }]),
    selection(releases, second, [{ file: pathOf(second), ids: [id(3)] }]),
  ] });
  expect([200, 202], JSON.stringify(result.body)).toContain(result.status);
  const adds = () => pipe.acquisition.flatMap((event) => event.type === 'add' ? [event.hash] : []).sort();
  const hashes = [first, second].map(({ title, files }) => hashOf(title, files)).sort();
  await expect.poll(adds).toEqual(hashes);

  for (const { title, files } of [first, second]) {
    pipe.complete(title, Object.fromEntries(files.map((file) => [file, file.padEnd(1000)])), hashOf(title, files));
  }
  const series = pipe.db.data.titles['tv:1']!;
  await expect.poll(() => series.episodes.filter(({ fileId }) => fileId)).toHaveLength(4);
  const records = series.episodes.slice(0, 4).map(({ fileId }) => pipe.db.data.files[fileId!]);
  expect(records[0]!.id).toBe(records[1]!.id);
  for (const [number, release, fileIndex] of [[1, first, 1], [3, second, 0], [4, first, 0]] as const) {
    expect(records[number - 1]).toMatchObject({
      association: { originalName: pathOf(release, fileIndex), source: 'manual' },
      episodes: (number === 1 ? [1, 2] : [number]).map((number) => ({ season: 1, number })),
      download: { hash: hashOf(release.title, release.files) },
    });
  }
  expect(adds()).toEqual(hashes);
  expect(pipe.queue.findItem('tv:1', 2)).toEqual(untouched);
  expect(pipe.queue.get('tv:1:2x1')).toEqual(untouchedEpisode);
});

it('starts a mapped torrent even when other episodes in the season have no assignment', async () => {
  const releases = await rejections(1);
  const hash = hashOf(second.title, second.files);
  const result = await api.post(`${base}/map`, { torrents: [
    selection(releases, second, [{ file: pathOf(second), ids: [id(3)] }]),
  ] });
  expect([200, 202], JSON.stringify(result.body)).toContain(result.status);
  await expect.poll(() => pipe.queue.get(id(3))?.state.kind).toBe('downloading');
  expect(pipe.acquisition.filter((event) => event.type === 'add')).toEqual([{ type: 'add', hash }]);
  expect([1, 2, 4].map((n) => pipe.queue.get(id(n))?.state.kind)).toEqual(['blocked', 'blocked', 'blocked']);
});

it('recovers only the mapped torrent when the saved turn also has an automatic selection', async () => {
  const automatic = pack('Show.Name.S03.1080p.WEB-DL-Auto', ['Show.Name.S03E01.mkv'], 100);
  const rejected = pack('Show.Name.S03.1080p.WEB-DL-Manual', ['part.mkv']);
  const autoHash = hashOf(automatic.title, automatic.files);
  const mappedHash = hashOf(rejected.title, rejected.files);
  const [held, mapped, blocked] = [1, 2, 3].map((n) => `tv:1:3x${n}`);
  pipe.db.data.titles['tv:1']!.episodes.push(...[1, 2, 3].map((n) => episode(3, n)));
  pipe.tracker.state.answer = () => [rejected];
  pipe.finder.requestSearch('tv:1', { season: 3, fresh: true });
  await expect.poll(() => pipe.queue.get(blocked)?.state).toMatchObject({ kind: 'blocked', problem: { code: 'file_unmapped' } });
  await pipe.poller.pause();
  await pipe.worker.drain();
  // An older version kept the automatic selection of E01 on the stopped season.
  const data = makeTorrent(automatic.title, automatic.files);
  expect(infoHashOf(data)).toBe(autoHash);
  const turn = pipe.queue.findItem('tv:1', 3)!;
  const release = {
    ...turn.search!.rejected[0]!, guid: automatic.title, title: automatic.title, infoHash: autoHash, indexerName: 'Tracker',
    kind: 'pack' as const, manual: false,
  };
  pipe.db.data.torrents[autoHash] = data.toString('base64');
  turn.selected[autoHash] = {
    hash: autoHash, release, source: { torrent: true }, numberingRevision: 0, status: 'prepared', clientId: null,
    matches: { [held!]: pathOf(automatic) },
  };
  pipe.queue.resolve(pipe.queue.get(held!)!, 'fetching', 'fixture: saved selection');
  Object.assign(pipe.queue.get(held!)!, { release, transferHash: autoHash, source: { torrent: true } });
  const result = await api.post(`/queue/entries/${mapped}/releases/map`, { torrents: [
    selection(await rejections(3), rejected, [{ file: pathOf(rejected), ids: [mapped] }]),
  ] });
  expect([200, 202], JSON.stringify(result.body)).toContain(result.status);
  expect(pipe.acquisition.filter((event) => event.type === 'add')).toEqual([]);
  const saved = JSON.stringify({ ...pipe.db.data, jobs: {} });
  await pipe.stop();

  pipe = await startPipeline();
  await pipe.worker.drain();
  const { downloadClients, indexers } = pipe.db.data;
  pipe.db.data = { ...withDefaults(JSON.parse(saved)), downloadClients, indexers };
  expect(pipe.queue.findItem('tv:1', 3)?.selected[autoHash]?.status).toBe('prepared');
  expect(pipe.queue.get(blocked)?.state.kind).toBe('blocked');
  for (const turn of Object.values(pipe.db.data.queueItems)) enqueueSelection(turn, pipe.worker.enqueue);
  const sends = Object.values(pipe.db.data.jobs).filter((job) => job.type === 'queue.send');
  expect(sends.map(({ payload }) => payload)).toMatchObject([{ hash: mappedHash, entryIds: [mapped] }]);
  pipe.worker.resume();
  await expect.poll(() => pipe.queue.get(mapped)?.state.kind).toBe('downloading');
  await pipe.worker.drain();
  expect(pipe.acquisition).toEqual([{ type: 'add', hash: mappedHash }]);
  expect(pipe.queue.get(blocked)?.state.kind).toBe('blocked');
});

it('keeps the other episode rejections after a partial mapping of a legacy season without a turn', async () => {
  await pipe.worker.drain();
  const turn = pipe.queue.findItem('tv:1', 1)!;
  const search = turn.search!;
  const sources = [first, unused, second];
  for (const entryId of turn.entryIds) {
    const entry = pipe.queue.get(entryId)!;
    const source = sources[entry.number! - 1];
    entry.search = source ? { ...search, rejected: search.rejected.filter(({ title }) => title === source.title) } : null;
  }
  delete pipe.db.data.queueItems[turn.id];
  const releases = await rejections(1);
  expect(releases.map(({ title }) => title).sort()).toEqual(sources.map(({ title }) => title).sort());
  const result = await api.post(`${base}/map`, { torrents: [
    selection(releases, second, [{ file: pathOf(second), ids: [id(2)] }]),
  ] });
  expect([200, 202], JSON.stringify(result.body)).toContain(result.status);
  pipe.worker.resume();
  await expect.poll(() => pipe.queue.get(id(2))?.state.kind).toBe('downloading');
  expect(await rejections(1)).toEqual(expect.arrayContaining(releases.filter(({ title }) => title !== second.title)));
});

it('adds each hash once and starts one attempt per mapped episode for two concurrent requests', async () => {
  const releases = await rejections(1);
  const body = { torrents: [
    selection(releases, first, [{ file: pathOf(first), ids: [id(1)] }, { file: pathOf(first, 1), ids: [id(2)] }]),
    selection(releases, second, [{ file: pathOf(second), ids: [id(3)] }]),
  ] };
  const selected = [id(1), id(2), id(3)];
  const attempts = () => selected.map((id) => pipe.queue.get(id)!.attempt);
  const before = attempts();
  const start = pipe.acquisition.length;
  const responses = await Promise.all([api.post(`${base}/map`, body), api.post(`${base}/map`, body)]);
  const statuses = responses.map(({ status }) => status).sort((a, b) => a - b);
  expect(statuses[0]).toBeGreaterThanOrEqual(200);
  expect(statuses[0]).toBeLessThan(300);
  expect(statuses[1]! < 300 || statuses[1] === 409).toBe(true);

  await expect.poll(() => selected.map((id) => pipe.queue.get(id)?.state.kind)).toEqual(selected.map(() => 'downloading'));
  for (const { title, files } of [first, second]) {
    pipe.complete(title, Object.fromEntries(files.map((file) => [file, file.padEnd(1000)])), hashOf(title, files));
  }
  await expect.poll(() => selected.map((id) => pipe.queue.get(id)?.state.kind)).toEqual(selected.map(() => 'available'));
  pipe.finder.sweep();
  await expect.poll(() => Object.values(pipe.db.data.jobs).filter((job) => job.type.startsWith('queue.') && job.state !== 'failed')).toEqual([]);

  const events = pipe.acquisition.slice(start);
  expect(events.filter((event) => event.type === 'search')).toEqual([]);
  expect(events.flatMap((event) => event.type === 'add' ? [event.hash] : []).sort()).toEqual(
    [first, second].map(({ title, files }) => hashOf(title, files)).sort(),
  );
  expect(attempts()).toEqual(before.map((attempt) => attempt + 1));
  expect(pipe.queue.get(id(4))?.state.kind).toBe('blocked');
});

it('validates the whole batch before it changes any queue entry or starts a torrent', async () => {
  await pipe.worker.drain();
  const releases = await rejections(1);
  const valid = selection(releases, first, [{ file: pathOf(first), ids: [id(1)] }, { file: pathOf(first, 1), ids: [id(2)] }]);
  const file = { file: pathOf(second), ids: [id(3), id(4)] };
  const last = selection(releases, second, [file]);
  const foreign = selection(await rejections(2), otherSeason, [{ file: pathOf(otherSeason), ids: file.ids }]);
  const queueState = () => ({ entries: pipe.db.data.queue, items: pipe.db.data.queueItems, jobs: pipe.db.data.jobs });
  const before = structuredClone(queueState());

  const cases = [
    { name: 'unknown indexer for this rejection', last: { ...last, indexerId: 99 }, statuses: [404] },
    { name: 'rejection from another season', last: foreign, statuses: [404] },
    { name: 'file from another manifest', last: { ...last, files: [{ ...file, file: pathOf(first) }] }, statuses: [400, 409] },
    { name: 'file without episode IDs', last: { ...last, files: [{ file: file.file }] }, statuses: [400] },
    { name: 'unknown catalog episode', last: { ...last, files: [{ ...file, ids: [id(99)] }] }, statuses: [400, 409] },
    { name: 'episode assigned to both torrents', last: { ...last, files: [{ ...file, ids: [id(2)] }] }, statuses: [400, 409] },
  ];
  for (const candidate of cases) {
    const result = await api.post(`${base}/map`, { torrents: [valid, candidate.last] });
    expect(candidate.statuses, `${candidate.name}: ${JSON.stringify(result.body)}`).toContain(result.status);
    expect(queueState(), candidate.name).toEqual(before);
    expect(pipe.acquisition.filter((event) => event.type === 'add'), candidate.name).toEqual([]);
  }
});
