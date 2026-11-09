import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { infoHashOf, magnetHash } from '../../src/acquisition/torrent.ts';

export type FakeTorrent = {
  hash: string;
  name: string;
  size: number;
  progress: number;
  state: string;
  category: string;
  tags: string;
  save_path: string;
  content_path: string;
  dlspeed: number;
  eta: number;
  num_seeds: number;
  num_leechs: number;
  added_on: number;
  ratio?: number;
  seeding_time?: number;
  tracker?: string;
  priority?: number;
  num_complete?: number;
  num_incomplete?: number;
  availability?: number;
};

export type FakeTracker = { url: string; status: number; tier: number; num_peers: number; num_seeds: number; num_leeches: number; num_downloaded: number; msg: string };

type Options = {
  // "4" pauses and resumes. "5" stops and starts.
  flavor?: '4' | '5';
  username?: string;
  password?: string;
  // The key of the client. The client takes it as a Bearer token, from version 5.2.
  apiKey?: string;
  // The save folder of the client. A torrent that ladarr adds goes there.
  savePath?: string;
};

// A small qBittorrent for tests. It speaks the part of the WebUI API that ladarr uses.
export async function startFakeQbit({ flavor = '5', username = 'admin', password = 'secret', apiKey, savePath = '/downloads' }: Options = {}) {
  const torrents = new Map<string, FakeTorrent>();
  const categories = new Map<string, { name: string; savePath: string }>();
  const trackers = new Map<string, FakeTracker[]>();
  // The files of a torrent, with the part of each one that the client reports. A torrent without an entry here has one file.
  const fileLists = new Map<string, { name: string; size: number; progress: number }[]>();
  // The fields of /app/preferences that the tests use, and one that ladarr must never pass on.
  const preferences: Record<string, unknown> = { queueing_enabled: true, max_active_downloads: 3, max_active_torrents: 5, max_active_uploads: 3, web_ui_password: 'must-not-leave' };
  const calls: { path: string; body?: string }[] = [];
  const sessions = new Set<string>();
  const control = {
    // The number of /torrents/add requests that do the work but never answer, like a timeout.
    swallowAdds: 0,
    failAdds: false,
    down: false,
    loginFails: 0,
    // Waits before it answers /torrents/info, like a slow client.
    delayInfoMs: 0,
  };

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://x');
    const path = url.pathname.replace('/api/v2/', '');
    if (control.down) return void req.socket.destroy();

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks);
    const type = req.headers['content-type'] ?? '';
    const form: Record<string, string> = {};
    let files: Buffer[] = [];
    if (type.startsWith('application/x-www-form-urlencoded')) for (const [k, v] of new URLSearchParams(raw.toString())) form[k] = v;
    else if (type.startsWith('multipart/form-data')) {
      const data = await new Response(raw, { headers: { 'content-type': type } }).formData();
      for (const [key, value] of data.entries()) {
        if (typeof value === 'string') form[key] = value;
        else files.push(Buffer.from(await value.arrayBuffer()));
      }
    }
    calls.push({ path, body: JSON.stringify(form) });

    const send = (status: number, body: unknown = '', headers: Record<string, string> = {}) => {
      res.writeHead(status, headers);
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };

    if (path === 'auth/login') {
      if (control.loginFails > 0) {
        control.loginFails--;
        return send(200, 'Fails.');
      }
      if (form.username !== username || form.password !== password) return send(200, 'Fails.');
      const sid = Math.random().toString(36).slice(2);
      sessions.add(sid);
      return send(200, 'Ok.', { 'set-cookie': `SID=${sid}; HttpOnly; path=/` });
    }
    const sid = /SID=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (bearer !== undefined ? apiKey === undefined || bearer !== apiKey : !sid || !sessions.has(sid)) return send(bearer !== undefined && apiKey !== undefined ? 401 : 403, 'Forbidden');

    if (path === 'app/version') return send(200, flavor === '5' ? 'v5.0.4' : 'v4.6.7');
    if (path === 'app/webapiVersion') return send(200, flavor === '5' ? '2.11.3' : '2.9.3');
    if (path === 'app/preferences') return send(200, preferences);
    if (path === 'torrents/trackers') {
      const hash = url.searchParams.get('hash') ?? '';
      return torrents.has(hash) ? send(200, trackers.get(hash) ?? []) : send(404);
    }
    if (path === 'torrents/categories') return send(200, Object.fromEntries(categories));
    if (path === 'torrents/createCategory') {
      categories.set(form.category!, { name: form.category!, savePath: form.savePath! });
      return send(200);
    }
    if (path === 'torrents/add') {
      if (control.failAdds) return send(200, 'Fails.');
      let hash: string | undefined;
      let name = 'torrent';
      if (files[0]) {
        hash = infoHashOf(files[0]);
        const text = files[0].toString('latin1');
        const at = text.indexOf('4:name') + 6;
        const colon = text.indexOf(':', at);
        name = text.slice(colon + 1, colon + 1 + Number(text.slice(at, colon)));
      } else if (form.urls) hash = magnetHash(form.urls);
      if (!hash) return send(415);
      const existing = torrents.has(hash);
      if (!existing) {
        torrents.set(hash, { hash, name, size: 1_000_000, progress: 0, state: 'metaDL', category: form.category ?? '', tags: form.tags ?? '', save_path: form.savepath ?? savePath, content_path: `${form.savepath ?? savePath}/${name}`, dlspeed: 0, eta: 8640000, num_seeds: 0, num_leechs: 0, added_on: Math.floor(Date.now() / 1000) });
      }
      if (control.swallowAdds > 0) {
        control.swallowAdds--;
        // The work is done, and the answer never comes.
        return void setTimeout(() => res.destroy(), 50);
      }
      return send(200, existing ? 'Fails.' : 'Ok.');
    }
    if (path === 'torrents/info') {
      if (control.delayInfoMs) await new Promise((resolve) => setTimeout(resolve, control.delayInfoMs));
      const wanted = url.searchParams.get('hashes')?.split('|');
      const category = url.searchParams.get('category');
      const tag = url.searchParams.get('tag');
      return send(200, [...torrents.values()].filter((t) => (!wanted || wanted.includes(t.hash)) && (category === null || t.category === category) && (tag === null || t.tags.split(',').some((own) => own.trim() === tag))).map((t) => ({ ...t, total_size: t.size, amount_left: Math.round(t.size * (1 - t.progress)), upspeed: 0 })));
    }
    if (path === 'torrents/files') {
      const torrent = torrents.get(url.searchParams.get('hash') ?? '');
      if (!torrent) return send(404);
      return send(200, fileLists.get(torrent.hash) ?? [{ name: `${torrent.name}/${torrent.name}.mkv`, size: torrent.size, progress: torrent.progress }]);
    }
    if (path === 'torrents/delete') {
      for (const hash of form.hashes!.split('|')) torrents.delete(hash);
      return send(200);
    }
    const pause = flavor === '5' ? 'stop' : 'pause';
    const resume = flavor === '5' ? 'start' : 'resume';
    if (path === `torrents/${pause}` || path === `torrents/${resume}`) {
      const paused = path === `torrents/${pause}`;
      for (const hash of form.hashes!.split('|')) {
        const torrent = torrents.get(hash);
        if (torrent) torrent.state = paused ? (flavor === '5' ? (torrent.progress >= 1 ? 'stoppedUP' : 'stoppedDL') : torrent.progress >= 1 ? 'pausedUP' : 'pausedDL') : torrent.progress >= 1 ? 'uploading' : 'downloading';
      }
      return send(200);
    }
    send(404);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    port: (server.address() as AddressInfo).port,
    torrents,
    trackers,
    preferences,
    categories,
    calls,
    control,
    // Ends all sessions, like a restart of the client.
    expireSessions: () => sessions.clear(),
    // Changes a torrent the way a download would.
    progress(hash: string, progress: number, state = progress >= 1 ? 'uploading' : 'downloading') {
      const torrent = torrents.get(hash)!;
      Object.assign(torrent, { progress, state, dlspeed: progress >= 1 ? 0 : 1_000_000, eta: progress >= 1 ? 0 : 60, num_seeds: 3, num_leechs: 1 });
    },
    // Sets the files of a torrent, each with its own part. A pack downloads its files one by one.
    setFiles(hash: string, files: { name: string; size: number; progress: number }[]) {
      fileLists.set(hash, files);
    },
    close() {
      server.closeAllConnections();
      server.close();
    },
  };
}
