import type { TorrentStatus, TrackerStatus } from '@ladarr/shared/enums';
import { outboundFetch } from '../core/http.ts';
import { JobError } from '../core/jobs.ts';

// How ladarr signs in to the client. An API key needs qBittorrent 5.2 or later. The secrets stay on the server.
export type ClientAuth = { type: 'apiKey'; apiKey: string } | { type: 'password'; username: string; password: string };

// The kind of download client. qBittorrent is the only one.
export type ClientType = 'qbittorrent';

// The settings of one download client. The client has its own folders and categories, so ladarr does not set them.
export type ClientConfig = {
  id: string;
  name: string;
  type: ClientType;
  // A host name or an address, with or without http:// or https://. Without it, the address is http. A path stays: it is the base of a proxy.
  host: string;
  port: number;
  auth: ClientAuth;
  // A client that is off gets no new download, and ladarr does not read it.
  enabled: boolean;
  // The most downloads that run at the same time in this client. Zero means no limit.
  maxDownloads: number;
};

// The address of the client. Returns null when host or port is not valid.
export function clientUrl({ host, port }: Pick<ClientConfig, 'host' | 'port'>): string | null {
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(host) ? host : `http://${host}`);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    url.port = String(port);
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

type ErrorCode = 'rejected' | 'unreachable' | 'unexpected';

// The message never holds the password or the address.
export class ClientError extends JobError {
  code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super('outage', message);
    this.code = code;
  }
}

// What the user can see about the wait or the work of a torrent. The client reports it. ladarr does not infer it.
export type { TorrentStatus, TrackerStatus };

export type Torrent = {
  hash: string;
  name: string;
  sizeBytes: number;
  progress: number;
  amountLeft: number;
  downloadRate: number;
  uploadRate: number;
  // Seconds, or null when the client cannot estimate it.
  etaSeconds: number | null;
  state: string;
  status: TorrentStatus;
  complete: boolean;
  savePath: string;
  contentPath: string;
  category: string;
  tags: string;
  seeds: number;
  peers: number;
  addedAt: number;
  // The share ratio, and the seconds that the torrent has been complete, as the client reports them.
  ratio: number;
  seedingSeconds: number;
  // The first tracker that works, as the client reports it. Empty when none works.
  tracker: string;
  // The place in the queue of the client. Null when queueing is off or the torrent is in seed mode.
  queuePosition: number | null;
  // The seeds and leechers of the swarm that the trackers report. Null when unknown.
  swarmSeeds: number | null;
  swarmPeers: number | null;
  // Null when the client does not report it.
  availability: number | null;
};

// One tracker of a torrent. The address is reduced to its host, because many addresses hold a private key.
export type Tracker = { host: string | null; status: TrackerStatus; tier: number; message: string; seeds: number | null; peers: number | null; downloaded: number | null };

// The limits of the queue of the client. A field is null when the client does not send it.
export type ClientSlots = { queueing: boolean | null; maxActiveDownloads: number | null; maxActiveTorrents: number | null; maxActiveUploads: number | null };

const TRACKER_STATUS: TrackerStatus[] = ['disabled', 'not_contacted', 'working', 'updating', 'not_working'];

const STATUS: Record<string, TorrentStatus> = {
  error: 'error',
  missingFiles: 'error',
  metaDL: 'metadata',
  forcedMetaDL: 'metadata',
  queuedDL: 'queued',
  checkingDL: 'checking',
  checkingUP: 'checking',
  checkingResumeData: 'checking',
  allocating: 'checking',
  moving: 'moving',
  downloading: 'downloading',
  forcedDL: 'downloading',
  stalledDL: 'stalled',
  pausedDL: 'paused',
  stoppedDL: 'paused',
  pausedUP: 'complete',
  stoppedUP: 'complete',
  queuedUP: 'seeding',
  uploading: 'seeding',
  forcedUP: 'seeding',
  stalledUP: 'seeding',
};

const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const str = (value: unknown) => (typeof value === 'string' ? value : '');
// The client sends -1 for a number that it does not know.
const known = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);
// qBittorrent sends 8640000 for an unknown ETA.
const UNKNOWN_ETA = 8_640_000;

