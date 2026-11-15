import { stageOf, reasonOfEntry } from '../../src/library/downloads/queue.ts';
import { branchOf } from '../helpers/test-queue.ts';
import { afterEach, describe, expect, it } from 'vitest';
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
const BLOCKED = 'Movie.Name.2019.720p.BluRay-BLOCKED';
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
  await until(() => branchOf(entry!) === 'waiting' && reasonOfEntry(entry!)?.code === 'all_rejected');
  const detail = async () => (await api!.get(`/queue/entries/${entry!.id}`)).body.entry;
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
    // A release of another title breaks the identity check, so the search rejected it. A person can take it by hand,
    // and the list still shows the reason that stopped it.
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
  });

  it('lists a blocklisted release without the blocklist as a reason', async () => {
    pipe = await startPipeline();
    api = await pipe.api();
    const m = film();
    pipe.db.data.titles[m.key] = m;
    pipe.db.data.blocklist[`1:${BLOCKED}`] = { title: BLOCKED, reason: 'invalid_torrent', at: Date.now() };
    pipe.tracker.state.items = [
      { title: BLOCKED, size: LOW_SIZE },
      { title: LOW, size: LOW_SIZE },
    ];
    const [entry] = pipe.finder.requestSearch(m.key);
    await until(() => branchOf(entry!) === 'waiting' && reasonOfEntry(entry!)?.code === 'all_rejected');

    const view = (await api.get(`/queue/entries/${entry!.id}`)).body.entry;
    // The blocklist keeps a failed release out of the automatic search. A person takes it by hand, so the list offers
    // it and says why the blocklist holds the release, not that the release is on the blocklist.
    expect(view.search.rejected.map((release: { title: string }) => release.title)).toEqual(expect.arrayContaining([LOW, BLOCKED]));
    const blocked = view.search.rejected.find((release: { title: string }) => release.title === BLOCKED);
    expect(blocked).toMatchObject({ title: BLOCKED });
    expect(blocked.reasons).toContain('The indexer gave a file that is not a torrent.');
    expect(blocked.reasons).not.toContain('The release is on the blocklist.');

    // A search of an older version kept the blocklist as a reason. The row still says why the blocklist holds the
    // release.
    const old = entry!.search!.rejected.find((release) => release.guid === BLOCKED)!;
    old.reasons = ['The release is on the blocklist.'];
    const again = (await api.get(`/queue/entries/${entry!.id}`)).body.entry;
    const oldRow = again.search.rejected.find((release: { title: string }) => release.title === BLOCKED);
    expect(oldRow).toMatchObject({ reasons: ['The indexer gave a file that is not a torrent.'] });

    const grab = await api.post(`/queue/entries/${entry!.id}/releases/grab`, { indexerId: 1, guid: BLOCKED });
    expect(grab.status).toBe(202);
    await until(() => stageOf(entry!) === 'downloading');
    expect(entry!.release).toMatchObject({ title: BLOCKED, manual: true });
    expect(pipe.qbit.torrents.has(hashOf(BLOCKED))).toBe(true);
  });

  it('lists the files of the .torrent of a rejected release, by its indexer and guid', async () => {
    const file = 'Movie.Name.2019.720p.BluRay.x264-LOW.mkv';
    const { entry, detail } = await rejectedFilm([
      { title: LOW, size: LOW_SIZE, files: [file] },
      { title: WRONG, size: 100 * 120 * MIB },
    ]);
    const url = (query: string) => `/queue/entries/${entry.id}/releases/torrent?${query}`;

    // The client names the release, and the server finds its link. The link carries the API key of the indexer, so the
    // detail view never sends it to the client.
    const view = await detail();
    expect(view.search.rejected.find((release: { guid: string }) => release.guid === LOW)).not.toHaveProperty('link');

    const files = await api!.get(url(`indexerId=1&guid=${encodeURIComponent(LOW)}`));
    expect(files.status).toBe(200);
    expect(files.body.name).toBe(LOW);
    expect(files.body.files).toEqual([{ path: `${LOW}/${file}`, sizeBytes: 1000 }]);
    expect(files.body.totalBytes).toBe(1000);

    // A guid that the search did not reject has no link to serve.
    const unknown = await api!.get(url(`indexerId=1&guid=${encodeURIComponent('Movie.Name.2019.720p.BluRay.x264-UNLISTED')}`));
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual({ error: 'release_not_found' });

    // The server keeps the link of each rejected release. A release without one has no .torrent to read.
    const rejected = entry.search!.rejected.find((release) => release.guid === LOW)!;
    const link = rejected.link;
    rejected.link = null;
    const unavailable = await api!.get(url(`indexerId=1&guid=${encodeURIComponent(LOW)}`));
    expect(unavailable.status).toBe(409);
    expect(unavailable.body).toEqual({ error: 'torrent_unavailable' });
    rejected.link = link;

    // The server names a release by its indexer and its guid, so a request without the indexer is invalid.
    const invalid = await api!.get(url(`guid=${encodeURIComponent(LOW)}`));
    expect(invalid.status).toBe(400);
    expect(invalid.body).toEqual({ error: 'invalid_request' });
  });
});
