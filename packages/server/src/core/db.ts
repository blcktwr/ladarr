import { loadConfig } from '@ladarr/shared/config';
import { Low, Memory, type Adapter } from 'lowdb';
import { TextFile } from 'lowdb/node';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { migrateEmptySeason, migrateQueue, migrateTurns } from '../library/downloads/queue-migrate.ts';
import { DEFAULT_NAMING } from '../library/naming.ts';
import { defaultProfiles, defaultSizes, QUALITY_TABLE_VERSION, unlimitedSizes } from '../library/grab/quality.ts';
import type { Data, Db, OneClient, Profile, QueueData, QueueEntry, Settings } from '../types.ts';
import type { SizeLimits } from '@ladarr/shared/types';

// Change this number when a new version cannot read the file of an old one, or the other way round.
// Version 2 keeps the queue work in queue.json, so an older version must not open the new db.json.
// Version 5 removes the region and the time zone from the settings.
// Version 6 splits the size limits of the qualities into one table for movies and one for series.
// Version 7 keeps one state for each queue target, in place of the stage, the branch, and the reason.
// Version 8 keeps the episode numbering of a series, and the snapshot that each acquisition uses.
// Version 9 keeps one copy of each fetched torrent, and leaves the history of the targets out of the file.
// Version 10 saves one queue turn for each movie or catalog season.
const QUEUE_TURN_VERSION = 10;
export const SCHEMA_VERSION = QUEUE_TURN_VERSION;

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
    language: 'en',
    theme: 'dark',
    defaultRoots: { movie: null, tv: null },
    audio: null,
    naming: { ...DEFAULT_NAMING },
  },
  profiles: defaultProfiles(),
  profileOrder: ['p1080', 'p2160'],
  qualitySizes: { movie: unlimitedSizes(), tv: defaultSizes() },
  qualitySizesVersion: QUALITY_TABLE_VERSION,
  roots: {},
  titles: {},
  ledger: {},
  migrationBatch: null,
  verifications: {},
  files: {},
  indexers: {},
  indexerSeq: 0,
  downloadClients: [],
  queue: {},
  queueItems: {},
  queueItemSeq: 0,
  queueRev: 0,
  queuePaused: false,
  imports: {},
  releaseCoverage: {},
  sentTorrents: {},
  torrents: {},
  calendarFeedToken: null,
  webhooks: [],
  compat: { commandSeq: 0, commands: {} },
  seerr: { requestSeq: 0, requests: {} },
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

