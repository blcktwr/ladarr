import { move, branchOf, entryOf } from '../helpers/test-queue.ts';
import { stageOf, reasonOfEntry } from '../../src/library/downloads/queue.ts';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { episode, movie, title } from '../helpers/test-fixtures.ts';
import { hashOf, MIB, startPipeline, until } from '../helpers/test-pipeline.ts';

let pipe: Awaited<ReturnType<typeof startPipeline>> | undefined;
let api: Awaited<ReturnType<Awaited<ReturnType<typeof startPipeline>>['api']>> | undefined;
afterEach(async () => {
  api?.close();
  await pipe?.stop();
  pipe = api = undefined;
});

const aired = (n: number) => episode(1, n, '2020-01-0' + n);
const NAME = 'Movie.Name.2019.1080p.BluRay-GRP';
const PACK = 'Show.Name.S01.1080p.WEB-DL-GRP';

async function apply(path: string, body: object) {
  const preview = await api!.post(path, { ...body, preview: true });
  expect(preview.status).toBe(200);
  return api!.post(path, { ...preview.body, ...body });
}

// A torrent that the user added to the client by hand.
function addExternal(name: string, extra: { category?: string; tags?: string; contentPath?: string } = {}) {
  const hash = hashOf(name);
  pipe!.qbit.torrents.set(hash, {
    hash,
    name,
    size: 1_000_000,
    progress: 0.2,
    state: 'downloading',
    category: extra.category ?? 'manual',
    tags: extra.tags ?? '',
    save_path: pipe!.folders.downloads,
    content_path: extra.contentPath ?? join(pipe!.folders.downloads, name),
    dlspeed: 1000,
    eta: 100,
    num_seeds: 1,
    num_leechs: 1,
    added_on: Math.floor(Date.now() / 1000),
  });
  return hash;
}

// A movie that waits, because no indexer has a release.
async function waitingMovie() {
  pipe = await startPipeline();
  api = await pipe.api();
  const film = movie({ rootId: 'movie', manualRelease: true });
  pipe.db.data.titles[film.key] = film;
  pipe.tracker.state.items = [];
  await api.post('/queue/search', { titleKey: film.key });
  const entry = pipe.queue.get('movie:2')!;
  await until(() => branchOf(entry) === 'waiting');
  return entry;
}

// A movie that ladarr downloaded and imported.
async function importedMovie() {
  pipe = await startPipeline();
  api = await pipe.api();
  const film = movie({ rootId: 'movie', manualRelease: true });
  pipe.db.data.titles[film.key] = film;
  pipe.tracker.state.items = [{ title: NAME, size: 100 * 120 * MIB }];
  await api.post('/queue/search', { titleKey: film.key });
  const entry = pipe.queue.get('movie:2')!;
  await until(() => stageOf(entry) === 'downloading');
  pipe.complete(NAME, { 'Movie.mkv': 'the-film' });
  await until(() => stageOf(entry) === 'available');
  return entry;
}

describe('remove the torrent', () => {
  it('removes the torrent that ladarr added, keeps the data, and shows every target that uses it', async () => {
    const entry = await importedMovie();
    const hash = hashOf(NAME);
    const preview = (await api!.post('/queue/actions', { action: 'remove_torrent', ids: ['movie:2'], preview: true })).body;
    expect(preview.affected.map((a: { id: string }) => a.id)).toEqual(['movie:2']);
    expect(preview.sharedTransfers).toEqual([{ name: NAME, entries: 1 }]);
    expect(pipe!.qbit.torrents.has(hash)).toBe(true);

    expect((await api!.post('/queue/actions', { action: 'remove_torrent', ids: ['movie:2'] })).status).toBe(200);
    expect(pipe!.qbit.torrents.has(hash)).toBe(false);
    const call = pipe!.qbit.calls.filter((c) => c.path === 'torrents/delete').at(-1)!;
    expect(JSON.parse(call.body!)).toMatchObject({ hashes: hash, deleteFiles: 'false' });
    expect(entry.transferHash).toBeNull();
    expect(entry.history.at(-1)).toMatchObject({ cause: 'torrent removed from the client' });
    // The target stays available. The view says that no torrent is left.
    expect((await api!.get('/queue/entries/movie:2')).body.entry).toMatchObject({ status: 'available', hasTorrent: false });
  });

  it('refuses a torrent that a target still uses', async () => {
    pipe = await startPipeline();
    api = await pipe.api();
    const film = movie({ rootId: 'movie', manualRelease: true });
    pipe.db.data.titles[film.key] = film;
    pipe.tracker.state.items = [{ title: NAME, size: 100 * 120 * MIB }];
    await api.post('/queue/search', { titleKey: film.key });
    await until(() => stageOf(pipe!.queue.get('movie:2')!) === 'downloading');
    const refused = await api.post('/queue/actions', { action: 'remove_torrent', ids: ['movie:2'] });
    expect(refused.status).toBe(409);
    expect(refused.body.unsupported[0].reason).toContain('still uses');
    expect(pipe.qbit.torrents.has(hashOf(NAME))).toBe(true);
  });

  it('removes one pack once, and lists all its targets', async () => {
    pipe = await startPipeline();
    api = await pipe.api();
    const series = title({ rootId: 'tv', episodes: [aired(1), aired(2), aired(3)] });
    pipe.db.data.titles[series.key] = series;
    pipe.tracker.state.items = [{ title: PACK, size: 3 * 60 * 45 * MIB }];
    pipe.finder.requestSearch(series.key);
    await until(() => stageOf(pipe!.queue.get('tv:1:1x3')!) === 'downloading');
    pipe.complete(PACK, { 'Show.Name.S01E01.mkv': 'one', 'Show.Name.S01E02.mkv': 'two', 'Show.Name.S01E03.mkv': 'three' });
    await until(() => ['1x1', '1x2', '1x3'].every((n) => stageOf(pipe!.queue.get(`tv:1:${n}`)!) === 'available'));

    const preview = (await api.post('/queue/actions', { action: 'remove_torrent', ids: ['tv:1:1x2'], preview: true })).body;
    expect(preview.affected.map((a: { id: string }) => a.id).sort()).toEqual(['tv:1:1x1', 'tv:1:1x2', 'tv:1:1x3']);
    expect(preview.sharedTransfers).toEqual([{ name: PACK, entries: 3 }]);
    expect((await api.post('/queue/actions', { action: 'remove_torrent', ids: ['tv:1:1x2'] })).status).toBe(200);
    expect(pipe.qbit.calls.filter((c) => c.path === 'torrents/delete')).toHaveLength(1);
    expect(['1x1', '1x2', '1x3'].map((n) => pipe!.queue.get(`tv:1:${n}`)!.transferHash)).toEqual([null, null, null]);
  });

  it('does not fail when the client has lost the torrent already', async () => {
    await importedMovie();
    pipe!.qbit.torrents.delete(hashOf(NAME));
    expect((await api!.post('/queue/actions', { action: 'remove_torrent', ids: ['movie:2'] })).status).toBe(200);
    expect(pipe!.queue.get('movie:2')!.transferHash).toBeNull();
  });

  it('answers with an error when the client does not answer, and changes nothing', async () => {
    const entry = await importedMovie();
    pipe!.qbit.control.down = true;
    const res = await api!.post('/queue/actions', { action: 'remove_torrent', ids: ['movie:2'] });
    expect(res.status).toBe(502);
    expect(entry.transferHash).toBe(hashOf(NAME));
  });
});

