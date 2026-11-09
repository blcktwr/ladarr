import type { Language, MediaType } from '@ladarr/shared/enums';
import { Low, Memory, type Adapter } from 'lowdb';
import { TextFile } from 'lowdb/node';
import { dirname, join } from 'node:path';
import type { CompatCommand } from '../integrations/compat-common.ts';
import type { Job } from './jobs.ts';
import type { Override, Title } from '../library/library.ts';
import type { Indexer } from '../acquisition/indexers.ts';
import { randomUUID } from 'node:crypto';
import type { ClientConfig } from '../downloads/qbittorrent.ts';
import type { QueueEntry } from '../downloads/queue.ts';
import type { ImportJournal } from '../library/importer.ts';
import type { VerificationState } from '../library/verification.ts';
import type { SourceDownload, SourceEpisode } from '../migration/migration-source.ts';
import { DEFAULT_NAMING, type NamingTemplates } from '../library/naming.ts';
import { defaultProfiles, defaultSizes, type Profile, type ReleaseSource, type SizeLimits } from '../acquisition/quality.ts';
import type { WebhookState } from '../integrations/webhook.ts';

// Change this number when a new version cannot read the file of an old one, or the other way round.
// Version 2 keeps the queue work in queue.json, so an older version must not open the new db.json.
// Version 4 keeps the webhooks in a list, so an older version must not open the new db.json.
export const SCHEMA_VERSION = 4;

export type Settings = {
  setupCompleted: boolean;
  // ISO 3166-1 region for movie release dates, and the IANA time zone for date-only air dates.
  region: string;
  timeZone: string;
  // The language of the interface. The server sends no text in it.
  language: Language;
  // The colors of the interface.
  theme: 'dark' | 'light';
  // Root IDs.
  defaultRoots: { movie: string | null; tv: string | null };
  audio: { language: string; strict: boolean } | null;
  // Keep the whole log of a target while it is in the queue. The log goes when the target is available.
  keepQueueLogs: boolean;
  // The name of a file in the library. See naming.ts.
  naming: NamingTemplates;
};

// One title from a Sonarr or Radarr import. The ledger keeps the result, so a second import skips what is done.
export type LedgerEntry = {
  status: 'pending' | 'imported' | 'matched' | 'failed';
  app: 'sonarr' | 'radarr';
  sourceId: number;
  title: string;
  year: number | null;
  // The key of the title in the library, when there is one.
  key: string | null;
  error: string | null;
  // What the job needs to add the title.
  request: {
    mediaType: MediaType;
    tmdbId: number;
    rootId: string;
    folder: string | null;
    preset: string | null;
    paused: boolean;
    seriesType: 'standard' | 'anime';
    seasonOverrides: Record<string, Override>;
    // The download hashes and the episode monitoring of the source. The verification reads them after the add.
    downloads?: SourceDownload[];
    sourceEpisodes?: SourceEpisode[];
    manualRelease?: boolean;
  };
  updatedAt: number;
};

// A media file that ladarr knows. The path is relative to the root of its title.
// A file that is gone from the disk stays here with `missing` set. Only the user removes it.
export type MediaFile = {
  id: string;
  titleKey: string;
  path: string;
  sizeBytes: number;
  mtimeMs: number;
  // The episodes that the file covers. A movie file covers none.
  episodes: { season: number; number: number }[];
  missing: boolean;
  addedAt: number;
  // The source of the release that gave the file. Old records and scanned files lack it, and then the file name tells.
  source?: ReleaseSource | null;
  // The resolution of the release that gave the file. Null when the release does not say.
  resolution?: number | null;
};

// A library folder. `dev` is the device number at the time the user accepted the folder.
// A different number later means that another disk is mounted there, or that the mount is gone.
export type Root = { id: string; path: string; mediaType: MediaType; dev: number };

export type Data = {
  schemaVersion: number;
  owner: { passwordHash: string; createdAt: number } | null;
  sessions: Record<string, { csrfToken: string; createdAt: number; expiresAt: number }>;
  // shortcut: stored as plain text so Settings can show it again, like Sonarr. Hash it if the file is shared.
  apiKey: string | null;
  jobs: Record<string, Job>;
  jobSeq: number;
  prioritySeq: number;
  settings: Settings;
  // The quality profiles, keyed by ID. The sizes are keyed by the ID of a quality. See quality.ts.
  profiles: Record<string, Profile>;
  // The IDs of the profiles, the best first. A search tries them in this order.
  profileOrder: string[];
  qualitySizes: Record<string, SizeLimits>;
  roots: Record<string, Root>;
  // Keyed by media type and TMDB ID, for example "tv:1396".
  titles: Record<string, Title>;
  // Keyed by the namespace of the source and the ID in the source, for example "sonarr:1a2b3c4d:57".
  ledger: Record<string, LedgerEntry>;
  // The verification of each imported title, keyed by the title key. See library/verification.ts.
  verifications: Record<string, VerificationState>;
  files: Record<string, MediaFile>;
  // Keyed by the numeric ID that ladarr gave to the indexer, as text.
  indexers: Record<string, Indexer>;
  indexerSeq: number;
  // The download clients, in the order of the list. A new download goes to the first one that is on.
  downloadClients: ClientConfig[];
  // Keyed by the ID of the target. See queue.ts.
  queue: Record<string, QueueEntry>;
  // Rises with each change of an entry. SSE messages and snapshots carry it.
  queueRev: number;
  // The user paused the queue: no new queue work starts, and the running work ends.
  queuePaused: boolean;
  // The steps of the imports that are not done. See importer.ts.
  imports: Record<string, ImportJournal>;
  // Releases that ladarr must not take again, keyed by info hash, or by indexer and GUID.
  blocklist: Record<string, { title: string; reason: string; at: number; titleKey?: string; season?: number }>;
  // The secret in the URL of the iCal feed. Null means that the feed is off.
  calendarFeedToken: string | null;
  // The destinations for events, one for each event type. See webhook.ts.
  webhooks: WebhookState[];
  // The commands that callers of the Sonarr and Radarr adapters sent. The ID is the same after a restart.
  compat: { commandSeq: number; commands: Record<string, CompatCommand> };
};

