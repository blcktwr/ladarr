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
const TINY = 'Movie.Name.2019.1080p.WEB-DL-TINY';
const LOW_SIZE = 60 * 100 * MIB;
const film = () => movie({ rootId: 'movie', manualRelease: true });

// A film whose automatic search ends with every release rejected, and the detail view of its entry.
async function rejectedFilm(items: { title: string; size: number }[]) {
  pipe = await startPipeline();
  api = await pipe.api();
  // A movie has no size limit by default, so the search would take the TINY release. The test sets a limit to reject it.
  pipe.db.data.qualitySizes.movie['webdl-1080'] = { min: 12.5, preferred: null, max: null };
  const m = film();
  pipe.db.data.titles[m.key] = m;
  pipe.tracker.state.items = items;
  const [entry] = pipe.finder.requestSearch(m.key);
  await until(() => entry!.branch === 'waiting' && entry!.reason?.code === 'all_rejected');
  const detail = async () => (await api!.get(`/queue/entries/${entry!.id}`)).body.entry;
  return { m, entry: entry!, detail };
}

describe('the rejected releases of a search with no match', () => {
  it('lists every release that the search rejected, and grabs a grabbable one by hand', async () => {
    const { entry, detail } = await rejectedFilm([
      { title: LOW, size: LOW_SIZE },
      { title: WRONG, size: 100 * 120 * MIB },
      { title: TINY, size: 10 * MIB },
    ]);

    const view = await detail();
    expect(Array.isArray(view.search.rejected)).toBe(true);
    // A 720p BluRay that the default 1080p/2160p profiles reject for its quality is still a release that a person
    // can pick, so it is grabbable. The API lists it without the link, the magnet, or the info hash: the link carries
    // the API key.
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
      grabbable: true,
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
    // A release of another title breaks a safety check, so a manual grab cannot take it. The list still shows it,
    // with the reason that stopped it, and says that it is not grabbable.
    const wrong = view.search.rejected.find((release: { title: string }) => release.title === WRONG);
    expect(wrong).toMatchObject({ title: WRONG, grabbable: false });
    expect(wrong.reasons).toContain('The title of the release is not this title.');

    const grab = await api!.post(`/queue/entries/${entry.id}/releases/grab`, { indexerId: 1, guid: LOW });
    expect(grab.status).toBe(202);
    expect(grab.body).toEqual({ started: [entry.id] });
    await until(() => entry.stage === 'downloading');
    expect(entry.release).toMatchObject({ title: LOW, manual: true });
    expect(pipe!.qbit.torrents.has(hashOf(LOW))).toBe(true);
  });

  it('lists a blocklisted release as not grabbable, and never takes it', async () => {
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
    // A blocklisted release breaks a safety check, and a manual grab does not skip safety checks. The list shows it
    // with its reason and says that it is not grabbable, next to the release that a person can still take.
    expect(view.search.rejected.map((release: { title: string }) => release.title)).toEqual(expect.arrayContaining([LOW, BLOCKED]));
    const blocked = view.search.rejected.find((release: { title: string }) => release.title === BLOCKED);
    expect(blocked).toMatchObject({ title: BLOCKED, grabbable: false });
    expect(blocked.reasons).toContain('The release is on the blocklist.');

    const grab = await api.post(`/queue/entries/${entry!.id}/releases/grab`, { indexerId: 1, guid: BLOCKED });
    expect([404, 409]).toContain(grab.status);
    if (grab.status === 409) expect(grab.body).toMatchObject({ error: 'release_rejected' });
    expect(pipe.qbit.torrents.size).toBe(0);
    expect(entry!.release).toBeNull();
  });
});