describe('attach a download', () => {
  it('lists the torrents with or without a tag and the targets that can share the download', async () => {
    pipe = await startPipeline();
    api = await pipe.api();
    const series = title({ rootId: 'tv', episodes: [aired(1), aired(2)] });
    pipe.db.data.titles[series.key] = series;
    pipe.finder.requestSearch(series.key);
    await until(() => branchOf(pipe!.queue.get('tv:1:1x1')) === 'waiting' && branchOf(pipe!.queue.get('tv:1:1x2')) === 'waiting');
    addExternal(PACK);
    addExternal('Other.Show.S02.1080p', { category: '' });
    addExternal('Third.Torrent');

    const all = (await api.get('/queue/entries/tv:1:1x1/external')).body;
    expect(all.total).toBe(3);
    expect(all.siblings).toEqual([{ id: 'tv:1:1x2', label: 'Show Name S01E02' }]);
    expect(all.torrents.find((t: { name: string }) => t.name === PACK)).toMatchObject({ category: 'manual', hash: hashOf(PACK) });
    expect((await api.get('/queue/entries/tv:1:1x1/external?q=other.show')).body.torrents.map((t: { name: string }) => t.name)).toEqual(['Other.Show.S02.1080p']);
  });

  it('needs both confirmations, previews every target, and then attaches one pack to several episodes', async () => {
    pipe = await startPipeline();
    api = await pipe.api();
    const series = title({ rootId: 'tv', episodes: [aired(1), aired(2)] });
    pipe.db.data.titles[series.key] = series;
    pipe.finder.requestSearch(series.key);
    await until(() => branchOf(pipe!.queue.get('tv:1:1x1')) === 'waiting' && branchOf(pipe!.queue.get('tv:1:1x2')) === 'waiting');
    const hash = addExternal(PACK);
    pipe.qbit.setFiles(hash, [
      { name: `${PACK}/Show.Name.S01E01.mkv`, size: 1_000, progress: 0.2 },
      { name: `${PACK}/Show.Name.S01E02.mkv`, size: 1_000, progress: 0.2 },
    ]);
    const first = pipe.queue.get('tv:1:1x1')!;

    const body = { hash, ids: ['tv:1:1x2'] };
    expect((await api.post('/queue/entries/tv:1:1x1/attach', body)).body.error).toBe('confirmation_required');
    expect((await api.post('/queue/entries/tv:1:1x1/attach', { ...body, confirmOwner: true })).body.error).toBe('confirmation_required');
    expect((await api.post('/queue/entries/tv:1:1x1/attach', { ...body, confirmTitle: true })).body.error).toBe('confirmation_required');
    expect(first.transferHash).toBeNull();

    const preview = (await api.post('/queue/entries/tv:1:1x1/attach', { ...body, preview: true })).body;
    expect(preview).toMatchObject({ hash, name: PACK, affected: [{ id: 'tv:1:1x1', label: 'Show Name S01E01' }, { id: 'tv:1:1x2', label: 'Show Name S01E02' }], blocked: [] });
    expect(preview.version).toEqual(expect.any(String));
    expect(first.transferHash).toBeNull();

    expect((await api.post('/queue/entries/tv:1:1x1/attach', { ...preview, ...body, confirmOwner: true, confirmTitle: true })).status).toBe(200);
    for (const id of ['tv:1:1x1', 'tv:1:1x2']) {
      const entry = pipe.queue.get(id)!;
      expect(entry).toMatchObject({ state: { kind: 'downloading' }, transferHash: hash, release: { external: true, manual: true, kind: 'pack', title: PACK } });
      expect(entry.attempts.map((a) => [a.reason, a.outcome])).toEqual([['search requested', 'cancelled'], ['attached download', 'running']]);
    }
    const view = (await api.get('/queue/entries/tv:1:1x1')).body.entry;
    expect(view).toMatchObject({ hasTorrent: true, attached: true, status: 'downloading' });
    // The poller follows the torrent in the other category, and does not flag it as missing.
    await until(() => pipe!.poller.transfer(hash)?.entryIds.length === 2);
    expect(branchOf(first)).toBeNull();
  });

  it('imports the files of an attached download, and never removes that torrent', async () => {
    const entry = await waitingMovie();
    const hash = addExternal(NAME);
    const before = pipe!.qbit.calls.length;
    expect((await apply('/queue/entries/movie:2/attach', { hash, confirmOwner: true, confirmTitle: true })).status).toBe(200);
    // The attach only reads the client. It adds no tag and no category.
    expect(pipe!.qbit.calls.slice(before).filter((call) => /add|delete|stop|start|pause|resume|Tags|Category/.test(call.path))).toEqual([]);
    expect(pipe!.qbit.torrents.get(hash)).toMatchObject({ tags: '', category: 'manual' });
    await until(() => stageOf(entry) === 'downloading' && pipe!.poller.transfer(hash) !== undefined);
    pipe!.complete(NAME, { 'Movie.mkv': 'the-film' });
    await until(() => stageOf(entry) === 'available');
    expect(Object.values(pipe!.db.data.files)).toHaveLength(1);

    // An attached torrent stays in the client.
    const refused = await api!.post('/queue/actions', { action: 'remove_torrent', ids: ['movie:2'] });
    expect(refused.status).toBe(409);
    expect(refused.body.unsupported[0].reason).toContain('not added');
    expect(pipe!.qbit.torrents.has(hash)).toBe(true);
  });

  it('starts the import at once for a download that is complete', async () => {
    const entry = await waitingMovie();
    const hash = addExternal(NAME);
    pipe!.complete(NAME, { 'Movie.mkv': 'the-film' });
    expect((await apply('/queue/entries/movie:2/attach', { hash, confirmOwner: true, confirmTitle: true })).status).toBe(200);
    expect(entry.history.at(-1)).toMatchObject({ stage: 'importing', cause: 'download attached by the user' });
    await until(() => stageOf(entry) === 'available');
  });

  it('refuses a torrent in the wrong state, one that the client does not have, or one in use by another title', async () => {
    const entry = await waitingMovie();
    const free = addExternal('Free.Torrent.One');
    const post = (hash: string, extra = {}) => api!.post('/queue/entries/movie:2/attach', { hash, confirmOwner: true, confirmTitle: true, ...extra });
    expect((await post('not-a-hash')).status).toBe(400);
    expect((await post('0'.repeat(40))).body.error).toBe('torrent_not_found');
    expect((await post(hashOf(NAME), { ids: ['movie:99'] })).status).toBe(400);
    expect((await api!.post('/queue/entries/movie:99/attach', { hash: free })).status).toBe(404);

    // Another title works with this torrent now.
    const hash = addExternal(NAME);
    const other = movie({ key: 'movie:3', tmdbId: 3, rootId: 'movie', manualRelease: true });
    pipe!.db.data.titles[other.key] = other;
    const busy = pipe!.queue.request(pipe!.queue.ensure(other.key, null, null), 'test');
    expect(busy).toBe(true);
    pipe!.queue.get('movie:3')!.transferHash = hash;
    expect((await post(hash)).body.error).toBe('torrent_in_use');
    expect((await api!.get('/queue/entries/movie:2/external')).body.torrents.some((t: { hash: string }) => t.hash === hash)).toBe(false);

    // A target that downloads now takes no attach.
    entry.release = null;
    move(pipe!.queue, entry, { stage: 'downloading', branch: null, reason: null }, 'test');
    const wrongState = await post(addExternal('Free.Torrent'));
    expect(wrongState.status).toBe(409);
    expect(wrongState.body.unsupported[0].reason).toContain('not waiting');
    expect((await api!.get('/queue/entries/movie:2/external')).status).toBe(409);
  });

  it('takes a finished torrent that was in the client already', async () => {
    pipe = await startPipeline();
    api = await pipe.api();
    const film = movie({ rootId: 'movie', manualRelease: true });
    pipe.db.data.titles[film.key] = film;
    pipe.tracker.state.items = [{ title: NAME, size: 100 * 120 * MIB }];
    // The user added this torrent by hand, and the client finished it before ladarr found the release.
    const hash = addExternal(NAME, { category: 'manual' });
    pipe.complete(NAME, { 'Movie.mkv': 'the-film' });
    await api.post('/queue/search', { titleKey: film.key });
    const entry = pipe.queue.get('movie:2')!;
    // The grab uses the files of the torrent, which stays the user's: a removal never deletes it.
    await until(() => stageOf(entry) === 'available');
    expect(entry.release?.external).toBe(true);
    expect(pipe.db.data.sentTorrents[hash]).toBeUndefined();
  });

  it('retries a target that stopped on the torrent that the client finished', async () => {
    pipe = await startPipeline();
    api = await pipe.api();
    const film = movie({ rootId: 'movie', manualRelease: true });
    pipe.db.data.titles[film.key] = film;
    pipe.tracker.state.items = [{ title: NAME, size: 100 * 120 * MIB }];
    // The user added the torrent by hand while it downloaded. The search keeps it as the download of the target.
    addExternal(NAME, { category: 'manual' });
    await api.post('/queue/search', { titleKey: film.key });
    const entry = pipe.queue.get('movie:2')!;
    await until(() => stageOf(entry) === 'downloading' && entry.transferHash === hashOf(NAME));
    // A problem stops the target at its download. The user retries it when the client has finished.
    pipe.complete(NAME, { 'Movie.mkv': 'the-film' });
    move(pipe.queue, entry, { stage: 'downloading', reason: { code: 'client_error' } }, 'test');
    expect((await api.post('/queue/actions', { action: 'retry', ids: ['movie:2'] })).status).toBe(200);
    await until(() => stageOf(entry) === 'available');
    // The torrent of the client is the one that the import used. The client holds no other.
    expect(pipe.qbit.torrents.size).toBe(1);
    expect(entry.transferHash).toBe(hashOf(NAME));
  });

  it('offers the torrent that was in the client already when a grab stopped', async () => {
    pipe = await startPipeline();
    api = await pipe.api();
    const film = movie({ rootId: 'movie', manualRelease: true });
    pipe.db.data.titles[film.key] = film;
    pipe.tracker.state.items = [{ title: NAME, size: 100 * 120 * MIB }];
    // The user added this torrent by hand, in another category, before ladarr found the release.
    addExternal(NAME, { category: 'manual' });
    await api.post('/queue/search', { titleKey: film.key });
    const entry = pipe.queue.get('movie:2')!;
    await until(() => stageOf(entry) === 'downloading');
    // A grab that stopped before it took the torrent keeps the offer to attach it.
    entry.transferHash = null;
    entry.clientId = null;
    entry.source = null;
    move(pipe.queue, entry, { stage: 'fetching', reason: { code: 'torrent_exists' } }, 'test');
    expect(reasonOfEntry(entry)?.code).toBe('torrent_exists');
    expect((await api.get('/queue/entries/movie:2')).body.entry.reason).toMatchObject({ action: 'attach' });
    expect((await apply('/queue/entries/movie:2/attach', { hash: hashOf(NAME), confirmOwner: true, confirmTitle: true })).status).toBe(200);
    expect(entry.state).toEqual({ kind: 'downloading' });
    pipe.complete(NAME, { 'Movie.mkv': 'the-film' });
    await until(() => stageOf(entry) === 'available');
  });

  it('takes over a torrent that ladarr sent, after the target that sent it is gone', async () => {
    pipe = await startPipeline();
    api = await pipe.api();
    const film = movie({ rootId: 'movie', manualRelease: true });
    pipe.db.data.titles[film.key] = film;
    pipe.tracker.state.items = [{ title: NAME, size: 100 * 120 * MIB }];
    await api.post('/queue/search', { titleKey: film.key });
    const hash = hashOf(NAME);
    await until(() => stageOf(pipe!.queue.get('movie:2')) === 'downloading');
    // The target leaves the queue. The torrent stays in the client, because ladarr added it.
    delete pipe.db.data.queue['movie:2'];
    pipe.finder.requestSearch(film.key);
    const entry = pipe.queue.get('movie:2')!;
    await until(() => stageOf(entry) === 'downloading' && reasonOfEntry(entry) === null);
    expect(entry).toMatchObject({ state: { kind: 'downloading' }, transferHash: hash });
  });

  it('takes over a torrent that ladarr sent before the record of the sent torrents', async () => {
    pipe = await startPipeline();
    api = await pipe.api();
    const film = movie({ rootId: 'movie', manualRelease: true });
    pipe.db.data.titles[film.key] = film;
    pipe.tracker.state.items = [{ title: NAME, size: 100 * 120 * MIB }];
    await api.post('/queue/search', { titleKey: film.key });
    const entry = pipe.queue.get('movie:2')!;
    await until(() => stageOf(entry) === 'downloading');
    // A file from an older version has no record. The history of the target says what it sent.
    delete pipe.db.data.sentTorrents[hashOf(NAME)];
    move(pipe.queue, entry, { branch: 'cancelled' }, 'cancelled by the user');
    pipe.finder.requestSearch(film.key);
    await until(() => stageOf(entry) === 'downloading' && branchOf(entry) === null && reasonOfEntry(entry) === null);
    expect(entry.transferHash).toBe(hashOf(NAME));
  });

  it('leaves a sibling that waits on the same torrent in Sending when only one episode is attached', async () => {
    pipe = await startPipeline();
    api = await pipe.api();
    const series = title({ rootId: 'tv', episodes: [aired(1), aired(2)] });
    pipe.db.data.titles[series.key] = series;
    pipe.tracker.state.items = [{ title: PACK, size: 2 * 60 * 45 * MIB }];
    // The user added the pack by hand in another category. The search finds it, and both episodes point at it.
    const hash = addExternal(PACK);
    pipe.qbit.setFiles(hash, [
      { name: `${PACK}/Show.Name.S01E01.mkv`, size: 1_000, progress: 0.2 },
      { name: `${PACK}/Show.Name.S01E02.mkv`, size: 1_000, progress: 0.2 },
    ]);
    pipe.finder.requestSearch(series.key);
    const [one, two] = ['tv:1:1x1', 'tv:1:1x2'].map((id) => pipe!.queue.get(id)!);
    await until(() => stageOf(one!) === 'downloading' && stageOf(two!) === 'downloading');
    // A grab that stopped before it took the torrent. The user attaches one episode only.
    for (const entry of [one!, two!]) {
      entry.transferHash = null;
      entry.clientId = null;
      entry.source = null;
      move(pipe!.queue, entry, { stage: 'fetching', reason: { code: 'torrent_exists' } }, 'test');
    }
    expect((await apply('/queue/entries/tv:1:1x1/attach', { hash, confirmOwner: true, confirmTitle: true })).status).toBe(200);
    await until(() => pipe!.poller.transfer(hash)?.entryIds.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(pipe.queue.get('tv:1:1x1')!.state).toEqual({ kind: 'downloading' });
    expect(pipe.queue.get('tv:1:1x2')!.state).toEqual({ kind: 'blocked', at: 'fetching', problem: { code: 'torrent_exists' } });
    expect(pipe.poller.transfer(hash)!.entryIds).toEqual(['tv:1:1x1']);
  });

  it('checks the targets again after the client answers, and refuses a target that changed in that time', async () => {
    const entry = await waitingMovie();
    const hash = addExternal(NAME);
    const body = { hash, confirmOwner: true, confirmTitle: true };
    const preview = await api!.post('/queue/entries/movie:2/attach', { ...body, preview: true });
    expect(preview.status).toBe(200);
    // The client answers slowly. The user cancels the target while the attach waits.
    pipe!.qbit.control.delayInfoMs = 300;
    const attaching = api!.post('/queue/entries/movie:2/attach', { ...preview.body, ...body });
    await new Promise((resolve) => setTimeout(resolve, 100));
    move(pipe!.queue, entry, { branch: 'cancelled', reason: null }, 'cancelled by the user');
    const result = await attaching;
    expect(result.status).toBe(409);
    expect(result.body.error).toBe('preview_changed');
    expect(entry).toMatchObject({ state: { kind: 'cancelled' }, transferHash: null });
  });

  it('follows a torrent that the user moved to another category', async () => {
    pipe = await startPipeline();
    api = await pipe.api();
    const film = movie({ rootId: 'movie', manualRelease: true });
    pipe.db.data.titles[film.key] = film;
    pipe.tracker.state.items = [{ title: NAME, size: 100 * 120 * MIB }];
    await api.post('/queue/search', { titleKey: film.key });
    const entry = pipe.queue.get('movie:2')!;
    await until(() => stageOf(entry) === 'downloading');
    pipe.qbit.torrents.get(hashOf(NAME))!.category = 'moved';
    pipe.qbit.progress(hashOf(NAME), 0.5);
    await until(() => pipe!.poller.transfer(hashOf(NAME))?.progress === 0.5);
    expect(branchOf(entry)).toBeNull();
  });
});

describe('client details', () => {
  async function downloading() {
    pipe = await startPipeline();
    api = await pipe.api();
    const film = movie({ rootId: 'movie', manualRelease: true });
    pipe.db.data.titles[film.key] = film;
    pipe.tracker.state.items = [{ title: NAME, size: 100 * 120 * MIB }];
    await api.post('/queue/search', { titleKey: film.key });
    await until(() => stageOf(pipe!.queue.get('movie:2')!) === 'downloading');
    return hashOf(NAME);
  }

  it('reports the tracker, the queue place and the limits that the client gives, and no key', async () => {
    const hash = await downloading();
    const torrent = pipe!.qbit.torrents.get(hash)!;
    Object.assign(torrent, { state: 'queuedDL', priority: 2, tracker: 'https://tracker.example/announce/0123456789abcdef0123456789abcdef', num_complete: 9, num_incomplete: 3, availability: 0.5 });
    pipe!.qbit.trackers.set(hash, [{ url: 'https://tracker.example/announce/0123456789abcdef0123456789abcdef', status: 2, tier: 0, num_peers: 4, num_seeds: 9, num_leeches: 3, num_downloaded: 10, msg: 'ok' }]);
    const res = await api!.get('/queue/entries/movie:2/client');
    expect(res.status).toBe(200);
    expect(res.body.detail).toMatchObject({
      state: 'queuedDL',
      tracker: 'tracker.example',
      trackers: [{ host: 'tracker.example', status: 'working', tier: 0, message: 'ok', seeds: 9, peers: 4, downloaded: 10 }],
      swarm: { seeds: 9, peers: 3 },
      availability: 0.5,
      queue: { waiting: true, position: 2 },
      slots: { queueing: true, maxActiveDownloads: 3, maxActiveTorrents: 5, maxActiveUploads: 3 },
    });
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('0123456789abcdef');
    expect(text).not.toContain('must-not-leave');
  });

  it('keeps what the client does not report unknown, and asks the client once for several reads', async () => {
    const hash = await downloading();
    const before = pipe!.qbit.calls.filter((c) => c.path === 'torrents/trackers').length;
    const first = await api!.get('/queue/entries/movie:2/client');
    await api!.get('/queue/entries/movie:2/client');
    expect(pipe!.qbit.calls.filter((c) => c.path === 'torrents/trackers').length - before).toBe(1);
    expect(first.body.detail).toMatchObject({ tracker: null, swarm: { seeds: null, peers: null }, availability: null, queue: { waiting: false, position: null } });
    pipe!.qbit.torrents.delete(hash);
  });

  it('answers 404 for a torrent the client lost, and 502 when the client is down', async () => {
    const hash = await downloading();
    expect((await api!.get('/queue/entries/movie:99/client')).status).toBe(404);
    pipe!.qbit.control.down = true;
    expect((await api!.get('/queue/entries/movie:2/client')).status).toBe(502);
    pipe!.qbit.control.down = false;
    await new Promise((resolve) => setTimeout(resolve, 5_100));
    pipe!.qbit.torrents.delete(hash);
    const gone = await api!.get('/queue/entries/movie:2/client');
    expect(gone.status).toBe(404);
    expect(gone.body.error).toBe('torrent_not_found');
  }, 15_000);
});

describe('match a file that covers several episodes', () => {
  async function blockedPack() {
    pipe = await startPipeline();
    api = await pipe.api();
    const series = title({ rootId: 'tv', episodes: [aired(1), aired(2), aired(3)] });
    pipe.db.data.titles[series.key] = series;
    pipe.tracker.state.items = [{ title: PACK, size: 3 * 60 * 45 * MIB }];
    pipe.finder.requestSearch(series.key);
    await until(() => stageOf(pipe!.queue.get('tv:1:1x3')!) === 'downloading');
    // The names of the files give no episode numbers, so ladarr can not pick.
    pipe.complete(PACK, { 'part-a.mkv': 'first-and-second', 'part-b.mkv': 'third-file' });
    await until(() => ['1x1', '1x2', '1x3'].every((n) => reasonOfEntry(pipe!.queue.get(`tv:1:${n}`)!)?.code === 'file_unmapped'));
  }

  it('previews each association before it changes, and imports one file for two episodes', async () => {
    await blockedPack();
    const files = (await api!.get('/queue/entries/tv:1:1x1/files')).body;
    expect(files.entries.map((e: { id: string }) => e.id).sort()).toEqual(['tv:1:1x1', 'tv:1:1x2', 'tv:1:1x3']);

    const body = { file: 'part-a.mkv', covers: [{ season: 1, number: 1 }, { season: 1, number: 2 }], ids: ['tv:1:1x1', 'tv:1:1x2'] };
    const preview = (await api!.post('/queue/entries/tv:1:1x1/match', { ...body, preview: true })).body;
    expect(preview).toMatchObject({
      file: 'part-a.mkv',
      affected: [
        { id: 'tv:1:1x1', label: 'Show Name S01E01', current: null },
        { id: 'tv:1:1x2', label: 'Show Name S01E02', current: null },
      ],
      replaces: [],
      retries: [
        { id: 'tv:1:1x1', label: 'Show Name S01E01' },
        { id: 'tv:1:1x2', label: 'Show Name S01E02' },
      ],
    });
    expect(pipe!.queue.get('tv:1:1x1')!.manualMatch).toBeNull();

    expect((await api!.post('/queue/entries/tv:1:1x1/match', { ...preview, ...body })).status).toBe(200);
    await until(() => ['1x1', '1x2'].every((n) => stageOf(pipe!.queue.get(`tv:1:${n}`)!) === 'available'));
    // One file holds both episodes, and the third episode still waits for its own file.
    const files2 = Object.values(pipe!.db.data.files);
    expect(files2).toHaveLength(1);
    expect(files2[0]!.path).toBe('Show Name (2020)/Season 01/Show Name - S01E01E02.mkv');
    expect(files2[0]!.episodes.map((e) => e.number)).toEqual([1, 2]);
    expect(reasonOfEntry(pipe!.queue.get('tv:1:1x3')!)?.code).toBe('file_unmapped');

    expect((await apply('/queue/entries/tv:1:1x3/match', { file: 'part-b.mkv', ids: ['tv:1:1x3'] })).status).toBe(200);
    await until(() => stageOf(pipe!.queue.get('tv:1:1x3')!) === 'available');
    expect(Object.values(pipe!.db.data.files)).toHaveLength(2);
  });

  it('shows the targets that lose a file and the file that each target has now', async () => {
    await blockedPack();
    const second = pipe!.queue.get('tv:1:1x2')!;
    const third = pipe!.queue.get('tv:1:1x3')!;
    second.manualMatch = { file: 'part-a.mkv', covers: [{ season: 1, number: 2 }] };
    third.manualMatch = { file: 'part-b.mkv', covers: [{ season: 1, number: 3 }] };
    const body = { file: 'part-a.mkv', covers: [{ season: 1, number: 1 }, { season: 1, number: 3 }], ids: ['tv:1:1x1', 'tv:1:1x3'] };
    const preview = (await api!.post('/queue/entries/tv:1:1x1/match', { ...body, preview: true })).body;
    expect(preview.affected).toEqual([
      { id: 'tv:1:1x1', label: 'Show Name S01E01', current: null },
      { id: 'tv:1:1x3', label: 'Show Name S01E03', current: 'part-b.mkv' },
    ]);
    expect(preview.replaces).toEqual([{ id: 'tv:1:1x2', label: 'Show Name S01E02' }]);
    // The preview changed nothing. The apply takes the file from the target that loses it.
    expect(second.manualMatch).not.toBeNull();
    expect((await api!.post('/queue/entries/tv:1:1x1/match', { ...preview, ...body })).status).toBe(200);
    expect(second.manualMatch).toBeNull();
    expect(third.manualMatch).toMatchObject({ file: 'part-a.mkv' });
  });

  it('refuses a cover that the download does not hold, and a file that is not in the download', async () => {
    await blockedPack();
    const post = (body: object) => api!.post('/queue/entries/tv:1:1x1/match', body);
    expect((await post({ file: 'part-a.mkv', covers: [{ season: 1, number: 9 }] })).body.error).toBe('cover_not_in_download');
    expect((await post({ file: 'part-a.mkv', covers: [{ season: 1, number: 1 }, { season: 2, number: 1 }] })).body.error).toBe('cover_not_in_download');
    expect((await post({ file: 'missing.mkv', covers: [{ season: 1, number: 1 }] })).body.error).toBe('file_not_in_download');
    expect((await post({ file: 'part-a.mkv', covers: 'x' })).status).toBe(400);
    expect(pipe!.queue.get('tv:1:1x1')!.manualMatch).toBeNull();
  });
});

describe('catalog-wide download mapping', () => {
  async function source() {
    pipe = await startPipeline();
    await pipe.worker.pause();
    pipe.poller.stop();
    api = await pipe.api();
    const series = title({
      rootId: 'tv',
      episodes: [aired(1), episode(1, 2, '2020-01-02', { fileId: 'existing' }), episode(2, 1)],
    });
    pipe.db.data.titles[series.key] = series;
    pipe.db.data.files.existing = {
      id: 'existing', titleKey: series.key, path: 'Show Name (2020)/Season 01/Show Name - S01E02.mkv',
      episodes: [{ season: 1, number: 2 }], sizeBytes: 4, mtimeMs: 0, missing: false, addedAt: 0,
    };
    const hash = addExternal(PACK);
    pipe.complete(PACK, { 'part-a.mkv': 'first-video', 'part-b.mkv': 'second-video' });
    const selected = entryOf({
      id: 'tv:1:1x1', titleKey: series.key, season: 1, number: 1,
      stage: 'importing', reason: { code: 'file_not_found' }, transferHash: hash, clientId: 'client-1',
    });
    const sibling = entryOf({
      id: 'tv:1:2x1', titleKey: series.key, season: 2, number: 1,
      stage: 'importing', reason: { code: 'file_not_found' }, transferHash: hash, clientId: 'client-1',
    });
    pipe.db.data.queue[selected.id] = selected;
    pipe.db.data.queue[sibling.id] = sibling;
    return { selected, sibling, series };
  }

  async function librarySource() {
    const context = await source();
    context.series.folder = 'Show Name (2020)';
    const path = 'Show Name (2020)/Library clip.mkv';
    mkdirSync(join(pipe!.folders.tv, context.series.folder), { recursive: true });
    writeFileSync(join(pipe!.folders.tv, path), 'library-video');
    pipe!.db.data.files.local = {
      id: 'local', titleKey: context.series.key, path, episodes: [], sizeBytes: 13, mtimeMs: 0, missing: false, addedAt: 0,
    };
    return { ...context, path };
  }

  it('requires a preview before a source association changes and changes no data', async () => {
    const { selected } = await source();
    const before = structuredClone({ files: pipe!.db.data.files, queue: pipe!.db.data.queue, jobs: pipe!.db.data.jobs, imports: pipe!.db.data.imports });

    const applied = await api!.post(`/queue/entries/${selected.id}/match`, {
      file: 'part-a.mkv', covers: [{ season: 1, number: 1 }], ids: [selected.id],
    });

    expect(applied.status).toBe(409);
    expect(applied.body.error).toBe('preview_required');
    expect({ files: pipe!.db.data.files, queue: pipe!.db.data.queue, jobs: pipe!.db.data.jobs, imports: pipe!.db.data.imports }).toEqual(before);
  });

  it('lists library alternatives for a target that still has a torrent', async () => {
    const { selected, path } = await librarySource();
    pipe!.qbit.control.down = true;

    const listing = await api!.get(`/queue/entries/${selected.id}/files?source=library`);

    expect(listing.status).toBe(200);
    expect(listing.body.source).toBe('library');
    expect(listing.body.sources).toEqual(expect.arrayContaining(['download', 'library']));
    expect(listing.body.files.map((file: { rel: string }) => file.rel)).toEqual([path]);
    expect(listing.body.entries.map((entry: { id: string }) => entry.id)).toEqual(['tv:1:1x1', 'tv:1:1x2', 'tv:1:2x1']);
  });

  it.each([
    { name: 'no download provenance', download: null },
    { name: 'its original download provenance', download: { clientId: 'client-1', hash: hashOf('Original.Library.Source'), external: true } },
  ])('uses an explicit library source with $name without importing the old torrent or resolving its siblings', async ({ download }) => {
    const { selected, sibling, path } = await librarySource();
    pipe!.db.data.files.local!.download = structuredClone(download);
    const siblingBefore = structuredClone(sibling);
    const hash = selected.transferHash;
    pipe!.qbit.control.down = true;
    const body = { source: 'library', file: path, covers: [{ season: 1, number: 1 }], ids: [selected.id] };
    const preview = await api!.post(`/queue/entries/${selected.id}/match`, { ...body, preview: true });
    expect(preview.status).toBe(200);
    expect(selected.state.kind).toBe('blocked');
    expect(selected.manualMatch).toBeNull();

    const applied = await api!.post(`/queue/entries/${selected.id}/match`, { ...preview.body, ...body });

    expect(applied.status).toBe(200);
    expect(selected.state).toEqual({ kind: 'importing' });
    expect(selected.manualMatch).toMatchObject({ file: path, covers: body.covers });
    expect(selected.transferHash).toBe(hash);
    expect(sibling).toEqual(siblingBefore);
    expect(Object.values(pipe!.db.data.jobs).some((job) => job.type === 'import.run' && (job.payload as { hash?: string })?.hash === hash)).toBe(false);
    pipe!.worker.resume();
    await until(() => selected.state.kind === 'available');
    const file = Object.values(pipe!.db.data.files).find((record) => record.path === path)!;
    expect(file.download ?? null).toEqual(download);
    expect(file.download?.hash).not.toBe(hash);
    expect(sibling).toEqual(siblingBefore);
    expect(pipe!.tracker.state.searches).toEqual([]);
    expect(pipe!.tracker.state.downloads).toEqual([]);
  });

  it('offers an explicit library source for an existing destination file', async () => {
    const { selected } = await librarySource();
    selected.state = { kind: 'blocked', at: 'importing', problem: { code: 'destination_exists' } };

    const detail = await api!.get(`/queue/entries/${selected.id}`);

    expect(detail.status).toBe(200);
    expect(detail.body.entry.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'use_existing', label: 'Use existing file', fileSource: 'library', ids: [selected.id] }),
      expect.objectContaining({ action: 'replace', label: 'Replace file', ids: [selected.id] }),
    ]));
    expect(selected.state.kind).toBe('blocked');
  });

  it('unassigns a download file with empty coverage without authorizing any target', async () => {
    const { selected, sibling } = await source();
    selected.manualMatch = { file: 'part-a.mkv', covers: [{ season: 1, number: 1 }] };
    sibling.manualMatch = { file: 'part-b.mkv', covers: [{ season: 2, number: 1 }] };
    const siblingBefore = structuredClone(sibling);
    const state = structuredClone(selected.state);
    const jobs = structuredClone(pipe!.db.data.jobs);
    const body = { file: 'part-a.mkv', covers: [], ids: [] };
    const preview = await api!.post(`/queue/entries/${selected.id}/match`, { ...body, preview: true });
    expect(preview.status).toBe(200);
    expect(preview.body.retries).toEqual([]);
    expect(selected.manualMatch).not.toBeNull();

    const applied = await api!.post(`/queue/entries/${selected.id}/match`, { ...preview.body, ...body });

    expect(applied.status).toBe(200);
    expect(selected.manualMatch?.covers ?? []).toEqual([]);
    expect(selected.state).toEqual(state);
    expect(sibling).toEqual(siblingBefore);
    expect(pipe!.db.data.jobs).toEqual(jobs);
  });

  it('previews lost availability and continuation separately from file coverage', async () => {
    const { selected, sibling } = await source();
    const available = entryOf({ id: 'tv:1:1x2', titleKey: selected.titleKey, season: 1, number: 2, stage: 'available', transferHash: selected.transferHash, clientId: selected.clientId });
    pipe!.db.data.queue[available.id] = available;
    const file = pipe!.db.data.files.existing!;
    file.download = { hash: selected.transferHash!, clientId: selected.clientId!, external: true };
    file.association = { source: 'manual', originalName: 'part-a.mkv', numberingRevision: 0, identity: { sizeBytes: file.sizeBytes, mtimeMs: file.mtimeMs } };
    const before = structuredClone({ files: pipe!.db.data.files, queue: pipe!.db.data.queue, titles: pipe!.db.data.titles, jobs: pipe!.db.data.jobs });

    const preview = await api!.post(`/queue/entries/${selected.id}/match`, {
      file: 'part-a.mkv', covers: [{ season: 1, number: 1 }], ids: [selected.id], preview: true,
    });

    expect(preview.status).toBe(200);
    expect(preview.body.replaces).toEqual(expect.arrayContaining([expect.objectContaining({ id: available.id })]));
    expect(preview.body.effects).toMatchObject({
      lostAvailability: [{ season: 1, number: 2 }],
      continued: [{ id: selected.id, phase: 'importing' }],
      conflicts: [],
    });
    expect(preview.body.effects.staysBlocked).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: sibling.id }),
      expect.objectContaining({ id: available.id, code: 'file_unmapped' }),
    ]));
    expect({ files: pipe!.db.data.files, queue: pipe!.db.data.queue, titles: pipe!.db.data.titles, jobs: pipe!.db.data.jobs }).toEqual(before);
  });

  it('lists every catalog episode, including available episodes without queue entries', async () => {
    await source();

    const listing = await api!.get('/queue/entries/tv:1:1x1/files');

    expect(listing.status).toBe(200);
    expect(listing.body.entries.map((entry: { season: number; number: number }) => [entry.season, entry.number])).toEqual([[1, 1], [1, 2], [2, 1]]);
    expect(listing.body.entries.find((entry: { season: number; number: number }) => entry.season === 1 && entry.number === 2)).toMatchObject({
      id: 'tv:1:1x2', season: 1, number: 2,
    });
    expect(pipe!.queue.get('tv:1:1x2')).toBeUndefined();
  });

  it('previews coverage of an available episode outside the source queue', async () => {
    const { selected, series } = await source();
    const before = structuredClone({ files: pipe!.db.data.files, queue: pipe!.db.data.queue, episodes: series.episodes });

    const preview = await api!.post(`/queue/entries/${selected.id}/match`, {
      file: 'part-a.mkv', covers: [{ season: 1, number: 1 }, { season: 1, number: 2 }], preview: true,
    });

    expect(preview.status).toBe(200);
    expect(preview.body.affected.map((entry: { id: string }) => entry.id)).toEqual(['tv:1:1x1', 'tv:1:1x2']);
    expect({ files: pipe!.db.data.files, queue: pipe!.db.data.queue, episodes: series.episodes }).toEqual(before);
  });

  it('applies catalog coverage without authorizing an available catalog target', async () => {
    const { selected, sibling, series } = await source();
    const siblingBefore = structuredClone(sibling);
    const body = {
      file: 'part-a.mkv', covers: [{ season: 1, number: 1 }, { season: 1, number: 2 }], ids: [selected.id],
    };
    const preview = await api!.post(`/queue/entries/${selected.id}/match`, { ...body, preview: true });
    expect(preview.status).toBe(200);

    const applied = await api!.post(`/queue/entries/${selected.id}/match`, { ...preview.body, ...body });

    expect(applied.status).toBe(200);
    expect(selected.manualMatch).toEqual({ file: body.file, covers: body.covers });
    expect(selected.state).toEqual({ kind: 'importing' });
    expect(pipe!.queue.get('tv:1:1x2')?.state.kind ?? 'available').toBe('available');
    expect(series.episodes[1]!.fileId).toBe('existing');
    expect(sibling).toEqual(siblingBefore);
    expect(pipe!.tracker.state.downloads).toEqual([]);
  });

  it('maps only the selected episodes and keeps another blocked target of the hash unchanged', async () => {
    const { selected, sibling } = await source();
    const siblingBefore = structuredClone(sibling);
    const body = { file: 'part-a.mkv', covers: [{ season: 1, number: 1 }] };
    const preview = await api!.post(`/queue/entries/${selected.id}/match`, { ...body, preview: true });
    expect(preview.status).toBe(200);

    const applied = await api!.post(`/queue/entries/${selected.id}/match`, { ...preview.body, ...body, ids: [selected.id] });

    expect(applied.status).toBe(200);
    expect(selected.manualMatch).toEqual(body);
    expect(selected.state).toEqual({ kind: 'importing' });
    expect(sibling).toEqual(siblingBefore);
    expect(pipe!.tracker.state.searches).toEqual([]);
    expect(pipe!.tracker.state.downloads).toEqual([]);
  });

  it('keeps content coverage separate from the targets authorized to continue', async () => {
    const { selected, sibling } = await source();
    const before = structuredClone(sibling);
    const body = {
      file: 'part-a.mkv', covers: [{ season: 1, number: 1 }, { season: 2, number: 1 }], ids: [selected.id],
    };
    const preview = await api!.post(`/queue/entries/${selected.id}/match`, { ...body, preview: true });
    expect(preview.status).toBe(200);
    expect(preview.body.retries.map((entry: { id: string }) => entry.id)).toEqual([selected.id]);

    const applied = await api!.post(`/queue/entries/${selected.id}/match`, { ...preview.body, ...body });

    expect(applied.status).toBe(200);
    expect(selected.manualMatch).toMatchObject({ file: body.file, covers: body.covers });
    expect(selected.state).toEqual({ kind: 'importing' });
    expect(sibling.state).toEqual(before.state);
    expect(sibling.attempt).toBe(before.attempt);
    expect(sibling.numbering).toEqual(before.numbering);
  });

  it('rejects a file preview after the selected target changes', async () => {
    const { selected } = await source();
    const body = { file: 'part-a.mkv', covers: [{ season: 1, number: 1 }] };
    const preview = await api!.post(`/queue/entries/${selected.id}/match`, { ...body, preview: true });
    expect(preview.status).toBe(200);
    selected.manualMatch = { file: 'part-b.mkv', covers: [{ season: 1, number: 1 }] };
    pipe!.queue.touch(selected);
    const before = structuredClone({ queue: pipe!.db.data.queue, files: pipe!.db.data.files, jobs: pipe!.db.data.jobs });

    const applied = await api!.post(`/queue/entries/${selected.id}/match`, { ...preview.body, ...body });

    expect(applied.status).toBe(409);
    expect({ queue: pipe!.db.data.queue, files: pipe!.db.data.files, jobs: pipe!.db.data.jobs }).toEqual(before);
  });

  it('rejects a file preview after the source manifest changes', async () => {
    const { selected } = await source();
    const body = { file: 'part-a.mkv', covers: [{ season: 1, number: 1 }] };
    const preview = await api!.post(`/queue/entries/${selected.id}/match`, { ...body, preview: true });
    expect(preview.status).toBe(200);
    pipe!.qbit.setFiles(selected.transferHash!, [
      { name: `${PACK}/part-a.mkv`, size: 500, progress: 1 },
      { name: `${PACK}/part-c.mkv`, size: 600, progress: 1 },
    ]);
    const before = structuredClone({ queue: pipe!.db.data.queue, files: pipe!.db.data.files, jobs: pipe!.db.data.jobs });

    const applied = await api!.post(`/queue/entries/${selected.id}/match`, { ...preview.body, ...body });

    expect(applied.status).toBe(409);
    expect({ queue: pipe!.db.data.queue, files: pipe!.db.data.files, jobs: pipe!.db.data.jobs }).toEqual(before);
  });
});

