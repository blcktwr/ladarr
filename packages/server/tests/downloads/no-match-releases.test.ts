import { stageOf } from '../../src/library/downloads/queue.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { movie } from '../helpers/test-fixtures.ts';
import { type FakeItem, hashOf, MIB, startPipeline, until } from '../helpers/test-pipeline.ts';

let pipe: Awaited<ReturnType<typeof startPipeline>> | undefined;
let api: Awaited<ReturnType<Awaited<ReturnType<typeof startPipeline>>['api']>> | undefined;
afterEach(async () => {
  api?.close();
  await pipe?.stop();
  pipe = api = undefined;
});

const LOW = 'Movie.Name.2019.720p.BluRay.x264-LOW';
const WRONG = 'Other.Movie.2019.1080p.BluRay-WRONG';
const TINY = 'Movie.Name.2019.1080p.WEB-DL-TINY';
const LOW_SIZE = 60 * 100 * MIB;
const film = () => movie({ rootId: 'movie', manualRelease: true });

// A film whose automatic search ends with every release rejected, and the detail view of its entry.
async function rejectedFilm(items: FakeItem[]) {
  pipe = await startPipeline();
  // The inspector reads the .torrent of a rejected release through the indexer, so the app has the indexer service.
  api = await pipe.api({ indexers: pipe.indexers });
  // A movie has no size limit by default, so the search would take the TINY release. The test sets a limit to reject it.
  pipe.db.data.qualitySizes.movie['webdl-1080'] = { min: 12.5, preferred: null, max: null };
  const m = film();
  pipe.db.data.titles[m.key] = m;
  pipe.tracker.state.items = items;
  const [entry] = pipe.finder.requestSearch(m.key);
  const detail = async () => (await api!.get(`/queue/entries/${entry!.id}`)).body.entry;
  await vi.waitFor(async () => expect(await detail()).toMatchObject({ status: 'stuck' }));
  return { m, entry: entry!, detail };
}

describe('the rejected releases of a search with no match', () => {
  it('lists every release that the search rejected, and grabs one by hand', async () => {
    const { entry, detail } = await rejectedFilm([
      { title: LOW, size: LOW_SIZE },
      { title: WRONG, size: 100 * 120 * MIB },
      { title: TINY, size: 10 * MIB },
    ]);

    const view = await detail();
    expect((await api!.get('/queue?stage=stuck')).body.items).toMatchObject([{ id: entry.id, status: 'stuck' }]);
    expect((await api!.get('/queue?stage=queued')).body.total).toBe(0);
    expect((await api!.get('/queue?stage=searching')).body.total).toBe(0);
    expect(pipe!.qbit.calls.filter(({ path }) => path === 'torrents/add')).toEqual([]);
    expect(Array.isArray(view.search.rejected)).toBe(true);
    // A 720p BluRay that the default 1080p/2160p profiles reject for its quality is a release that a person can pick.
    // The API lists it without the link, the magnet, or the info hash: the link carries the API key.
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
    // The size check of the quality did not stop this release, so the list has no numbers for it.
    expect(item.sizeRejection).toBeNull();
    // A 1080p WEB-DL of 10 MiB is 0.1 MiB/min for the 100 minutes of the movie, below the 12.5 MiB/min of the quality.
    // The list carries the numbers of the check, so the row can show why the file size did not fit.
    const tiny = view.search.rejected.find((release: { title: string }) => release.title === TINY);
    expect(tiny.sizeRejection).toEqual({ code: 'size_below_min', value: 0.1, limit: 12.5 });
    // The list shows why a release of another title failed the identity check.
    const wrong = view.search.rejected.find((release: { title: string }) => release.title === WRONG);
    expect(wrong).toMatchObject({ title: WRONG });
    expect(wrong.reasons).toContain('The title of the release is not this title.');

    // A search of an older version kept the old text of a reason. The row shows the text of this version.
    const old = entry.search!.rejected.find((release) => release.guid === LOW)!;
    old.reasons = ['The quality of the release is not in any quality profile of the title.'];
    const renamed = (await detail()).search.rejected.find((release: { title: string }) => release.title === LOW);
    expect(renamed.reasons).toEqual(['The quality of the release is not in the allowed qualities.']);

    const grab = await api!.post(`/queue/entries/${entry.id}/releases/grab`, { indexerId: 1, guid: LOW });
    expect(grab.status).toBe(202);
    expect(grab.body).toEqual({ started: [entry.id] });
    await until(() => stageOf(entry) === 'downloading');
    expect(entry.release).toMatchObject({ title: LOW, manual: true });
    expect(pipe!.qbit.torrents.has(hashOf(LOW))).toBe(true);
    expect(pipe!.acquisition.filter((event) => event.type === 'torrent' || event.type === 'add')).toEqual([
      { type: 'torrent', title: LOW },
      { type: 'add', hash: hashOf(LOW) },
    ]);
  });
});