function toTorrent(raw: Record<string, unknown>): Torrent | undefined {
  const hash = str(raw.hash).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(hash)) return;
  const amountLeft = num(raw.amount_left);
  const state = str(raw.state);
  const eta = num(raw.eta);
  return {
    hash,
    name: str(raw.name),
    sizeBytes: num(raw.total_size) || num(raw.size),
    progress: Math.min(Math.max(num(raw.progress), 0), 1),
    amountLeft,
    downloadRate: num(raw.dlspeed),
    uploadRate: num(raw.upspeed),
    etaSeconds: eta > 0 && eta < UNKNOWN_ETA ? eta : null,
    state,
    status: STATUS[state] ?? 'unknown',
    // A torrent with no data left is complete, even when the client has stopped it.
    complete: num(raw.progress) >= 1 && amountLeft === 0 && !['metaDL', 'forcedMetaDL', 'error', 'missingFiles'].includes(state),
    savePath: str(raw.save_path),
    contentPath: str(raw.content_path),
    category: str(raw.category),
    tags: str(raw.tags),
    seeds: num(raw.num_seeds),
    peers: num(raw.num_leechs),
    addedAt: num(raw.added_on) * 1000,
    ratio: Math.max(num(raw.ratio), 0),
    seedingSeconds: num(raw.seeding_time),
    tracker: str(raw.tracker),
    queuePosition: num(raw.priority) > 0 ? num(raw.priority) : null,
    swarmSeeds: known(raw.num_complete),
    swarmPeers: known(raw.num_incomplete),
    availability: known(raw.availability),
  };
}

type Options = { fetch?: typeof fetch; timeoutMs?: number };