describe('attachment coverage', () => {
  async function waitingSeries(episodes = [aired(1), aired(2)], name = PACK) {
    pipe = await startPipeline();
    await pipe.worker.pause();
    pipe.poller.stop();
    api = await pipe.api();
    const series = title({ rootId: 'tv', episodes });
    pipe.db.data.titles[series.key] = series;
    const entries = episodes.map((one) => entryOf({
      id: `tv:1:${one.season}x${one.number}`, titleKey: series.key, season: one.season, number: one.number,
      branch: 'waiting', reason: { code: 'no_results' },
    }));
    for (const entry of entries) pipe.db.data.queue[entry.id] = entry;
    return { hash: addExternal(name), entries };
  }

  it('requires a preview before attachment and changes no data', async () => {
    const { hash, entries } = await waitingSeries();
    pipe!.qbit.setFiles(hash, [{ name: `${PACK}/Show.Name.S01E01.mkv`, size: 1_000, progress: 0.2 }]);
    const before = structuredClone({ files: pipe!.db.data.files, queue: pipe!.db.data.queue, jobs: pipe!.db.data.jobs, imports: pipe!.db.data.imports });

    const applied = await api!.post(`/queue/entries/${entries[0]!.id}/attach`, {
      hash, confirmOwner: true, confirmTitle: true,
    });

    expect(applied.status).toBe(409);
    expect(applied.body.error).toBe('preview_required');
    expect({ files: pipe!.db.data.files, queue: pipe!.db.data.queue, jobs: pipe!.db.data.jobs, imports: pipe!.db.data.imports }).toEqual(before);
  });

  it('attaches identified episodes but not a target absent from the manifest', async () => {
    const { hash, entries } = await waitingSeries();
    pipe!.qbit.setFiles(hash, [{ name: `${PACK}/Show.Name.S01E01.mkv`, size: 1_000, progress: 0.2 }]);
    const body = { hash, ids: [entries[1]!.id] };
    const preview = await api!.post(`/queue/entries/${entries[0]!.id}/attach`, { ...body, preview: true });
    expect(preview.status).toBe(200);
    expect(preview.body.affected.map((entry: { id: string }) => entry.id)).toEqual([entries[0]!.id]);

    const applied = await api!.post(`/queue/entries/${entries[0]!.id}/attach`, {
      ...preview.body, ...body, confirmOwner: true, confirmTitle: true,
    });

    expect(applied.status).toBe(200);
    expect(entries[0]).toMatchObject({ transferHash: hash, state: { kind: 'downloading' } });
    expect(entries[1]).toMatchObject({ transferHash: null, state: { kind: 'blocked', problem: { code: 'pack_partial' } } });
  });

  it('keeps an unknown file association distinct from an absent episode', async () => {
    const { hash, entries } = await waitingSeries();
    pipe!.qbit.setFiles(hash, [
      { name: `${PACK}/Show.Name.S01E01.mkv`, size: 1_000, progress: 0.2 },
      { name: `${PACK}/unassigned.mkv`, size: 1_000, progress: 0.2 },
    ]);
    const body = { hash, ids: [entries[1]!.id] };
    const preview = await api!.post(`/queue/entries/${entries[0]!.id}/attach`, { ...body, preview: true });
    expect(preview.status).toBe(200);
    const applied = await api!.post(`/queue/entries/${entries[0]!.id}/attach`, {
      ...preview.body, ...body, confirmOwner: true, confirmTitle: true,
    });

    expect(applied.status).toBe(200);
    expect(entries[0]).toMatchObject({ transferHash: hash, state: { kind: 'downloading' } });
    expect(entries[1]!.state.kind).toBe('blocked');
    expect(reasonOfEntry(entries[1]!)).not.toMatchObject({ code: 'pack_partial' });
    expect(reasonOfEntry(entries[1]!)).not.toMatchObject({ code: 'file_not_found' });
  });

  it('uses file coverage from several seasons instead of the pack name', async () => {
    const name = 'Show.Name.S01-S02.1080p.WEB-DL-GRP';
    const { hash, entries } = await waitingSeries([aired(1), aired(2), episode(2, 1)], name);
    pipe!.qbit.setFiles(hash, [
      { name: `${name}/Show.Name.S01E01.mkv`, size: 1_000, progress: 0.2 },
      { name: `${name}/Show.Name.S02E01.mkv`, size: 1_000, progress: 0.2 },
    ]);
    const body = { hash, ids: entries.slice(1).map((entry) => entry.id) };
    const preview = await api!.post(`/queue/entries/${entries[0]!.id}/attach`, { ...body, preview: true });
    expect(preview.status).toBe(200);
    expect(preview.body.affected.map((entry: { id: string }) => entry.id)).toEqual([entries[0]!.id, entries[2]!.id]);
    const applied = await api!.post(`/queue/entries/${entries[0]!.id}/attach`, {
      ...preview.body, ...body, confirmOwner: true, confirmTitle: true,
    });

    expect(applied.status).toBe(200);
    expect(entries[0]!.transferHash).toBe(hash);
    expect(entries[2]!.transferHash).toBe(hash);
    expect(entries[1]).toMatchObject({ transferHash: null, state: { kind: 'blocked', problem: { code: 'pack_partial' } } });
  });

  it('rejects an attachment preview after the manifest changes', async () => {
    const { hash, entries } = await waitingSeries();
    pipe!.qbit.setFiles(hash, [
      { name: `${PACK}/Show.Name.S01E01.mkv`, size: 1_000, progress: 0.2 },
      { name: `${PACK}/Show.Name.S01E02.mkv`, size: 1_000, progress: 0.2 },
    ]);
    const body = { hash, ids: [entries[1]!.id] };
    const preview = await api!.post(`/queue/entries/${entries[0]!.id}/attach`, { ...body, preview: true });
    expect(preview.status).toBe(200);
    pipe!.qbit.setFiles(hash, [{ name: `${PACK}/Show.Name.S01E01.mkv`, size: 1_000, progress: 0.2 }]);
    const before = structuredClone({ queue: pipe!.db.data.queue, files: pipe!.db.data.files, jobs: pipe!.db.data.jobs });

    const applied = await api!.post(`/queue/entries/${entries[0]!.id}/attach`, {
      ...preview.body, ...body, confirmOwner: true, confirmTitle: true,
    });

    expect(applied.status).toBe(409);
    expect({ queue: pipe!.db.data.queue, files: pipe!.db.data.files, jobs: pipe!.db.data.jobs }).toEqual(before);
  });
});

