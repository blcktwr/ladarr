import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeLog, logToFile, recentLogs } from '../../src/core/log.ts';
import { ClientError, clientUrl, createQbittorrent, type ClientConfig } from '../../src/library/downloads/qbittorrent.ts';
import { startFakeQbit } from '../helpers/test-qbit.ts';

let fake: Awaited<ReturnType<typeof startFakeQbit>>;
const config = (overrides: Partial<ClientConfig> = {}): ClientConfig => ({ id: 'c1', name: 'qBittorrent', type: 'qbittorrent', host: '127.0.0.1', port: fake.port, auth: { type: 'password', username: 'admin', password: 'secret' }, enabled: true, maxDownloads: 0, ...overrides });
const torrentFile = (name: string) => Buffer.from(`d8:announce5:http:4:infod6:lengthi1000e4:name${name.length}:${name}12:piece lengthi16384e6:pieces20:AAAAAAAAAAAAAAAAAAAAee`);
const hashA = 'abcdef0123456789abcdef0123456789abcdef01';
const magnet = `magnet:?xt=urn:btih:${hashA}`;

beforeEach(async () => {
  fake = await startFakeQbit();
});
afterEach(() => fake.close());

describe('qBittorrent client', () => {
  it('signs in and reads the versions', async () => {
    const client = createQbittorrent(config());
    expect(await client.test()).toEqual({ version: 'v5.0.4', apiVersion: '2.11.3' });
  });

  it('logs each request to the client with its path and hides the password', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ladarr-qbit-'));
    try {
      logToFile(join(dir, 'ladarr.log'));
      const client = createQbittorrent(config());
      await client.test();
      await client.list();
      await closeLog();
      const entries = await recentLogs(20, { kind: 'requests' });
      const info = entries.find((entry) => entry.message === 'outbound request' && String((entry.request as { url?: string })?.url).includes('/api/v2/torrents/info'));
      expect(info).toMatchObject({
        system: 'Download client qBittorrent',
        request: { method: 'GET', url: expect.stringContaining('/api/v2/torrents/info') },
        response: { status: 200 },
      });
      const login = entries.find((entry) => entry.message === 'outbound request' && String((entry.request as { url?: string })?.url).includes('/api/v2/auth/login'));
      expect(login).toMatchObject({ request: { method: 'POST' }, response: { status: 200 } });
      expect(JSON.stringify(entries)).not.toContain('secret');
    } finally {
      await closeLog();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a wrong password with a message that holds no password', async () => {
    const error = await createQbittorrent(config({ auth: { type: 'password', username: 'admin', password: 'wrong-password' } })).test().catch((e) => e);
    expect(error).toBeInstanceOf(ClientError);
    expect(error.code).toBe('rejected');
    expect(error.message).not.toContain('wrong-password');
  });

  it('reports an unreachable client', async () => {
    fake.control.down = true;
    const error = await createQbittorrent(config()).test().catch((e) => e);
    expect(error).toMatchObject({ code: 'unreachable' });
    expect(error.message).not.toContain('127.0.0.1');
  });

  it('adds a torrent file and a magnet link with no tag, category, or save path', async () => {
    const client = createQbittorrent(config());
    await client.add({ torrent: torrentFile('Show.S01E01') });
    await client.add({ magnet });
    const list = await client.list();
    expect(list).toHaveLength(2);
    expect(list.every((t) => t.tags === '' && t.category === '')).toBe(true);
    expect(list.find((t) => t.hash === hashA)).toBeDefined();
    const sent = fake.calls.filter((call) => call.path === 'torrents/add').map((call) => JSON.parse(call.body!));
    expect(sent.every((form) => !('tags' in form) && !('category' in form) && !('savepath' in form))).toBe(true);
  });

  it('reads every torrent of the client, and finds a torrent by hash', async () => {
    const client = createQbittorrent(config());
    await client.add({ magnet });
    fake.torrents.set('f'.repeat(40), { ...fake.torrents.get(hashA)!, hash: 'f'.repeat(40), tags: '', category: 'other' });
    expect((await client.list()).map((t) => t.hash).sort()).toEqual([hashA, 'f'.repeat(40)].sort());
    expect((await client.find('f'.repeat(40)))?.category).toBe('other');
    expect(await client.find('0'.repeat(40))).toBeNull();
  });

  it('maps states and progress of a torrent', async () => {
    const client = createQbittorrent(config());
    await client.add({ magnet });
    expect((await client.find(hashA))).toMatchObject({ status: 'metadata', complete: false, etaSeconds: null });
    fake.progress(hashA, 0.5);
    expect(await client.find(hashA)).toMatchObject({ status: 'downloading', progress: 0.5, etaSeconds: 60, downloadRate: 1_000_000, seeds: 3, complete: false });
    fake.progress(hashA, 1);
    expect(await client.find(hashA)).toMatchObject({ status: 'seeding', complete: true, etaSeconds: null });
  });

  it('stops and starts on the new API, and pauses and resumes on the old one', async () => {
    const client = createQbittorrent(config());
    await client.add({ magnet });
    await client.setPaused(hashA, true);
    expect((await client.find(hashA))!.status).toBe('paused');
    await client.setPaused(hashA, false);
    expect((await client.find(hashA))!.status).toBe('downloading');
    expect(fake.calls.map((c) => c.path)).toContain('torrents/stop');

    fake.close();
    fake = await startFakeQbit({ flavor: '4' });
    const old = createQbittorrent(config());
    await old.add({ magnet });
    await old.setPaused(hashA, true);
    expect((await old.find(hashA))!.status).toBe('paused');
    expect(fake.calls.map((c) => c.path)).toContain('torrents/pause');
  });

  it('signs in again when the session ends', async () => {
    const client = createQbittorrent(config());
    await client.add({ magnet });
    fake.expireSessions();
    expect((await client.list()).map((t) => t.hash)).toEqual([hashA]);
    expect(fake.calls.filter((c) => c.path === 'auth/login')).toHaveLength(2);
  });

  it('removes the torrent and keeps the data unless told to delete it', async () => {
    const client = createQbittorrent(config());
    await client.add({ magnet });
    await client.remove(hashA);
    expect(fake.torrents.size).toBe(0);
    expect(JSON.parse(fake.calls.at(-1)!.body!)).toMatchObject({ hashes: hashA, deleteFiles: 'false' });
  });

  it('fails an add that the client does not accept', async () => {
    const client = createQbittorrent(config());
    fake.control.failAdds = true;
    await expect(client.add({ magnet })).rejects.toMatchObject({ code: 'rejected' });
  });

  it('reads the trackers and shows only the host of each, without the key in the address or in a message', async () => {
    const client = createQbittorrent(config());
    await client.add({ magnet });
    fake.trackers.set(hashA, [
      { url: '** [DHT] **', status: 0, tier: -1, num_peers: 4, num_seeds: 0, num_leeches: 0, num_downloaded: 0, msg: '' },
      { url: 'https://tracker.example/announce/0123456789abcdef0123456789abcdef?x=1', status: 4, tier: 0, num_peers: -1, num_seeds: 7, num_leeches: 2, num_downloaded: 30, msg: 'Unregistered torrent 0123456789abcdef0123456789abcdef' },
      { url: 'udp://other.example:6969/announce', status: 2, tier: 1, num_peers: 5, num_seeds: -1, num_leeches: 0, num_downloaded: 0, msg: '' },
      { url: 'https://third.example/announce', status: 4, tier: 2, num_peers: 0, num_seeds: 0, num_leeches: 0, num_downloaded: 0, msg: 'Error at https://third.example/announce/11111111-2222-3333-4444-555555555555 with key 11111111-2222-3333-4444-555555555555' },
    ]);
    const trackers = await client.trackers(hashA);
    expect(trackers).toEqual([
      { host: 'tracker.example', status: 'not_working', tier: 0, message: 'Unregistered torrent [hidden]', seeds: 7, peers: null, downloaded: 30 },
      { host: 'other.example', status: 'working', tier: 1, message: '', seeds: null, peers: 5, downloaded: 0 },
      { host: 'third.example', status: 'not_working', tier: 2, message: 'Error at [address] with key [hidden]', seeds: 0, peers: 0, downloaded: 0 },
    ]);
    expect(JSON.stringify(trackers)).not.toContain('0123456789abcdef');
    expect(JSON.stringify(trackers)).not.toContain('11111111-2222');
    expect(await client.trackers('0'.repeat(40))).toBeNull();
  });

  it('reads the queue limits and nothing else from the preferences', async () => {
    const client = createQbittorrent(config());
    expect(await client.slots()).toEqual({ queueing: true, maxActiveDownloads: 3, maxActiveTorrents: 5, maxActiveUploads: 3 });
    fake.preferences.queueing_enabled = 'yes';
    delete fake.preferences.max_active_downloads;
    expect(await client.slots()).toMatchObject({ queueing: null, maxActiveDownloads: null });
  });

  it('keeps the queue place, the tracker, and the swarm as unknown when the client does not report them', async () => {
    const client = createQbittorrent(config());
    await client.add({ magnet });
    expect(await client.find(hashA)).toMatchObject({ queuePosition: null, tracker: '', swarmSeeds: null, swarmPeers: null, availability: null });
    Object.assign(fake.torrents.get(hashA)!, { priority: 3, tracker: 'https://tracker.example/announce', num_complete: 12, num_incomplete: 4, availability: 1.5, state: 'queuedDL' });
    expect(await client.find(hashA)).toMatchObject({ status: 'queued', queuePosition: 3, tracker: 'https://tracker.example/announce', swarmSeeds: 12, swarmPeers: 4, availability: 1.5 });
    // The client sends -1 when queueing is off, and for a swarm it does not know.
    Object.assign(fake.torrents.get(hashA)!, { priority: -1, num_complete: -1, availability: -1 });
    expect(await client.find(hashA)).toMatchObject({ queuePosition: null, swarmSeeds: null, availability: null });
  });

  it('reads torrents by hash', async () => {
    const client = createQbittorrent(config());
    await client.add({ magnet });
    fake.torrents.set('f'.repeat(40), { ...fake.torrents.get(hashA)!, hash: 'f'.repeat(40), tags: '', category: 'other' });
    expect((await client.byHashes([hashA, 'f'.repeat(40), '0'.repeat(40)])).map((t) => t.hash).sort()).toEqual([hashA, 'f'.repeat(40)].sort());
    expect(await client.byHashes([])).toEqual([]);
    expect((await client.listAll()).map((t) => t.category).sort()).toEqual(['', 'other']);
  });
});