export function createQbittorrent(config: ClientConfig, { fetch: fetchImpl = fetch, timeoutMs = 15_000 }: Options = {}) {
  const url = clientUrl(config);
  if (!url) throw new ClientError('unexpected', 'The address of the download client is not valid.');
  const sendRequest = outboundFetch(`Download client ${config.name}`, fetchImpl);
  const base = `${url}/api/v2/`;
  const origin = new URL(url).origin;
  let cookie: string | null = null;
  // A key signs every request. There is no session to open.
  let signedIn = config.auth.type === 'apiKey';
  // From the version 2.11 of the API, the client stops and starts a torrent. Before, it paused and resumed.
  let stopsAndStarts: boolean | null = null;

  async function send(path: string, init: RequestInit & { query?: Record<string, string> } = {}) {
    const url = new URL(path, base);
    for (const [key, value] of Object.entries(init.query ?? {})) url.searchParams.set(key, value);
    try {
      return await sendRequest(url, {
        ...init,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        // The client refuses a request whose Referer or Origin is not its own host.
        headers: { referer: origin, origin, ...(config.auth.type === 'apiKey' ? { authorization: `Bearer ${config.auth.apiKey}` } : cookie ? { cookie } : {}), ...(init.headers as Record<string, string> | undefined) },
      });
    } catch {
      throw new ClientError('unreachable', 'The download client did not answer.');
    }
  }

  async function login() {
    if (config.auth.type === 'apiKey') return;
    const res = await send('auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: config.auth.username, password: config.auth.password }),
    });
    if (res.status === 403) throw new ClientError('rejected', 'The download client banned this address after too many failed logins.');
    if (!res.ok) throw new ClientError('unexpected', `The download client answered with status ${res.status}.`);
    if ((await res.text()).trim() !== 'Ok.') throw new ClientError('rejected', 'The download client rejected the user name or the password.');
    // With "bypass authentication" on, the client sends no cookie, and no cookie is needed.
    const sid = res.headers.getSetCookie().map((line) => line.split(';')[0]!).find((pair) => pair.startsWith('SID='));
    cookie = sid ?? null;
    signedIn = true;
  }

  // Signs in on the first call, and once more when the session has ended.
  async function call(path: string, init: RequestInit & { query?: Record<string, string> } = {}, allow404 = false) {
    if (!signedIn) await login();
    let res = await send(path, init);
    if (res.status === 403 && config.auth.type === 'password') {
      await login();
      res = await send(path, init);
    }
    if (res.status === 404 && allow404) return res;
    if (!res.ok) throw new ClientError(res.status === 403 || res.status === 401 ? 'rejected' : 'unexpected', `The download client answered with status ${res.status}.`);
    return res;
  }

  async function info(query: Record<string, string>) {
    const raw = (await (await call('torrents/info', { query })).json().catch(() => {
      throw new ClientError('unexpected', 'The download client sent an answer that cannot be read.');
    })) as unknown;
    if (!Array.isArray(raw)) throw new ClientError('unexpected', 'The download client sent an answer that cannot be read.');
    return raw.flatMap((item) => (item && typeof item === 'object' ? [toTorrent(item as Record<string, unknown>)] : [])).filter((item): item is Torrent => Boolean(item));
  }

  async function apiVersion() {
    const text = (await (await call('app/webapiVersion')).text()).trim();
    const [major = 0, minor = 0] = text.split('.').map(Number);
    stopsAndStarts = major > 2 || (major === 2 && minor >= 11);
    return text;
  }

  return {
    async test() {
      signedIn = config.auth.type === 'apiKey';
      await login();
      const version = (await (await call('app/version')).text()).trim();
      return { version, apiVersion: await apiVersion() };
    },

    // Adds a torrent. The caller must read the client again when this fails with 'unreachable', because the add may have worked.
    // `limits` are the share limits of one torrent. The time is in minutes. The client acts at the limit, as its own settings say.
    async add(source: { torrent: Buffer } | { magnet: string }, limits?: { ratio: number | null; minutes: number | null } | null) {
      const form = new FormData();
      if ('torrent' in source) form.set('torrents', new Blob([new Uint8Array(source.torrent)], { type: 'application/x-bittorrent' }), 'release.torrent');
      else form.set('urls', source.magnet);
      if (limits?.ratio) form.set('ratioLimit', String(limits.ratio));
      if (limits?.minutes) form.set('seedingTimeLimit', String(Math.round(limits.minutes)));
      const res = await call('torrents/add', { method: 'POST', body: form });
      // "Fails." also means that the torrent is in the client already.
      if ((await res.text()).trim() === 'Fails.') throw new ClientError('rejected', 'The download client did not accept the torrent.');
    },

    // Every torrent of the client.
    list: () => info({}),

    // One torrent by hash. Null when the client does not have it.
    async find(hash: string) {
      return (await info({ hashes: hash }))[0] ?? null;
    },

    // Every torrent of the client, in any category. For the choice of a download to attach.
    listAll: () => info({}),

    // The torrents with these hashes, in any category.
    async byHashes(hashes: string[]) {
      const found: Torrent[] = [];
      for (let i = 0; i < hashes.length; i += 40) found.push(...(await info({ hashes: hashes.slice(i, i + 40).join('|') })));
      return found;
    },

    // The trackers that the client reports for a torrent. Null when the client does not have the torrent.
    async trackers(hash: string): Promise<Tracker[] | null> {
      const res = await call('torrents/trackers', { query: { hash } }, true);
      if (res.status === 404) return null;
      const raw = (await res.json().catch(() => null)) as unknown;
      if (!Array.isArray(raw)) throw new ClientError('unexpected', 'The download client sent an answer that cannot be read.');
      return raw
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
        // DHT, PeX and LSD are not trackers. The client lists them with a name in stars.
        .filter((item) => !str(item.url).startsWith('** ['))
        .map((item) => {
          let host: string | null = null;
          try {
            host = new URL(str(item.url)).hostname || null;
          } catch {
            /* The address is not a URL. The host stays unknown. */
          }
          return {
            host,
            status: TRACKER_STATUS[num(item.status)] ?? 'unknown',
            tier: num(item.tier),
            // A message can quote the address of the announce, with the key in it. A whole address and a long token do not leave this function.
            message: str(item.msg)
              .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[address]')
              .replace(/[A-Za-z0-9_-]{20,}/g, '[hidden]')
              .slice(0, 200),
            seeds: known(item.num_seeds),
            peers: known(item.num_peers),
            downloaded: known(item.num_downloaded),
          };
        });
    },

    // The queue limits of the client. Only these fields leave this function: the rest of the preferences hold settings of the client.
    async slots(): Promise<ClientSlots> {
      const raw = (await (await call('app/preferences')).json().catch(() => null)) as Record<string, unknown> | null;
      if (!raw || typeof raw !== 'object') throw new ClientError('unexpected', 'The download client sent an answer that cannot be read.');
      return {
        queueing: typeof raw.queueing_enabled === 'boolean' ? raw.queueing_enabled : null,
        maxActiveDownloads: known(raw.max_active_downloads),
        maxActiveTorrents: known(raw.max_active_torrents),
        maxActiveUploads: known(raw.max_active_uploads),
      };
    },

    async files(hash: string) {
      const res = await call('torrents/files', { query: { hash } }, true);
      if (res.status === 404) return [];
      const raw = (await res.json()) as { name?: unknown; size?: unknown; progress?: unknown }[];
      return raw.map((file) => ({ name: str(file.name), sizeBytes: num(file.size), progress: num(file.progress) }));
    },

    // Removes one torrent. The data stays on the disk unless `deleteFiles` is true.
    async remove(hash: string, deleteFiles = false) {
      await call('torrents/delete', { method: 'POST', body: new URLSearchParams({ hashes: hash, deleteFiles: String(deleteFiles) }) });
    },

    async setPaused(hash: string, paused: boolean) {
      if (stopsAndStarts === null) await apiVersion();
      const action = paused ? (stopsAndStarts ? 'stop' : 'pause') : stopsAndStarts ? 'start' : 'resume';
      await call(`torrents/${action}`, { method: 'POST', body: new URLSearchParams({ hashes: hash }) });
    },
  };
}

export type Qbittorrent = ReturnType<typeof createQbittorrent>;

// What the rest of the server needs from a client: its ID, the connection, and its settings.
export type ClientHandle = { id: string; api: Qbittorrent; config: ClientConfig };
