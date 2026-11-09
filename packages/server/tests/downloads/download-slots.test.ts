import { afterEach, describe, expect, it } from 'vitest';
import { movie } from '../helpers/test-fixtures.ts';
import { MIB, startPipeline, until } from '../helpers/test-pipeline.ts';

let pipe: Awaited<ReturnType<typeof startPipeline>> | undefined;
let api: Awaited<ReturnType<Awaited<ReturnType<typeof startPipeline>>['api']>> | undefined;
afterEach(async () => {
  api?.close();
  await pipe?.stop();
  pipe = api = undefined;
});

const FIRST = 'Movie.Name.2019.1080p.BluRay.x264-GRP';
const SECOND = 'Other.Movie.2019.1080p.BluRay.x264-GRP';
const THIRD = 'Third.Movie.2019.1080p.BluRay.x264-GRP';
const items = [
  { title: FIRST, size: 100 * 120 * MIB },
  { title: SECOND, size: 100 * 120 * MIB },
  { title: THIRD, size: 100 * 120 * MIB },
];
// A movie that came out already, so a search is possible.
const film = () => movie({ rootId: 'movie', meta: { ...movie().meta, releaseDates: [{ region: 'US', kind: 'digital', date: '2019-06-01' }] } });
const other = () => movie({ key: 'movie:3', tmdbId: 3, rootId: 'movie', meta: { ...film().meta, tmdbId: 3, title: 'Other Movie', originalTitle: 'Other Movie' } });
const another = () => movie({ key: 'movie:4', tmdbId: 4, rootId: 'movie', meta: { ...film().meta, tmdbId: 4, title: 'Third Movie', originalTitle: 'Third Movie' } });

// A valid client body. The password is left out, so a saved client keeps the stored one.
const client = (port: number, extra = {}) => ({ name: 'Main', type: 'qbittorrent', host: '127.0.0.1', port, auth: { type: 'password', username: 'admin' }, enabled: true, ...extra });

async function start() {
  pipe = await startPipeline();
  api = await pipe.api();
  return pipe;
}

function twoMovies() {
  const first = film();
  const next = other();
  pipe!.db.data.titles[first.key] = first;
  pipe!.db.data.titles[next.key] = next;
  pipe!.tracker.state.items = items;
  return { first, next };
}

describe('client max downloads', () => {
  it('lists the max downloads of each client, and starts a new client at 0', async () => {
    await start();
    const listed = (await api!.get('/clients')).body.clients;
    expect(listed).toHaveLength(1);
    expect(listed[0].maxDownloads).toBe(0);
  });

  it('saves the max downloads of a client', async () => {
    await start();
    const id = pipe!.db.data.downloadClients[0]!.id;
    const saved = await api!.fetchJson('PUT', `/clients/${id}`, client(pipe!.qbit.port, { maxDownloads: 2 }));
    expect(saved.status).toBe(200);
    expect(saved.body.client.maxDownloads).toBe(2);
    expect((await api!.get('/clients')).body.clients[0].maxDownloads).toBe(2);
  });

  it('keeps the max downloads when the body leaves it out', async () => {
    await start();
    const id = pipe!.db.data.downloadClients[0]!.id;
    await api!.fetchJson('PUT', `/clients/${id}`, client(pipe!.qbit.port, { maxDownloads: 2 }));
    const renamed = await api!.fetchJson('PUT', `/clients/${id}`, client(pipe!.qbit.port, { name: 'Renamed' }));
    expect(renamed.status).toBe(200);
    expect(renamed.body.client).toMatchObject({ name: 'Renamed', maxDownloads: 2 });
    expect((await api!.get('/clients')).body.clients[0].maxDownloads).toBe(2);
  });

  it('adds a client with max downloads, and 0 when the body leaves it out', async () => {
    await start();
    const withLimit = await api!.post('/clients', client(pipe!.qbit.port, { name: 'Limited', maxDownloads: 3 }));
    expect(withLimit.status).toBe(201);
    expect(withLimit.body.client.maxDownloads).toBe(3);
    const without = await api!.post('/clients', client(pipe!.qbit.port, { name: 'Default' }));
    expect(without.status).toBe(201);
    expect(without.body.client.maxDownloads).toBe(0);
  });

  it('refuses a max downloads that is out of range or not whole', async () => {
    await start();
    const id = pipe!.db.data.downloadClients[0]!.id;
    for (const value of [-1, 2.5, 101]) {
      const rejected = await api!.fetchJson('PUT', `/clients/${id}`, client(pipe!.qbit.port, { maxDownloads: value }));
      expect(rejected.status).toBe(400);
      expect(rejected.body).toEqual({ error: 'invalid_setting', field: 'maxDownloads' });
    }
  });
});