describe('sign in with an API key', () => {
  it('sends the key as a Bearer token, with no login', async () => {
    const keyed = await startFakeQbit({ apiKey: 'qbt_secret-key' });
    try {
      const client = createQbittorrent(config({ port: keyed.port, auth: { type: 'apiKey', apiKey: 'qbt_secret-key' } }));
      expect(await client.test()).toEqual({ version: 'v5.0.4', apiVersion: '2.11.3' });
      await client.add({ magnet });
      expect((await client.list()).map((t) => t.hash)).toEqual([hashA]);
      expect(keyed.calls.some((call) => call.path === 'auth/login')).toBe(false);
    } finally {
      keyed.close();
    }
  });

  it('rejects a wrong key with a message that holds no key', async () => {
    const keyed = await startFakeQbit({ apiKey: 'qbt_secret-key' });
    try {
      const error = await createQbittorrent(config({ port: keyed.port, auth: { type: 'apiKey', apiKey: 'qbt_wrong-key' } })).test().catch((e) => e);
      expect(error).toMatchObject({ code: 'rejected' });
      expect(error.message).not.toContain('qbt_wrong-key');
    } finally {
      keyed.close();
    }
  });
});

describe('the address of a client', () => {
  it.each([
    [{ host: 'localhost', port: 8080 }, 'http://localhost:8080'],
    [{ host: '192.168.1.5', port: 80 }, 'http://192.168.1.5'],
    [{ host: 'https://qbit.example.com', port: 443 }, 'https://qbit.example.com'],
    [{ host: 'https://example.com/qbit/', port: 8443 }, 'https://example.com:8443/qbit'],
  ])('builds %j', (input, url) => expect(clientUrl(input)).toBe(url));

  it.each([
    [{ host: '', port: 8080 }],
    [{ host: 'ftp://host', port: 8080 }],
    [{ host: 'http://user:pass@host', port: 8080 }],
    [{ host: 'host?x=1', port: 8080 }],
    [{ host: 'host', port: 0 }],
    [{ host: 'host', port: 65536 }],
    [{ host: 'host', port: 80.5 }],
  ])('refuses %j', (input) => expect(clientUrl(input)).toBeNull());
});