describe('approved empty download coverage', () => {
  it.each([
    { name: 'the current target', number: 1, restart: false },
    { name: 'the current target after a restart', number: 1, restart: true },
    { name: 'a sibling of the same source', number: 2, restart: false },
  ])('does not restore filename coverage when the user retries $name', async ({ number, restart }) => {
    pipe = await startPipeline();
    await pipe.worker.pause();
    pipe.poller.stop();
    api = await pipe.api();
    const series = title({ rootId: 'tv', episodes: [aired(1), aired(2)] });
    pipe.db.data.titles[series.key] = series;
    const hash = addExternal(PACK);
    const file = 'Show.Name.S01E01E02.mkv';
    const content = 'both-episodes';
    pipe.complete(PACK, { [file]: content });
    const entries = [1, 2].map((episodeNumber) => entryOf({
      id: `tv:1:1x${episodeNumber}`, titleKey: series.key, season: 1, number: episodeNumber,
      stage: 'importing', reason: { code: 'file_not_found' }, transferHash: hash, clientId: 'client-1',
    }));
    for (const entry of entries) pipe.db.data.queue[entry.id] = entry;
    const anchor = entries[0]!;
    anchor.manualMatch = { file, covers: [{ season: 1, number: 1 }, { season: 1, number: 2 }] };
    const states = entries.map((entry) => structuredClone(entry.state));
    const jobs = structuredClone(pipe.db.data.jobs);

    const unassigned = await apply(`/queue/entries/${anchor.id}/match`, { file, covers: [], ids: [] });

    expect(unassigned.status).toBe(200);
    expect(entries.map((entry) => entry.state)).toEqual(states);
    expect(pipe.db.data.jobs).toEqual(jobs);
    if (restart) {
      const data = JSON.parse(JSON.stringify(pipe.db.data)) as typeof pipe.db.data;
      const torrent = structuredClone(pipe.qbit.torrents.get(hash)!);
      api.close();
      await pipe.stop();
      pipe = await startPipeline();
      await pipe.worker.pause();
      pipe.poller.stop();
      const indexers = pipe.db.data.indexers;
      Object.assign(pipe.db.data, data, {
        owner: null, sessions: {}, indexers,
        downloadClients: data.downloadClients.map((client) => ({ ...client, port: pipe!.qbit.port })),
      });
      pipe.qbit.torrents.set(hash, torrent);
      pipe.qbit.setFiles(hash, [{ name: `${PACK}/${file}`, size: Buffer.byteLength(content), progress: 1 }]);
      api = await pipe.api();
    }
    const target = pipe.queue.get(`tv:1:1x${number}`)!;
    const other = pipe.queue.get(`tv:1:1x${number === 1 ? 2 : 1}`)!;
    const otherBefore = structuredClone(other);

    const retried = await api.post('/queue/actions', { action: 'retry_import', ids: [target.id] });

    expect(retried.status).toBe(200);
    expect(Object.values(pipe.db.data.jobs).some((job) => job.type === 'import.run' && (job.payload as { hash?: string })?.hash === hash)).toBe(true);
    pipe.worker.resume();
    await until(() => !Object.values(pipe!.db.data.jobs).some((job) => job.type === 'import.run' && ['waiting', 'running'].includes(job.state)));

    expect(target.state).toMatchObject({ kind: 'blocked', at: 'importing' });
    expect(pipe.db.data.titles[series.key]!.episodes.map((episode) => episode.fileId)).toEqual([null, null]);
    expect(Object.values(pipe.db.data.files).filter((record) => record.titleKey === series.key).flatMap((record) => record.episodes)).toEqual([]);
    expect(other).toEqual(otherBefore);
    expect(pipe.tracker.state.searches).toEqual([]);
    expect(pipe.tracker.state.downloads).toEqual([]);
    expect(pipe.qbit.calls.some((call) => call.path === 'torrents/add')).toBe(false);
  });
});

