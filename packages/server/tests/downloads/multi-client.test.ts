import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyData, withDefaults, type Data } from '../../src/core/db.ts';
import type { ClientConfig } from '../../src/library/downloads/qbittorrent.ts';
import { startFakeQbit } from '../helpers/test-qbit.ts';
import { movie } from '../helpers/test-fixtures.ts';
import { hashOf, MIB, startPipeline, until } from '../helpers/test-pipeline.ts';

let pipe: Awaited<ReturnType<typeof startPipeline>> | undefined;
let extra: Awaited<ReturnType<typeof startFakeQbit>> | undefined;
afterEach(async () => {
  await pipe?.stop();
  extra?.close();
  pipe = extra = undefined;
});

// A second client next to the one of the pipeline. Its save folder is the download folder, as the client of the pipeline has.
async function addSecondClient() {
  extra = await startFakeQbit({ savePath: pipe!.folders.downloads });
  const config: ClientConfig = { id: 'client-b', name: 'Second', type: 'qbittorrent', host: '127.0.0.1', port: extra.port, auth: { type: 'password', username: 'admin', password: 'secret' }, enabled: true, maxDownloads: 0 };
  pipe!.db.data.downloadClients.push(config);
  return config;
}

const FIRST = 'Movie.Name.2019.1080p.BluRay.x264-GRP';
const SECOND = 'Other.Movie.2019.1080p.BluRay.x264-GRP';
const items = [
  { title: FIRST, size: 100 * 120 * MIB },
  { title: SECOND, size: 100 * 120 * MIB },
];
// A movie that came out already, so a search is possible.
const film = () => movie({ rootId: 'movie', meta: { ...movie().meta, releaseDates: [{ region: 'US', kind: 'digital', date: '2019-06-01' }] } });
const other = () => movie({ key: 'movie:3', tmdbId: 3, rootId: 'movie', meta: { ...film().meta, tmdbId: 3, title: 'Other Movie', originalTitle: 'Other Movie' } });

describe('a database with one client', () => {
  it('keeps the client as the first of the list, and gives it the open downloads', () => {
    const entry = { id: 'movie:2', transferHash: 'a'.repeat(40) };
    const idle = { id: 'movie:3', transferHash: null };
    const download = { id: 'j1', hash: 'a'.repeat(40), steps: [] };
    const manual = { id: 'j2', hash: 'b'.repeat(40), steps: [], sourceBase: '/inbox' };
    const old = { ...emptyData(), queue: { a: entry, b: idle }, imports: { j1: download, j2: manual }, downloadClient: { url: 'http://nas:8080', username: 'admin', password: 'secret', category: 'ladarr', downloadPath: '/data/downloads', remotePath: null } };
    const data = withDefaults(old as unknown as Data) as Data & { downloadClient?: unknown };

    expect(data.downloadClient).toBeUndefined();
    expect(data.downloadClients).toHaveLength(1);
    const [client] = data.downloadClients;
    expect(client).toMatchObject({ name: 'qBittorrent', type: 'qbittorrent', host: 'nas', port: 8080, auth: { type: 'password', username: 'admin', password: 'secret' }, enabled: true });
    expect(entry).toMatchObject({ clientId: client!.id });
    expect(idle).not.toHaveProperty('clientId');
    expect(download).toMatchObject({ clientId: client!.id, downloadBase: '/data/downloads' });
    expect(manual).not.toHaveProperty('downloadBase');
  });

  it('keeps https, the default port and the path of a proxy', () => {
    const data = withDefaults({ ...emptyData(), downloadClient: { url: 'https://example.com/qbit/', username: 'u', password: 'p', downloadPath: '/d' } } as unknown as Data);
    expect(data.downloadClients[0]).toMatchObject({ host: 'https://example.com/qbit', port: 443 });
  });
});

describe('several clients', () => {
  it('sends a new download to the first client that is on, and follows it to the library in that client', async () => {
    pipe = await startPipeline();
    const second = await addSecondClient();
    pipe.db.data.downloadClients[0]!.enabled = false;
    const title = film();
    pipe.db.data.titles[title.key] = title;
    pipe.tracker.state.items = items;

    const [entry] = pipe.finder.requestSearch(title.key);
    await until(() => entry!.stage === 'downloading');
    expect(entry!.clientId).toBe(second.id);
    expect(extra!.torrents.has(hashOf(FIRST))).toBe(true);
    expect(pipe.qbit.torrents.size).toBe(0);

    // The first client is on again. The download stays with the second one, and the import reads the path that the second one reports.
    pipe.db.data.downloadClients[0]!.enabled = true;
    mkdirSync(join(pipe.folders.downloads, FIRST), { recursive: true });
    writeFileSync(join(pipe.folders.downloads, FIRST, `${FIRST}.mkv`), 'video-data');
    extra!.progress(hashOf(FIRST), 1);
    await until(() => entry!.stage === 'available');
    expect(entry!.clientId).toBe(second.id);
    expect(pipe.qbit.torrents.size).toBe(0);
  });

  it('marks as old only the numbers of the client that does not answer', async () => {
    pipe = await startPipeline();
    const second = await addSecondClient();
    const first = film();
    const next = other();
    pipe.db.data.titles[first.key] = first;
    pipe.db.data.titles[next.key] = next;
    pipe.tracker.state.items = items;

    // The first title goes to the first client, and the second title goes to the second one.
    const [one] = pipe.finder.requestSearch(first.key);
    await until(() => one!.stage === 'downloading');
    pipe.db.data.downloadClients[0]!.enabled = false;
    const [two] = pipe.finder.requestSearch(next.key);
    await until(() => two!.stage === 'downloading');
    expect([one!.clientId, two!.clientId]).toEqual(['client-1', second.id]);
    pipe.db.data.downloadClients[0]!.enabled = true;
    pipe.qbit.progress(hashOf(FIRST), 0.3);
    extra!.progress(hashOf(SECOND), 0.3);
    await until(() => pipe!.poller.transfer(hashOf(FIRST))?.progress === 0.3 && pipe!.poller.transfer(hashOf(SECOND))?.progress === 0.3);

    pipe.qbit.control.down = true;
    extra!.progress(hashOf(SECOND), 0.6);
    await until(() => pipe!.poller.transfer(hashOf(FIRST))?.stale === true && pipe!.poller.transfer(hashOf(SECOND))?.progress === 0.6);
    expect(pipe.poller.transfer(hashOf(FIRST))).toMatchObject({ stale: true, progress: 0.3 });
    expect(pipe.poller.transfer(hashOf(SECOND))).toMatchObject({ stale: false });
    expect(pipe.poller.status().state).toBe('unreachable');

    pipe.qbit.control.down = false;
    await until(() => pipe!.poller.transfer(hashOf(FIRST))?.stale === false);
    expect(pipe.poller.status().state).toBe('ok');
  });

  it('marks as old the numbers of a client that is off', async () => {
    pipe = await startPipeline();
    const title = film();
    pipe.db.data.titles[title.key] = title;
    pipe.tracker.state.items = items;
    const [entry] = pipe.finder.requestSearch(title.key);
    await until(() => entry!.stage === 'downloading');
    pipe.qbit.progress(hashOf(FIRST), 0.4);
    await until(() => pipe!.poller.transfer(hashOf(FIRST))?.progress === 0.4);

    pipe.db.data.downloadClients[0]!.enabled = false;
    await until(() => pipe!.poller.transfer(hashOf(FIRST))?.stale === true);
    expect(entry!.stage).toBe('downloading');
  });
});