describe('download slots', () => {
  it('holds a release while the client has its max downloads running, and sends it when a slot frees', async () => {
    await start();
    Object.assign(pipe!.db.data.downloadClients[0]!, { maxDownloads: 1 });
    const { first, next } = twoMovies();

    const one = pipe!.finder.requestSearch(first.key)[0]!;
    const two = pipe!.finder.requestSearch(next.key)[0]!;
    await until(() => [one, two].filter((entry) => entry.stage === 'downloading').length === 1 && [one, two].some((entry) => entry.stage === 'fetching' && entry.release !== null));
    const running = [one, two].find((entry) => entry.stage === 'downloading')!;
    const waiting = [one, two].find((entry) => entry !== running)!;
    expect(waiting.stage).toBe('fetching');
    expect(waiting.release).not.toBeNull();
    expect(pipe!.qbit.torrents.size).toBe(1);

    // The waiting release stays held.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(pipe!.qbit.torrents.size).toBe(1);

    pipe!.qbit.progress(running.transferHash!, 1);
    await until(() => waiting.stage === 'downloading');
    expect(pipe!.qbit.torrents.size).toBe(2);
  }, 15_000);

  it('sends both releases when the client has no limit', async () => {
    await start();
    const { first, next } = twoMovies();

    const one = pipe!.finder.requestSearch(first.key)[0]!;
    const two = pipe!.finder.requestSearch(next.key)[0]!;
    await until(() => one.stage === 'downloading' && two.stage === 'downloading');
    expect(pipe!.qbit.torrents.size).toBe(2);
  });

  it('gives a free slot to the first target of the list, not to the target that fetched first', async () => {
    await start();
    Object.assign(pipe!.db.data.downloadClients[0]!, { maxDownloads: 1 });
    const first = film();
    const next = other();
    const third = another();
    for (const title of [first, next, third]) pipe!.db.data.titles[title.key] = title;
    pipe!.tracker.state.items = items;

    // The first title is the oldest, but it fetches its release after the other two.
    const one = pipe!.queue.ensure(first.key, null, null);
    const two = pipe!.queue.ensure(next.key, null, null);
    const three = pipe!.queue.ensure(third.key, null, null);
    one.createdAt = 1;
    two.createdAt = 2;
    three.createdAt = 3;

    pipe!.finder.requestSearch(next.key);
    await until(() => two.stage === 'downloading');
    pipe!.finder.requestSearch(third.key);
    await until(() => three.stage === 'fetching' && three.release !== null);
    pipe!.finder.requestSearch(first.key);
    await until(() => one.stage === 'fetching' && one.release !== null);

    // The list shows the oldest target first among the targets that fetch.
    const list = (await api!.get('/queue?stage=searching')).body.items;
    expect(list.map((item: { label: string }) => item.label)).toEqual(['Movie Name (2019)', 'Third Movie (2019)']);

    // When the slot frees, the first target of the list takes it.
    pipe!.qbit.progress(two.transferHash!, 1);
    await until(() => one.stage === 'downloading' || three.stage === 'downloading');
    expect(one.stage).toBe('downloading');
    expect(three.stage).toBe('fetching');
  }, 15_000);
});
