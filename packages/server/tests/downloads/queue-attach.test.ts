import { join } from 'node:path';
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
  await until(() => entry.branch === 'waiting');
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
  await until(() => entry.stage === 'downloading');
  pipe.complete(NAME, { 'Movie.mkv': 'the-film' });
  await until(() => entry.stage === 'available');
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
    expect((await api!.get('/queue/entries/movie:2')).body.entry).toMatchObject({ key: 'available', hasTorrent: false });
  });

  it('refuses a torrent that a target still uses', async () => {
    pipe = await startPipeline();
    api = await pipe.api();
    const film = movie({ rootId: 'movie', manualRelease: true });
    pipe.db.data.titles[film.key] = film;
    pipe.tracker.state.items = [{ title: NAME, size: 100 * 120 * MIB }];
    await api.post('/queue/search', { titleKey: film.key });
    await until(() => pipe!.queue.get('movie:2')!.stage === 'downloading');
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
    await until(() => pipe!.queue.get('tv:1:1x3')!.stage === 'downloading');
    pipe.complete(PACK, { 'Show.Name.S01E01.mkv': 'one', 'Show.Name.S01E02.mkv': 'two', 'Show.Name.S01E03.mkv': 'three' });
    await until(() => ['1x1', '1x2', '1x3'].every((n) => pipe!.queue.get(`tv:1:${n}`)!.stage === 'available'));

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
    await until(() => pipe!.queue.get('tv:1:1x1')!.branch === 'waiting' && pipe!.queue.get('tv:1:1x2')!.branch === 'waiting');
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
    await until(() => pipe!.queue.get('tv:1:1x1')!.branch === 'waiting' && pipe!.queue.get('tv:1:1x2')!.branch === 'waiting');
    const hash = addExternal(PACK);
    const first = pipe.queue.get('tv:1:1x1')!;

    const body = { hash, ids: ['tv:1:1x2'] };
    expect((await api.post('/queue/entries/tv:1:1x1/attach', body)).body.error).toBe('confirmation_required');
    expect((await api.post('/queue/entries/tv:1:1x1/attach', { ...body, confirmOwner: true })).body.error).toBe('confirmation_required');
    expect((await api.post('/queue/entries/tv:1:1x1/attach', { ...body, confirmTitle: true })).body.error).toBe('confirmation_required');
    expect(first.transferHash).toBeNull();

    const preview = (await api.post('/queue/entries/tv:1:1x1/attach', { ...body, preview: true })).body;
    expect(preview).toEqual({ hash, name: PACK, affected: [{ id: 'tv:1:1x1', label: 'Show Name S01E01' }, { id: 'tv:1:1x2', label: 'Show Name S01E02' }] });
    expect(first.transferHash).toBeNull();

    expect((await api.post('/queue/entries/tv:1:1x1/attach', { ...body, confirmOwner: true, confirmTitle: true })).status).toBe(200);
    for (const id of ['tv:1:1x1', 'tv:1:1x2']) {
      const entry = pipe.queue.get(id)!;
      expect(entry).toMatchObject({ stage: 'downloading', branch: null, transferHash: hash, release: { external: true, manual: true, kind: 'pack', title: PACK } });
      expect(entry.attempts.map((a) => [a.reason, a.outcome])).toEqual([['search requested', 'cancelled'], ['attached download', 'running']]);
    }
    const view = (await api.get('/queue/entries/tv:1:1x1')).body.entry;
    expect(view).toMatchObject({ hasTorrent: true, attached: true, key: 'downloading' });
    // The poller follows the torrent in the other category, and does not flag it as missing.
    await until(() => pipe!.poller.transfer(hash)?.entryIds.length === 2);
    expect(first.branch).toBeNull();
  });

  it('imports the files of an attached download, and never removes that torrent', async () => {
    const entry = await waitingMovie();
    const hash = addExternal(NAME);
    const before = pipe!.qbit.calls.length;
    expect((await api!.post('/queue/entries/movie:2/attach', { hash, confirmOwner: true, confirmTitle: true })).status).toBe(200);
    // The attach only reads the client. It adds no tag and no category.
    expect(pipe!.qbit.calls.slice(before).filter((call) => /add|delete|stop|start|pause|resume|Tags|Category/.test(call.path))).toEqual([]);
    expect(pipe!.qbit.torrents.get(hash)).toMatchObject({ tags: '', category: 'manual' });
    await until(() => entry.stage === 'downloading' && pipe!.poller.transfer(hash) !== undefined);
    pipe!.complete(NAME, { 'Movie.mkv': 'the-film' });
    await until(() => entry.stage === 'available');
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
    expect((await api!.post('/queue/entries/movie:2/attach', { hash, confirmOwner: true, confirmTitle: true })).status).toBe(200);
    expect(entry.history.at(-1)).toMatchObject({ stage: 'validating', cause: 'download attached by the user' });
    await until(() => entry.stage === 'available');
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
    pipe!.queue.move(entry, { stage: 'downloading', branch: null, reason: null }, 'test');
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
    await until(() => entry.stage === 'available');
    expect(entry.release?.external).toBe(true);
    expect(pipe.db.data.sentTorrents[hash]).toBeUndefined();
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
    await until(() => entry.reason?.code === 'torrent_exists');
    expect(entry.reason?.code).toBe('torrent_exists');
    expect((await api.get('/queue/entries/movie:2')).body.entry.reason).toMatchObject({ action: 'attach' });
    expect((await api.post('/queue/entries/movie:2/attach', { hash: hashOf(NAME), confirmOwner: true, confirmTitle: true })).status).toBe(200);
    expect(entry).toMatchObject({ stage: 'downloading', branch: null, reason: null });
    pipe.complete(NAME, { 'Movie.mkv': 'the-film' });
    await until(() => entry.stage === 'available');
  });

  it('takes over a torrent that ladarr sent, after the target that sent it is gone', async () => {
    pipe = await startPipeline();
    api = await pipe.api();
    const film = movie({ rootId: 'movie', manualRelease: true });
    pipe.db.data.titles[film.key] = film;
    pipe.tracker.state.items = [{ title: NAME, size: 100 * 120 * MIB }];
    await api.post('/queue/search', { titleKey: film.key });
    const hash = hashOf(NAME);
    await until(() => pipe!.queue.get('movie:2')?.stage === 'downloading');
    // The target leaves the queue. The torrent stays in the client, because ladarr added it.
    delete pipe.db.data.queue['movie:2'];
    pipe.finder.requestSearch(film.key);
    const entry = pipe.queue.get('movie:2')!;
    await until(() => entry.stage === 'downloading' && entry.reason === null);
    expect(entry).toMatchObject({ branch: null, reason: null, transferHash: hash });
  });

  it('takes over a torrent that ladarr sent before the record of the sent torrents', async () => {
    pipe = await startPipeline();
    api = await pipe.api();
    const film = movie({ rootId: 'movie', manualRelease: true });
    pipe.db.data.titles[film.key] = film;
    pipe.tracker.state.items = [{ title: NAME, size: 100 * 120 * MIB }];
    await api.post('/queue/search', { titleKey: film.key });
    const entry = pipe.queue.get('movie:2')!;
    await until(() => entry.stage === 'downloading');
    // A file from an older version has no record. The history of the target says what it sent.
    delete pipe.db.data.sentTorrents[hashOf(NAME)];
    pipe.queue.move(entry, { branch: 'cancelled' }, 'cancelled by the user');
    pipe.finder.requestSearch(film.key);
    await until(() => entry.stage === 'downloading' && entry.branch === null && entry.reason === null);
    expect(entry.transferHash).toBe(hashOf(NAME));
  });

  it('leaves a sibling that waits on the same torrent in Sending when only one episode is attached', async () => {
    pipe = await startPipeline();
    api = await pipe.api();
    const series = title({ rootId: 'tv', episodes: [aired(1), aired(2)] });
    pipe.db.data.titles[series.key] = series;
    pipe.tracker.state.items = [{ title: PACK, size: 2 * 60 * 45 * MIB }];
    // The user added the pack by hand in another category, so the grab stops for both episodes.
    const hash = addExternal(PACK);
    pipe.finder.requestSearch(series.key);
    await until(() => ['1x1', '1x2'].every((n) => pipe!.queue.get(`tv:1:${n}`)!.reason?.code === 'torrent_exists'));
    expect((await api.post('/queue/entries/tv:1:1x1/attach', { hash, confirmOwner: true, confirmTitle: true })).status).toBe(200);
    await until(() => pipe!.poller.transfer(hash)?.entryIds.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(pipe.queue.get('tv:1:1x1')).toMatchObject({ stage: 'downloading', branch: null });
    expect(pipe.queue.get('tv:1:1x2')).toMatchObject({ stage: 'fetching', branch: null, reason: { code: 'torrent_exists' } });
    expect(pipe.poller.transfer(hash)!.entryIds).toEqual(['tv:1:1x1']);
  });

  it('checks the targets again after the client answers, and refuses a target that changed in that time', async () => {
    const entry = await waitingMovie();
    const hash = addExternal(NAME);
    // The client answers slowly. The user cancels the target while the attach waits.
    pipe!.qbit.control.delayInfoMs = 300;
    const attaching = api!.post('/queue/entries/movie:2/attach', { hash, confirmOwner: true, confirmTitle: true });
    await new Promise((resolve) => setTimeout(resolve, 100));
    pipe!.queue.move(entry, { branch: 'cancelled', reason: null }, 'cancelled by the user');
    const result = await attaching;
    expect(result.status).toBe(409);
    expect(result.body.error).toBe('attach_not_supported');
    expect(entry).toMatchObject({ branch: 'cancelled', transferHash: null });
  });

  it('follows a torrent that the user moved to another category', async () => {
    pipe = await startPipeline();
    api = await pipe.api();
    const film = movie({ rootId: 'movie', manualRelease: true });
    pipe.db.data.titles[film.key] = film;
    pipe.tracker.state.items = [{ title: NAME, size: 100 * 120 * MIB }];
    await api.post('/queue/search', { titleKey: film.key });
    const entry = pipe.queue.get('movie:2')!;
    await until(() => entry.stage === 'downloading');
    pipe.qbit.torrents.get(hashOf(NAME))!.category = 'moved';
    pipe.qbit.progress(hashOf(NAME), 0.5);
    await until(() => pipe!.poller.transfer(hashOf(NAME))?.progress === 0.5);
    expect(entry.branch).toBeNull();
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
    await until(() => pipe!.queue.get('movie:2')!.stage === 'downloading');
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
    await until(() => pipe!.queue.get('tv:1:1x3')!.stage === 'downloading');
    // The names of the files give no episode numbers, so ladarr can not pick.
    pipe.complete(PACK, { 'part-a.mkv': 'first-and-second', 'part-b.mkv': 'third-file' });
    await until(() => ['1x1', '1x2', '1x3'].every((n) => pipe!.queue.get(`tv:1:${n}`)!.reason?.code === 'file_not_found'));
  }

  it('previews each association before it changes, and imports one file for two episodes', async () => {
    await blockedPack();
    const files = (await api!.get('/queue/entries/tv:1:1x1/files')).body;
    expect(files.entries.map((e: { id: string }) => e.id).sort()).toEqual(['tv:1:1x1', 'tv:1:1x2', 'tv:1:1x3']);

    const body = { file: 'part-a.mkv', covers: [{ season: 1, number: 1 }, { season: 1, number: 2 }] };
    const preview = (await api!.post('/queue/entries/tv:1:1x1/match', { ...body, preview: true })).body;
    expect(preview).toEqual({
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

    expect((await api!.post('/queue/entries/tv:1:1x1/match', body)).status).toBe(200);
    await until(() => ['1x1', '1x2'].every((n) => pipe!.queue.get(`tv:1:${n}`)!.stage === 'available'));
    // One file holds both episodes, and the third episode still waits for its own file.
    const files2 = Object.values(pipe!.db.data.files);
    expect(files2).toHaveLength(1);
    expect(files2[0]!.path).toBe('Show Name (2020)/Season 01/Show Name - S01E01E02.mkv');
    expect(files2[0]!.episodes.map((e) => e.number)).toEqual([1, 2]);
    expect(pipe!.queue.get('tv:1:1x3')!.reason?.code).toBe('file_not_found');

    expect((await api!.post('/queue/entries/tv:1:1x3/match', { file: 'part-b.mkv' })).status).toBe(200);
    await until(() => pipe!.queue.get('tv:1:1x3')!.stage === 'available');
    expect(Object.values(pipe!.db.data.files)).toHaveLength(2);
  });

  it('shows the targets that lose a file and the file that each target has now', async () => {
    await blockedPack();
    const second = pipe!.queue.get('tv:1:1x2')!;
    const third = pipe!.queue.get('tv:1:1x3')!;
    second.manualMatch = { file: 'part-a.mkv', covers: [{ season: 1, number: 2 }] };
    third.manualMatch = { file: 'part-b.mkv', covers: [{ season: 1, number: 3 }] };
    const preview = (await api!.post('/queue/entries/tv:1:1x1/match', { file: 'part-a.mkv', covers: [{ season: 1, number: 1 }, { season: 1, number: 3 }], preview: true })).body;
    expect(preview.affected).toEqual([
      { id: 'tv:1:1x1', label: 'Show Name S01E01', current: null },
      { id: 'tv:1:1x3', label: 'Show Name S01E03', current: 'part-b.mkv' },
    ]);
    expect(preview.replaces).toEqual([{ id: 'tv:1:1x2', label: 'Show Name S01E02' }]);
    // The preview changed nothing. The apply takes the file from the target that loses it.
    expect(second.manualMatch).not.toBeNull();
    await api!.post('/queue/entries/tv:1:1x1/match', { file: 'part-a.mkv', covers: [{ season: 1, number: 1 }, { season: 1, number: 3 }] });
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