export type Db = Low<Data>;

export const emptyData = (): Data => ({
  schemaVersion: SCHEMA_VERSION,
  owner: null,
  sessions: {},
  apiKey: null,
  jobs: {},
  jobSeq: 0,
  prioritySeq: 0,
  settings: {
    setupCompleted: false,
    region: 'US',
    timeZone: 'UTC',
    language: 'en',
    theme: 'dark',
    defaultRoots: { movie: null, tv: null },
    audio: null,
    keepQueueLogs: true,
    naming: { ...DEFAULT_NAMING },
  },
  profiles: defaultProfiles(),
  profileOrder: ['p1080', 'p2160'],
  qualitySizes: defaultSizes(),
  roots: {},
  titles: {},
  ledger: {},
  verifications: {},
  files: {},
  indexers: {},
  indexerSeq: 0,
  downloadClients: [],
  queue: {},
  queueRev: 0,
  queuePaused: false,
  imports: {},
  blocklist: {},
  calendarFeedToken: null,
  webhooks: [],
  compat: { commandSeq: 0, commands: {} },
});

// The profiles in the order of the chain, the best first. A profile that the order lacks goes after the others.
export function profilesInOrder(data: Pick<Data, 'profiles' | 'profileOrder'>): Profile[] {
  const list: Profile[] = [];
  const seen = new Set<string>();
  for (const id of data.profileOrder ?? []) {
    const profile = data.profiles[id];
    if (profile && !seen.has(id)) {
      seen.add(id);
      list.push(profile);
    }
  }
  for (const profile of Object.values(data.profiles)) if (!seen.has(profile.id)) list.push(profile);
  return list;
}

// The chain that a title searches. A title starts at its profile and goes down the list.
export const profilesFor = (data: Pick<Data, 'profiles' | 'profileOrder'>, title: { preset: string | null }): Profile[] => {
  const list = profilesInOrder(data);
  if (!title.preset) return list;
  const index = list.findIndex((profile) => profile.id === title.preset);
  return index > 0 ? list.slice(index) : list;
};

type OneClient = { url: string; username: string; password: string; downloadPath: string };