// A file from an older version can lack a collection that a newer version added.
export function withDefaults(data: Data): Data {
  const empty = emptyData();
  const loaded = { ...empty.settings, ...data.settings } as Settings & { maxAliases?: number; aliasLanguages?: string[] | null; upgrades?: { enabled: boolean; stopAt: string }; defaultPreset?: string; recentDays?: number; recoveryDays?: number; region?: string; timeZone?: string; keepQueueLogs?: boolean };
  delete loaded.keepQueueLogs;
  // The movie release region and the time zone are gone from the settings.
  delete loaded.region;
  delete loaded.timeZone;
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
  const seerr = { ...empty.seerr, ...(data.seerr ?? {}) };
  // The sizes of an older table are the sizes of the newer table now. The table of the series keeps the values that a
  // person set. The table of the movies starts with no size limit.
  type SizeTables = Data['qualitySizes'];
  const storedSizes = data.qualitySizes as unknown as SizeTables | Record<string, SizeLimits> | undefined;
  const split = storedSizes !== undefined && (Object.hasOwn(storedSizes, 'movie') || Object.hasOwn(storedSizes, 'tv'));
  const tables = split ? (storedSizes as SizeTables) : null;
  const oldTable = split ? undefined : (storedSizes as Record<string, SizeLimits> | undefined);
  const qualitySizes: SizeTables =
    data.qualitySizesVersion === QUALITY_TABLE_VERSION
      ? { movie: { ...unlimitedSizes(), ...(tables?.movie ?? {}) }, tv: { ...defaultSizes(), ...(tables?.tv ?? oldTable ?? {}) } }
      : { movie: unlimitedSizes(), tv: defaultSizes() };
  const next: Data = {
    ...empty,
    ...rest,
    // An older file becomes current. A newer file stays newer, so the start refuses it.
    schemaVersion: Math.max(SCHEMA_VERSION, data.schemaVersion ?? 0),
    settings,
    profiles,
    profileOrder,
    // A quality that a newer version added gets the default sizes.
    qualitySizes,
    qualitySizesVersion: QUALITY_TABLE_VERSION,
    webhooks,
    seerr,
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
  // A release that failed is not kept out of the searches, so the list of the old rule goes.
  delete (next as Data & { blocklist?: unknown }).blocklist;
  // The recovery folder is gone, so its job goes too.
  for (const job of Object.values(next.jobs)) if (job.type === 'import.clean') delete next.jobs[job.id];
  // An older file had a branch for a target that stopped. The state of the entry keeps the reason, and the migration
  // maps the stage, the branch, and the reason of every entry and of every history event.
  migrateQueue(next.queue);
  // A title that an older version saved has no numbering, and neither does its acquisitions. The old inference of the
  // releases is not a confirmed map, so the migration makes no range from it.
  for (const title of Object.values(next.titles)) title.numbering ??= { revision: 0, ranges: [] };
  for (const entry of Object.values(next.queue)) {
    if (entry.numbering) continue;
    // A target of an older version without the old inference keeps the numbering of the catalog. A target that the old
    // inference numbered waits for its map, because the inference is not a confirmed range.
    entry.numbering = entry.release && !entry.continuation ? { revision: 0, ranges: [] } : null;
  }
  // The coverage of an older version came from a numbering that no longer exists. Read the files again.
  for (const [id, held] of Object.entries(next.releaseCoverage)) if (!Number.isInteger(held.numberingRevision)) delete next.releaseCoverage[id];
  // An older file keeps the whole torrent in every target of the pack. Version 9 keeps one copy for each hash.
  for (const entry of Object.values(next.queue)) {
    const source = entry.source as { torrent?: unknown } | null | undefined;
    if (!source || typeof source !== 'object' || typeof source.torrent !== 'string') continue;
    if (entry.transferHash && !next.torrents[entry.transferHash]) next.torrents[entry.transferHash] = source.torrent;
    entry.source = { torrent: true };
  }
  if (!data.queueItems && (data.schemaVersion ?? 0) < QUEUE_TURN_VERSION) migrateTurns(next);
  for (const [id, item] of Object.entries(next.queueItems)) {
    item.entryIds = item.entryIds.filter((entryId) => Object.hasOwn(next.queue, entryId));
    if (!item.entryIds.length) delete next.queueItems[id];
    else migrateEmptySeason(next, item);
  }
  // A copy that no target waits for is of no use.
  const waiting = new Set(Object.values(next.queue).flatMap((entry) => {
    if (entry.release?.uploadPath && (entry.state.kind === 'available' || entry.state.kind === 'cancelled')) entry.source = null;
    const hash = entry.transferHash ?? (entry.release?.uploadPath ? entry.release.infoHash : null);
    return entry.source && hash ? [hash] : [];
  }));
  for (const item of Object.values(next.queueItems)) {
    for (const torrent of Object.values(item.selected)) if (torrent.source) waiting.add(torrent.hash);
  }
  for (const hash of Object.keys(next.torrents)) if (!waiting.has(hash)) delete next.torrents[hash];
  // The history is not in the file. The run starts with none, and the log of each target keeps the events.
  for (const entry of Object.values(next.queue)) entry.history = [];
  return next;
}

// The fields that hold the work of the queue. They live in a file of their own, separate from the app data.
const LEGACY_QUEUE_KEYS = ['queue', 'queueRev', 'queuePaused', 'jobs', 'jobSeq', 'prioritySeq', 'torrents'] as const;
export const QUEUE_KEYS = [...LEGACY_QUEUE_KEYS, 'queueItems', 'queueItemSeq'] as const satisfies readonly (keyof Data)[];

export const QUEUE_FILE = 'queue.json';

// The history of a target stays in memory for the run. The file of the data and the backup leave it out: the log of the
// item holds the same events, and a pack with thousands of targets would grow both with a list that no page reads.
export const queueForFile = (queue: Record<string, QueueEntry>): Record<string, QueueEntry> =>
  Object.fromEntries(Object.entries(queue).map(([id, entry]) => [id, { ...entry, history: [] }]));

const queueDataOf = (data: Data): QueueData => ({
  queue: queueForFile(data.queue),
  queueItems: data.queueItems,
  queueItemSeq: data.queueItemSeq,
  queueRev: data.queueRev,
  queuePaused: data.queuePaused,
  jobs: data.jobs,
  jobSeq: data.jobSeq,
  prioritySeq: data.prioritySeq,
  torrents: data.torrents,
});

const appDataOf = (data: Data): Omit<Data, keyof QueueData> => {
  const { queue: _queue, queueItems: _queueItems, queueItemSeq: _queueItemSeq, queueRev: _queueRev, queuePaused: _queuePaused, jobs: _jobs, jobSeq: _jobSeq, prioritySeq: _prioritySeq, torrents: _torrents, ...app } = data;
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
    if (LEGACY_QUEUE_KEYS.some((key) => key in app)) return app;
    const queue = await this.#queue.read();
    return queue === null ? app : { ...appDataOf(app), ...(JSON.parse(queue) as QueueData) };
  }
  async write(data: Data): Promise<void> {
    // The queue first: if the second write fails, the old app data still matches the queue on the disk.
    // No indentation: it makes the files 40 % bigger, and each write holds the whole text in memory.
    await this.#queue.write(JSON.stringify(queueDataOf(data)));
    await this.#app.write(JSON.stringify(appDataOf(data)));
  }
}

// The process opens one database. Every module reads the same binding.
export let db: Db;

// lowdb switches to an in-memory adapter when NODE_ENV is "test".
export async function open(file?: string, queueFile?: string): Promise<Db> {
  let dbFile = file;
  let queue = queueFile;
  if (!dbFile) {
    const config = loadConfig();
    dbFile = config.dbFile;
    queue ??= config.queueFile;
  }
  queue ??= join(dirname(dbFile), QUEUE_FILE);
  const adapter = process.env.NODE_ENV === 'test' ? new Memory<Data>() : new SplitJSONFile(dbFile, queue);
  const next = new Low<Data>(adapter, emptyData());
  await next.read();
  next.data = withDefaults(next.data);
  db = next;
  return db;
}

// A test can point the singleton at a database that it made itself.
export function set(value: Db) {
  db = value;
}

// Every change in one tick, or during a running write, costs one more file write at most.
export function createSaver() {
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
