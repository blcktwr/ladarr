import { afterEach, describe, expect, it } from 'vitest';
import { movie } from '../helpers/test-fixtures.ts';
import { hashOf, MIB, startPipeline, until } from '../helpers/test-pipeline.ts';

let pipe: Awaited<ReturnType<typeof startPipeline>> | undefined;
let api: Awaited<ReturnType<Awaited<ReturnType<typeof startPipeline>>['api']>> | undefined;
afterEach(async () => {
  api?.close();
  await pipe?.stop();
  pipe = api = undefined;
});

const LOW = 'Movie.Name.2019.720p.BluRay.x264-LOW';
const WRONG = 'Other.Movie.2019.1080p.BluRay-WRONG';
const BLOCKED = 'Movie.Name.2019.720p.BluRay-BLOCKED';
const LOW_SIZE = 60 * 100 * MIB;
const film = () => movie({ rootId: 'movie', manualRelease: true });

// A film whose automatic search ends with every release rejected, and the detail view of its entry.
async function rejectedFilm(items: { title: string; size: number }[]) {
  pipe = await startPipeline();
  api = await pipe.api();
  const m = film();
  pipe.db.data.titles[m.key] = m;
  pipe.tracker.state.items = items;
  const [entry] = pipe.finder.requestSearch(m.key);
  await until(() => entry!.branch === 'waiting' && entry!.reason?.code === 'all_rejected');
  const detail = async () => (await api!.get(`/queue/entries/${entry!.id}`)).body.entry;
  return { m, entry: entry!, detail };
}

describe('the rejected releases of a search with no match', () => {
  it('lists the releases that only the preferences rejected, and grabs one by hand', async () => {
    const { entry, detail } = await rejectedFilm([
      { title: LOW, size: LOW_SIZE },
      { title: WRONG, size: 100 * 120 * MIB },
    ]);

    const view = await detail();
    expect(Array.isArray(view.search.rejected)).toBe(true);
    // A 720p BluRay that the default 1080p/2160p profiles reject for its quality is still a release that a person
    // can pick. The API lists it without the link, the magnet, or the info hash: the link carries the API key.
    const item = view.search.rejected.find((release: { title: string }) => release.title === LOW);
    expect(item).toMatchObject({
      indexerId: 1,
      guid: LOW,
      title: LOW,
      sizeBytes: LOW_SIZE,
      seeders: 20,
      resolution: 720,
      source: 'bluray',
      kind: 'single',
    });
    expect(item).not.toHaveProperty('link');
    expect(item).not.toHaveProperty('magnet');
    expect(item).not.toHaveProperty('infoHash');
    // A release of another title can never be taken, so it is not in the list.
    expect(view.search.rejected.map((release: { title: string }) => release.title)).not.toContain(WRONG);

    const grab = await api!.post(`/queue/entries/${entry.id}/releases/grab`, { indexerId: 1, guid: LOW });
    expect(grab.status).toBe(202);
    expect(grab.body).toEqual({ started: [entry.id] });
    await until(() => entry.stage === 'downloading');
    expect(entry.release).toMatchObject({ title: LOW, manual: true });
    expect(pipe!.qbit.torrents.has(hashOf(LOW))).toBe(true);
  });

  it('does not list a blocklisted release, and never takes it', async () => {
    pipe = await startPipeline();
    api = await pipe.api();
    const m = film();
    pipe.db.data.titles[m.key] = m;
    pipe.db.data.blocklist[`1:${BLOCKED}`] = { title: BLOCKED, reason: 'test', at: Date.now() };
    pipe.tracker.state.items = [
      { title: BLOCKED, size: LOW_SIZE },
      { title: LOW, size: LOW_SIZE },
    ];
    const [entry] = pipe.finder.requestSearch(m.key);
    await until(() => entry!.branch === 'waiting' && entry!.reason?.code === 'all_rejected');

    const view = (await api.get(`/queue/entries/${entry!.id}`)).body.entry;
    // A blocklisted release breaks a safety check, and a manual grab does not skip safety checks. It is not in the list.
    expect(view.search.rejected.map((release: { title: string }) => release.title)).toEqual([LOW]);

    const grab = await api.post(`/queue/entries/${entry!.id}/releases/grab`, { indexerId: 1, guid: BLOCKED });
    expect([404, 409]).toContain(grab.status);
    if (grab.status === 409) expect(grab.body).toMatchObject({ error: 'release_rejected' });
    expect(pipe.qbit.torrents.size).toBe(0);
    expect(entry!.release).toBeNull();
  });
});