// A file from an older version can lack a collection that a newer version added.
export function withDefaults(data: Data): Data {
  const empty = emptyData();
  const loaded = { ...empty.settings, ...data.settings } as Settings & { maxAliases?: number; aliasLanguages?: string[] | null; upgrades?: { enabled: boolean; stopAt: string }; defaultPreset?: string; recentDays?: number; recoveryDays?: number };
  // An older file has the number of aliases. The search asks for every alias now.
  delete loaded.maxAliases;
  // The languages of the aliases are a choice of each indexer now.
  delete loaded.aliasLanguages;
  // An episode counts as recent for a week now.
  delete loaded.recentDays;
  // A replaced file is removed now, with no recovery folder and no days to keep it.
  delete loaded.recoveryDays;
  // The upgrades were a setting of the whole library. They are gone.
  delete loaded.upgrades;
  // The default profile is the first profile of the chain now.
  const { defaultPreset, ...settings } = loaded;
  // An older file has one client with a download folder. That client becomes the first of the list, and it owns the downloads that are open.
  const { downloadClient: old, webhook: oldWebhook, ...rest } = data as Data & { downloadClient?: OneClient | null; webhook?: { url: string | null } | null };
  const profiles = data.profiles && Object.keys(data.profiles).length ? data.profiles : defaultProfiles();
  // An older file has no order: its default profile comes first, then the other profiles in the order of the object.
  const stored = (data.profileOrder ?? []).filter((id) => Object.hasOwn(profiles, id));
  const profileOrder = [...stored];
  if (!data.profileOrder && defaultPreset && Object.hasOwn(profiles, defaultPreset)) profileOrder.push(defaultPreset);
  for (const id of Object.keys(profiles)) if (!profileOrder.includes(id)) profileOrder.push(id);
  // The one destination of an older file becomes one webhook for each event of the queue.
  const webhooks = [...(data.webhooks ?? [])];
  if (oldWebhook?.url) for (const type of ['available', 'stuck'] as const) webhooks.push({ id: randomUUID(), type, url: oldWebhook.url });
  const next: Data = {
    ...empty,
    ...rest,
    // An older file becomes current. A newer file stays newer, so the start refuses it.
    schemaVersion: Math.max(SCHEMA_VERSION, data.schemaVersion ?? 0),
    settings,
    profiles,
    profileOrder,
    webhooks,
  };
  if (old) {
    const url = new URL(old.url);
    const id = randomUUID();
    next.downloadClients = [
      {
        id,
        name: 'qBittorrent',
        type: 'qbittorrent',
        host: `${url.protocol === 'https:' ? 'https://' : ''}${url.hostname}${url.pathname.replace(/\/+$/, '')}`,
        port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80),
        auth: { type: 'password', username: old.username, password: old.password },
        enabled: true,
        maxDownloads: 0,
      },
    ];
    for (const entry of Object.values(next.queue)) if (entry.transferHash && !entry.clientId) entry.clientId = id;
    for (const journal of Object.values(next.imports)) if (!journal.sourceBase && !journal.downloadBase) Object.assign(journal, { clientId: id, downloadBase: old.downloadPath });
  }
  // A client that was saved before the kinds existed is a qBittorrent client.
  for (const client of next.downloadClients) client.type ??= 'qbittorrent';
  // A client that was saved before the limit existed has no limit.
  for (const client of next.downloadClients) client.maxDownloads ??= 0;
  // The recovery folder is gone, so its job goes too.
  for (const job of Object.values(next.jobs)) if (job.type === 'import.clean') delete next.jobs[job.id];
  // An older file had a branch for a target that stopped. The reason stays, and the stage shows the state.
  for (const entry of Object.values(next.queue)) {
    if ((entry.branch as string | null) === 'attention') entry.branch = null;
    for (const event of entry.history ?? []) if ((event.branch as string | null) === 'attention') event.branch = null;
  }
  return next;
}

// The fields that hold the work of the queue. They live in a file of their own, separate from the app data.
const QUEUE_KEYS = ['queue', 'queueRev', 'queuePaused', 'jobs', 'jobSeq', 'prioritySeq'] as const satisfies readonly (keyof Data)[];
type QueueData = Pick<Data, (typeof QUEUE_KEYS)[number]>;

export const QUEUE_FILE = 'queue.json';

const queueDataOf = (data: Data): QueueData => ({
  queue: data.queue,
  queueRev: data.queueRev,
  queuePaused: data.queuePaused,
  jobs: data.jobs,
  jobSeq: data.jobSeq,
  prioritySeq: data.prioritySeq,
});

const appDataOf = (data: Data): Omit<Data, keyof QueueData> => {
  const { queue: _queue, queueRev: _queueRev, queuePaused: _queuePaused, jobs: _jobs, jobSeq: _jobSeq, prioritySeq: _prioritySeq, ...app } = data;
  return app;
};

// The app data in db.json and the work of the queue in queue.json. A file of the version that kept both in
// db.json still reads: its queue fields count until queue.json exists.
class SplitJSONFile implements Adapter<Data> {
  #app: TextFile;
  #queue: TextFile;
  constructor(file: string, queueFile: string) {
    this.#app = new TextFile(file);
    this.#queue = new TextFile(queueFile);
  }
  async read(): Promise<Data | null> {
    const text = await this.#app.read();
    if (text === null) return null;
    const app = JSON.parse(text) as Data;
    // A db.json that still holds the queue fields is a full snapshot, such as a restored backup. It wins.
    if (QUEUE_KEYS.some((key) => key in app)) return app;
    const queue = await this.#queue.read();
    return queue === null ? app : { ...app, ...(JSON.parse(queue) as Partial<QueueData>) };
  }
  async write(data: Data): Promise<void> {
    // The queue first: if the second write fails, the old app data still matches the queue on the disk.
    await this.#queue.write(JSON.stringify(queueDataOf(data), null, 2));
    await this.#app.write(JSON.stringify(appDataOf(data), null, 2));
  }
}

// lowdb switches to an in-memory adapter when NODE_ENV is "test".
export async function openDb(file: string, queueFile = join(dirname(file), QUEUE_FILE)): Promise<Db> {
  const adapter = process.env.NODE_ENV === 'test' ? new Memory<Data>() : new SplitJSONFile(file, queueFile);
  const db = new Low<Data>(adapter, emptyData());
  await db.read();
  db.data = withDefaults(db.data);
  return db;
}

// Every change in one tick, or during a running write, costs one more file write at most.
export function createSaver(db: Db) {
  let running: Promise<void> | undefined;
  let dirty = false;
  const run = async () => {
    try {
      do {
        await Promise.resolve();
        dirty = false;
        await db.write();
      } while (dirty);
    } finally {
      running = undefined;
    }
  };
  return () => {
    dirty = true;
    return (running ??= run());
  };
}