describe('movie file selection', () => {
  it('uses an explicit file selection and enters import without another search', async () => {
    pipe = await startPipeline();
    await pipe.worker.pause();
    pipe.poller.stop();
    api = await pipe.api();
    const film = movie({ rootId: 'movie', manualRelease: true });
    pipe.db.data.titles[film.key] = film;
    const hash = addExternal(NAME);
    const file = 'Movie.Name.2019.Theatrical.mkv';
    pipe.complete(NAME, { [file]: 'selected-cut', 'Movie.Name.2019.Directors.Cut.mkv': 'longer-cut'.repeat(100) });
    const entry = entryOf({
      id: film.key, titleKey: film.key, stage: 'importing', reason: { code: 'file_unmapped' },
      transferHash: hash, clientId: 'client-1',
    });
    pipe.db.data.queue[entry.id] = entry;
    const body = { file, ids: [entry.id] };
    const preview = await api.post(`/queue/entries/${entry.id}/match`, { ...body, preview: true });
    expect(preview.status).toBe(200);
    expect(preview.body.affected.map((target: { id: string }) => target.id)).toEqual([entry.id]);
    expect(entry.manualMatch).toBeNull();
    expect(entry.state.kind).toBe('blocked');

    const applied = await api.post(`/queue/entries/${entry.id}/match`, { ...preview.body, ...body });

    expect(applied.status).toBe(200);
    expect(entry.manualMatch).toEqual({ file, covers: [] });
    expect(entry.state).toEqual({ kind: 'importing' });
    expect(film.fileId).toBeNull();
    expect(pipe.tracker.state.searches).toEqual([]);
    expect(pipe.tracker.state.downloads).toEqual([]);
    expect(Object.values(pipe.db.data.jobs).some((job) => ['queue.search', 'queue.grab', 'queue.send'].includes(job.type))).toBe(false);
  });
});
