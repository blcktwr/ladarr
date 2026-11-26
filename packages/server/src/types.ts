import type { Language, MediaType, Override, WebhookEventType, ClientState, TorrentStatus, TrackerStatus, WANT_KIND, IndexerApp, Policy, RootProblem, AddMode, ImportNote, BackupKind } from '@ladarr/shared/enums';
import type { Phase, QueueState } from '@ladarr/shared/queue';
import type { SizeLimits, QueueClientDetail, IndexerHealth, QualityProfile, UpgradeQuality, ImportCheck, PlanPreview, SearchResult, MigrationRow, Numbering } from '@ladarr/shared/types';
export type { Numbering } from '@ladarr/shared/types';
import type { Low } from 'lowdb';
import type { copyFile as fsCopyFile, link as fsLink, rename as fsRename } from 'node:fs/promises';
import type { QUEUE_KEYS } from './core/db.ts';
import type { createEvents } from './core/events.ts';
import type { enqueue as enqueueJob } from './core/jobs.ts';
import type { createLimiter } from './core/limiter.ts';
import type { EVENT_SCHEMA_VERSION } from './core/webhook.ts';
import type { createPoller } from './library/downloads/poller.ts';
import type { createQbittorrent } from './library/downloads/qbittorrent.ts';
import type { createQueue } from './library/downloads/queue.ts';
import type { createFinder } from './library/grab/finder.ts';
import type { createIndexerService } from './library/grab/torznab.ts';
import type { createImportStatus } from './library/imports/status.ts';
import type { ffprobeRaw, probeFile } from './library/probe.ts';
import type { createTmdb } from './metadata/tmdb.ts';
import type { createRestorer } from './system/restore.ts';

export type Services = { queue: Queue; finder: Finder; poller: Poller; clients: Clients; importStatus?: ImportStatus };
export type AppOptions = { services?: Services; urlBase?: string; events?: Events; webDir?: string; devOrigin?: string; heartbeat?: () => number; tmdb?: Tmdb; configDir?: string; backupDir?: string; enqueue?: (input: EnqueueInput) => ReturnType<typeof enqueueJob>; cancelJob?: (id: string) => void; persist?: () => void; restorer?: Restorer; indexers?: IndexerService; installUpdate?: () => Promise<{ version: string }>; pauseQueue?: () => Promise<void>; resumeQueue?: () => void; restart?: () => void; reset?: () => Promise<void> };
export type Settings = {
  setupCompleted: boolean;
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
  // The import that wrote the entry. The status counts only the entries of the current import.
  batch?: string;
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
  // The source torrent and the path inside it. An external torrent belongs to the user.
  download?: { clientId: string; hash: string; external: boolean; name?: string; file?: string } | null;
  association?: {
    source: 'manual' | 'numbering' | 'automatic';
    originalName: string;
    numberingRevision: number;
    identity: { sizeBytes: number; mtimeMs: number; dev?: number; ino?: number };
  };
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
  // The quality profiles, keyed by ID. The sizes are keyed by the media type and the ID of a quality. See quality.ts.
  profiles: Record<string, Profile>;
  // The IDs of the profiles, the best first. A search tries them in this order.
  profileOrder: string[];
  qualitySizes: Record<MediaType, Record<string, SizeLimits>>;
  // The version of the table that set the sizes. A new version replaces them, so an update takes priority.
  qualitySizesVersion: number;
  roots: Record<string, Root>;
  // Keyed by media type and TMDB ID, for example "tv:1396".
  titles: Record<string, Title>;
  // Keyed by the namespace of the source and the ID in the source, for example "sonarr:1a2b3c4d:57".
  ledger: Record<string, LedgerEntry>;
  // The ID of the import whose titles are going into the library now. The status counts only its entries.
  migrationBatch: string | null;
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
  queueItems: Record<string, QueueTurn>;
  queueItemSeq: number;
  // Rises with each change of an entry. SSE messages and snapshots carry it.
  queueRev: number;
  // The user paused the queue: no new queue work starts, and the running work ends.
  queuePaused: boolean;
  // The steps of the imports that are not done. See importer.ts.
  imports: Record<string, ImportJournal>;
  // The episodes that the files of a release held, keyed by `<indexer ID>:<GUID>`. A pack can hold fewer episodes than
  // TMDB gives its season, so a later search reads this record instead of the count of the season. The record belongs to
  // the numbering revision that read the files.
  releaseCoverage: Record<string, { titleKey: string; season: number; numbers: number[]; numberingRevision: number }>;
  // The torrents that ladarr sent to a client, keyed by info hash. A torrent in this record belongs to the app, also
  // when its target searches again or the target that sent it is gone. A torrent that the user added is not here.
  sentTorrents: Record<string, number>;
  // The file of each torrent that waits for a slot of the client, keyed by info hash and kept as base64. One copy serves
  // every target of the pack. The entry goes when the client has the torrent.
  torrents: Record<string, string>;
  // The secret in the URL of the iCal feed. Null means that the feed is off.
  calendarFeedToken: string | null;
  // The destinations for events, one for each event type. See webhook.ts.
  webhooks: WebhookState[];
  // The commands that callers of the Sonarr and Radarr adapters sent. The ID is the same after a restart.
  compat: { commandSeq: number; commands: Record<string, CompatCommand> };
  // The requests that callers of the Seerr adapter sent. The ID is the same after a restart.
  seerr: { requestSeq: number; requests: Record<string, SeerrRequest> };
};
export type Db = Low<Data>;
export type OneClient = { url: string; username: string; password: string; downloadPath: string };
export type QueueData = Pick<Data, (typeof QUEUE_KEYS)[number]>;
export type Entry = { seq: number; type: string; data: unknown };
export type Events = ReturnType<typeof createEvents>;
export type HttpOptions = {
  // Replaces the address in the log. A webhook address can hold a token.
  path?: string;
  // False leaves the query out of the log.
  query?: boolean;
  // Ties the entry to the log line that caused the request.
  requestId?: string;
};
export type ErrorKind = 'invalid_input' | 'outage' | 'uncertain';
export type Job = {
  id: string;
  type: string;
  payloadVersion: number;
  payload: unknown;
  dedupeKey: string | null;
  state: 'waiting' | 'running' | 'failed';
  seq: number;
  runAt: number;
  attempts: number;
  // A new token for each claim, so a stale holder cannot finish a job that was recovered.
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  lastError: { kind: ErrorKind; message: string } | null;
  priority: number | null;
};
export type EnqueueInput = {
  type: string;
  payload?: unknown;
  payloadVersion?: number;
  dedupeKey?: string;
  runAt?: number;
  priority?: boolean;
};
export type Waiter = { urgent: boolean; resolve: () => void };
export type Limiter = ReturnType<typeof createLimiter>;
export type Level = 'info' | 'warn' | 'error';
// A catalog log follows a title or one of its targets. A system log is about the server. The two kinds share a file,
// and the type tells them apart.
export type LogType = 'system' | 'catalog';
export type ItemFields = {
  itemId: string;
  itemType: string;
  titleKey: string;
  title: string;
  // The part of the title that the log follows: "Movie", "Series", or "S01E02".
  target: string;
  episode?: string;
  // The attempt of the target, when it has one.
  attempt?: number;
  // Milliseconds since the target was created, so a reader sees the order and the wait of each step.
  sinceCreatedMs?: number;
  // The stage or the branch of the item, when the log is an update of it.
  status?: string;
};
export type QueueItem = { id: string; titleKey: string; season: number | null; number: number | null; attempt: number; createdAt: number };
export type LogFilter = { itemId?: string; itemType?: string; titleKey?: string; kind?: 'logs' | 'requests'; type?: LogType; requestId?: string };
// One request that the server sent. The id ties the line of the request to the log of the work that sent it.
export type OutboundRequest = { requestId: string; system: string };
export type Work = { requests: OutboundRequest[]; ids: Map<string, string> };
// What the user reads when a target waits or stops, and the action that helps.
// The code is stable. The message is the key of the web i18n. The webhook sends the English text.
export type ReasonAction = 'retry' | 'match' | 'attach' | 'settings' | 'none' | 'numbering';
export type ReasonInfo = { message: string; action: ReasonAction; settings?: 'client' | 'indexers' | 'library' };
// The destination of one event type. The address is a secret, because it can hold a token.
// It never goes to a log or to an API answer.
export type WebhookState = { id: string; type: WebhookEventType; url: string };
export type EventType = WebhookEventType | 'test';
export type WebhookEvent = {
  schemaVersion: typeof EVENT_SCHEMA_VERSION;
  id: string;
  type: EventType;
  timestamp: string;
  title: { key: string; mediaType: MediaType; name: string | null; year: number | null; ids: { tmdb: number; tvdb: number | null; imdb: string | null } } | null;
  episode: { season: number; number: number; name: string | null } | null;
  reason: { code: string; message: string } | null;
  problem: { id: string; message: string } | null;
};
// The delivery job of one webhook. The event is the same for each webhook of its type.
export type DeliveryPayload = { webhookId: string; event: WebhookEvent };
export type WebhookDeps = {
  enqueue: (input: EnqueueInput) => unknown;
  now?: () => number;
};
export type Handler = {
  run: (job: Job, ctx: { signal: AbortSignal }) => Promise<void>;
  // Most jobs of this type that run at the same time.
  concurrency?: number;
  // Does not take a slot of the shared limit, so a slow job of this type never makes other work wait.
  separate?: boolean;
  // A job of this type waits while the handler says no. The worker asks again at each start of work.
  canStart?: (job: Job) => boolean;
  maxAttempts?: number;
  // Run again this many ms after each final result. A job still waiting or running holds the next run back.
  every?: number;
};
export type WorkerOptions = { tickMs?: number; leaseMs?: number; concurrency?: number; graceMs?: number };
export type Resource = Record<string, unknown>;
export type AttachCache = Map<string, { at: number; value: Promise<QueueClientDetail | null> }>;
export type Filters = { key?: string; type?: string; q?: string; priority: boolean; cleared: boolean };
// A row of the list before the page cuts it: one season of a series, one movie, or a series that waits for its episodes.
export type RowGroup = {
  key: string;
  title: Title;
  season: number | null;
  entries: QueueEntry[];
  matching: number;
  first: number;
  progress: number;
  part: number;
  download: number;
  ready: boolean;
  searching: boolean;
  upcoming: boolean;
  notFound: boolean;
  pending: boolean;
};
export type IndexDeps = {
  backupDir: string;
  events: Events;
  save: () => Promise<void>;
  tmdb?: Tmdb;
  enqueue: (input: EnqueueInput) => Job;
  clients: Clients;
  queue: Queue;
  finder: Finder;
  indexers: IndexerService;
  importStatus: ImportStatus;
};
export type LibrarySearchDeps = { finder: Finder; enqueue: (input: EnqueueInput) => Job };
export type LibraryVerifyDeps = { queue: Queue; clients: Clients; finder: Finder; events: Events; enqueue: (input: EnqueueInput) => Job };
export type QueueRetryDeps = { queue: Queue; finder: Finder; clients: Clients; enqueue: (input: EnqueueInput) => Job; events: Events };
// A plan of the kind `upgrades` comes from the Upgrade button of a title page. It searches the files below a quality
// for a release of exactly that quality. Other plans look for the missing files.
export type BulkSearchPayload = { planId: string; keys: string[]; offset: number; kind?: 'search' | 'upgrades'; quality?: string };
// `limit` cuts the list of events. The JSON answer has a limit. The feed has none, because a cut feed looks complete.
export type CalendarQuery = { from: string; to: string; type?: MediaType; monitored: boolean; limit?: number };
export type CatalogEpisode = {
  season: number;
  number: number;
  name: string;
  // "1998-02-18". The episodes of one airing share it.
  airDate: string | null;
  // The minutes of this segment. Null when TMDB does not give it.
  runtime: number | null;
};
// What one file of a download says about itself.
export type FileEvidence = {
  // The file in the download, relative to its folder.
  path: string;
  // The tag `title`, for example "Aye, Aye, Eyes/Dee Dee and the Man".
  title: string | null;
  // The tags `SEASON_NUMBER` and `EPISODE_ID`. They hold the numbering of the release, not the one of TMDB.
  season: number | null;
  episode: number | null;
  durationSeconds: number | null;
};
// The step of the cascade that gave the answer. A person reads it in the preview, so a weak step is visible.
export type ContentStep = 'whole_title' | 'segments' | 'anchor' | 'global' | 'fuzzy' | 'release_number';
export type ContentProposal = {
  path: string;
  episodes: { season: number; number: number }[];
  step: ContentStep;
  evidence: string;
};
// `conflict`: two steps gave different episodes. `ambiguous`: more than one airing stays possible.
// `no_match`: no step found an airing.
export type ContentRejection = { path: string; reason: 'ambiguous' | 'conflict' | 'no_match'; evidence: string };
export type ContentMatch = { proposals: ContentProposal[]; rejections: ContentRejection[] };
// The episodes that aired as one broadcast, in the order of their numbers.
export type Airing = CatalogEpisode[];
export type ContentContext = {
  episodes: CatalogEpisode[];
  airings: Airing[];
  // The airing of each episode, by its position in `airings`.
  airingOf: Map<CatalogEpisode, number>;
  // The episodes that answer to a normalised name. A name that answers twice can not identify one episode.
  byName: Map<string, CatalogEpisode[]>;
  // The airings that answer to a normalised whole title.
  byWholeTitle: Map<string, Airing[]>;
  // The episode of a season and a number in the catalog.
  byPosition: Map<string, CatalogEpisode>;
  normalized: Map<CatalogEpisode, string>;
};
// The clients that are on. A change of the settings makes the connection of that client again.
// The torrent inventory is one read of the client that every caller shares. A read that runs now serves the callers
// that follow it, so a search, a retry, and a poll do not ask the client for the same list.
export type Clients = {
  all: () => ClientHandle[];
  get: (id: string | null | undefined) => ClientHandle | undefined;
  // The client that gets the next download: the first one of the list.
  next: () => ClientHandle | undefined;
  // Every torrent of the client, complete or not. `fresh` asks the client again, also when a read is recent.
  list: (handle: ClientHandle, options?: { fresh?: boolean }) => Promise<Torrent[]>;
  // One torrent by hash, from the shared inventory.
  find: (handle: ClientHandle, hash: string) => Promise<Torrent | null>;
  // The torrents with these hashes, from the shared inventory.
  byHashes: (handle: ClientHandle, hashes: string[]) => Promise<Torrent[]>;
  // The next read asks the client again. A caller uses it when a change of the client must be visible at once.
  invalidate: (handle: ClientHandle) => void;
};
export type ClientCheck = ClientState;
// What the client reported about one torrent at the last good poll. One torrent is one transfer,
// even when it covers many entries, so its bytes and rate count once.
export type Transfer = {
  hash: string;
  name: string;
  observedAt: number;
  sizeBytes: number;
  progress: number;
  downloadRate: number;
  etaSeconds: number | null;
  status: TorrentStatus;
  complete: boolean;
  seeds: number;
  peers: number;
  entryIds: string[];
  // The part of the torrent that each target has, from the file of that target. A pack downloads one file before
  // another, so the part of the torrent is not the part of each episode. Null when there is no part of a file.
  entryProgress: Record<string, number> | null;
  // The file of each target in the torrent: its name and its size.
  entryFiles: Record<string, { name: string; sizeBytes: number }> | null;
  // True when the last poll failed. The numbers are the last known ones.
  stale: boolean;
};
export type ClientStatus = { state: ClientState; lastOkAt: number | null };
export type PollerDeps = {
  queue: Queue;
  events: Events;
  clients: Clients;
  enqueue: (input: EnqueueInput) => Job;
  intervalMs?: number;
};
export type Poller = ReturnType<typeof createPoller>;
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
export type QbittorrentErrorCode = 'rejected' | 'unreachable' | 'unexpected';
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
export type QbittorrentOptions = { fetch?: typeof fetch; timeoutMs?: number };
export type Qbittorrent = ReturnType<typeof createQbittorrent>;
// What the rest of the server needs from a client: its ID, the connection, and its settings.
export type ClientHandle = { id: string; api: Qbittorrent; config: ClientConfig };
// The fields of an older entry. Version 6 and earlier kept the stage, the branch, and the reason as separate fields.
export type LegacyEntry = QueueEntry & {
  stage?: string;
  branch?: string | null;
  reason?: { code: string; detail?: string } | null;
  stageSince?: number;
  history?: (HistoryEvent & { branch?: string | null })[];
};
export type StoredEvent = HistoryEvent & { branch?: string | null };
// The journey of a target, kept as one state. A caller never writes a stage, a branch, or a reason by itself: it asks
// for an operation, and the operation checks the change and leaves a record.
export type Stage = Phase;
export type Covered = EpisodeRef;
// The release that an entry has. A pack gives the same release to several entries.
export type ReleaseRef = {
  guid: string;
  indexerId: number;
  indexerName: string;
  title: string;
  sizeBytes: number;
  infoHash: string | null;
  link: string | null;
  magnet: string | null;
  kind: 'single' | 'multi' | 'pack';
  seeders: number | null;
  manual: boolean;
  // The comment of the torrent file, when the indexer sent one. A magnet has none.
  comment?: string;
  // The share limits that the indexer asked for when ladarr chose the release. Old entries lack it.
  seed?: { ratio: number | null; minutes: number | null } | null;
  // The download was already in the client when ladarr attached it.
  external?: boolean;
  uploadPath?: string;
  uploadOwner?: string;
};
export type Attempt = {
  n: number;
  startedAt: number;
  endedAt: number | null;
  // Why the attempt started: the first request, a retry, or the fallback after a bad release.
  reason: string;
  release: string | null;
  outcome: 'running' | 'imported' | 'failed' | 'cancelled';
  detail?: string;
};
// One change of the state. `stage` repeats the phase, so a reader of an old record and the item log keep the same line.
export type HistoryEvent = { at: number; state: QueueState; stage: Phase; attempt: number; cause: string; detail?: string };
// A release of the last search that was rejected. A person can take it by hand. The link stays on the server: it
// carries the API key.
export type RejectedRelease = {
  manifestProblem?: 'pack_partial' | 'file_unmapped';
  indexerId: number;
  guid: string;
  title: string;
  link: string | null;
  magnet: string | null;
  infoHash: string | null;
  sizeBytes: number;
  seeders: number | null;
  resolution: number | null;
  source: string;
  kind: 'single' | 'multi' | 'pack';
  reasons: string[];
  // The size check that stopped the release, with the numbers. Null when the size did not stop it.
  sizeRejection: { code: 'size_below_min' | 'size_above_max'; value: number; limit: number } | null;
};
export type SearchState = {
  at: number;
  indexers: { id: number; name: string; state: 'waiting' | 'done' | 'failed' | 'skipped'; count: number | null; error?: string }[];
  candidates: number;
  accepted: number;
  result: 'grabbed' | 'deferred' | 'no_results' | 'all_rejected' | 'indexers_failed' | null;
  // The rejection codes that stopped the most releases, most frequent first.
  topRejections: string[];
  nextAt: number | null;
  // The releases that only the preferences rejected, so a person can pick one for a manual download.
  rejected: RejectedRelease[];
};
export type ImportResult = { at: number; ok: boolean; method: 'hardlink' | 'copy' | null; path: string | null; validation: 'ffprobe' | 'basic'; detail?: string };
export type QueueTorrent = {
  hash: string;
  release: ReleaseRef;
  source: NonNullable<QueueEntry['source']> | null;
  numberingRevision: number | null;
  matches: Record<string, string | null>;
  manifest?: string[];
  manualMatches?: Record<string, EpisodeRef[]>;
  clientId: string | null;
  status: 'verify' | 'prepared' | 'uncertain' | 'accepted';
  addTag?: string;
};
export type QueueTurn = {
  id: string;
  titleKey: string;
  season: number | null;
  entryIds: string[];
  state: QueueState;
  position: number;
  priority: number | null;
  createdAt: number;
  stateSince: number;
  revision: number;
  nextAt: number | null;
  clientHold: boolean;
  emptySearches: Record<string, number>;
  lastEmptyRound: string | null;
  candidate: ReleaseRef | null;
  selected: Record<string, QueueTorrent>;
  search: SearchState | null;
};
export type QueueEntry = {
  // "movie:603" or "tv:1396:1x2". The same target always has the same ID.
  id: string;
  titleKey: string;
  season: number | null;
  number: number | null;
  // The progress of this target. The queue item controls the search turn.
  state: QueueState;
  // Rises with each change. A message with an older number is stale.
  revision: number;
  createdAt: number;
  // When the target entered its current state, including a block.
  stateSince: number;
  // When the target entered its current phase, so the poller keeps its grace period after a block clears.
  phaseSince: number;
  completedAt: number | null;
  // Set by Clear. The entry leaves the main view and stays in the history.
  clearedAt: number | null;
  // Position in the priority lane, or null for the normal lane.
  priority: number | null;
  attempt: number;
  attempts: Attempt[];
  history: HistoryEvent[];
  search: SearchState | null;
  release: ReleaseRef | null;
  transferHash: string | null;
  // The download client that has the torrent. Set with the hash.
  clientId: string | null;
  // The torrent source that the fetch got. The target keeps it while it waits for a slot of the client, so a wait,
  // a retry, or a restart does not download the release from the indexer again. The whole file is one copy for each
  // hash in `Data.torrents`: a pack has one target for each episode, and a copy in every one of them is wasted.
  source?: { torrent: true } | { magnet: string } | null;
  // The automatic import attempts that failed. It is separate from the attempts of the search. A manual retry does
  // not change it.
  importTries?: number;
  // Set when the user chose the file by hand. The import and the retries keep it.
  manualMatch: { file: string; covers: Covered[] } | null;
  manualMatchRevision?: number;
  // Set when the user chose to replace the file that holds the destination name. The importer clears it.
  replaceDestination?: boolean;
  importResult: ImportResult | null;
  // The numbering that the acquisition uses. It is saved with the release and stays through the download and the
  // import, so a change of the title cannot reinterpret the same torrent. Null before a release is selected.
  numbering?: Numbering | null;
  // Set when the releases count as two seasons what the title counts as one. The targets of the rest of the season then
  // search the next season of the release. Null or absent for the numbering of the title. It is the numbering of an
  // older version: the ranges of the title replace it.
  continuation?: Continuation | null;
  // The files of the pack that left this target without one: the season of the release and the numbers of the episodes
  // that it holds. The manual search of the other seasons reads the candidate seasons from it.
  partialPack?: { releaseSeason: number | null; numbers: number[] } | null;
};
// `onState` runs after each change of the state, with the state from before the change.
export type StateHook = (entry: QueueEntry, before: QueueState) => void;
export type Queue = ReturnType<typeof createQueue>;
// What a search looks for. A season want accepts a pack only.
// `upgradeQuality` is the quality of a manual upgrade. The want then accepts a release of exactly that quality.
// `numbering` is the numbering snapshot of the search, so a later edit of the title does not change the decision.
// `releaseSeason` is the season of the release that a season want asks for. It differs from the catalog season when
// the release counts the seasons in another way.
export type Want =
  | { kind: typeof WANT_KIND.movie; title: Title; upgradeQuality?: string }
  | { kind: typeof WANT_KIND.episode; title: Title; season: number; number: number; upgradeQuality?: string; numbering?: Numbering }
  | { kind: typeof WANT_KIND.season; title: Title; season: number; releaseSeason?: number; numbering?: Numbering };
export type DecideContext = {
  settings: Settings;
  // The quality profiles and the sizes of the qualities.
  quality: Pick<Data, 'profiles' | 'profileOrder' | 'qualitySizes'>;
  // The indexers by ID. A release from an indexer that is gone is rejected.
  indexers: Record<string, Indexer>;
  // True when an active queue entry has this hash already.
  downloading: (hash: string) => boolean;
  hasFile: (episode: Episode) => boolean;
  hasMovieFile: (title: Title) => boolean;
  // The episodes that the files of this release held, when ladarr read them before.
  coverage: (release: RawRelease) => Data['releaseCoverage'][string] | null;
  now: number;
  // A manual choice accepts any release, including one that fails identity or policy checks.
  manual?: boolean;
};
export type Decision = {
  release: RawRelease;
  parsed: ParsedRelease;
  rejections: string[];
  accepted: boolean;
  kind: 'single' | 'multi' | 'pack';
  covers: Covered[];
  // The numbering snapshot that the decision used. Null for a movie.
  numbering: Numbering | null;
  mibPerMinute: number | null;
  // The rank of the release in the profile of the title. A lower rank is better.
  rank: number;
  indexerPriority: number;
  // The distance from the preferred size. Null when the quality has no preferred size.
  distance: number | null;
  hash: string | null;
  // The quality that a manual upgrade asks for, so its reason can name it.
  upgradeQuality: string | null;
  // The quality that the release has, or null when its name does not say.
  quality: string | null;
  // The size limits of that quality in the profile. Null when the profile does not take the quality.
  limits: SizeLimits | null;
};
export type ExplainedDecision = {
  release: string;
  indexer: string;
  quality: string;
  sizeBytes: number;
  sizePerMinute: number | null;
  seeders: number | null;
  accepted: boolean;
  reasons: { code: string; text: string; detail?: string }[];
};
export type Scope = { kind: 'movie' } | { kind: 'season'; season: number } | { kind: 'episode'; season: number; number: number } | { kind: 'absolute'; number: number };
export type TitleName = { value: string; alias: boolean; languages: string[] };
// The work that a search run left for the next run after it reached its budget. The phase and the target say where
// the next run continues: the season queries run again from the cache, and the individual queries start at this target.
export type SearchResume = { phase: 'episode' | 'absolute'; entryId: string };
// `fresh` skips the cache of raw results. A search that the user asks for is fresh. `manual` marks a target that the
// user selected, so its individual query runs whatever the age of the episode. `otherSeasons` marks the manual search
// of the other seasons of the releases: it has its own jobs and it never merges with a normal search.
export type SearchPayload = { itemId?: string; titleKey: string; season: number | null; entryIds: string[]; fresh?: boolean; manual?: boolean; otherSeasons?: boolean; resume?: SearchResume };
export type FinderDeps = {
  queue: Queue;
  indexers: IndexerService;
  enqueue: (input: EnqueueInput) => Job;
  // The download client, so a torrent that already holds the files of a folder stays with the target.
  clients?: Clients;
  now?: () => number;
};
export type Finder = ReturnType<typeof createFinder>;
export type GrabberDeps = {
  queue: Queue;
  finder: Finder;
  indexers: IndexerService;
  clients: Clients;
  save: () => Promise<void>;
  enqueue: (input: EnqueueInput) => Job;
  // The wait between two reads of the client after an add with an unknown result.
  reconcileMs?: number;
};
// What the indexer manager pushed for one app. The indexer manager owns these values. ladarr only reads them.
export type IndexerPush = {
  name: string;
  enableRss: boolean;
  enableAutomaticSearch: boolean;
  enableInteractiveSearch: boolean;
  priority: number;
  categories: number[];
  animeCategories: number[];
  minimumSeeders: number;
  tags: number[];
  // The ID of a download client of the app. Null or 0 means the default client. Old records lack it.
  downloadClientId?: number | null;
  // The other schema fields, as the indexer manager sent them. ladarr sends them back unchanged, so the indexer manager sees no difference.
  fields: Record<string, unknown>;
};
export type Protocol = 'torrent' | 'usenet';
// The search modes of the indexer. Each mode lists the query parameters that it accepts, or is null when it is not available.
export type Caps = { search: string[] | null; tv: string[] | null; movie: string[] | null; categories: number[] };
export type Indexer = {
  id: number;
  baseUrl: string;
  apiPath: string;
  apiKey: string;
  // The delay and the preferred languages are the fields that ladarr owns.
  // The least time, in seconds, between two requests that start.
  delaySeconds: number;
  // The languages of the names that the indexer should receive. No languages means every language.
  preferredLanguages?: string[];
  // Reject a release that the indexer reports with no seeders, so the target does not wait on a torrent that cannot download.
  rejectZeroSeeders?: boolean;
  // The limiter keeps this time in the database, so a restart does not shorten the delay.
  nextRequestAt: number;
  push: Partial<Record<IndexerApp, IndexerPush>>;
  // Old records lack it. They are torrent indexers.
  protocol?: Protocol;
  // The user added the indexer in Settings. The indexer manager did not push it, so the user can change all of its fields.
  manual?: true;
  caps: Caps | null;
  capsAt: number;
  health: IndexerHealth;
};
export type Field = { order: number; name: string; label: string; type: string; advanced: boolean; privacy: string; default: unknown };
// The share limits that the indexer asks for. The indexer manager sends the time in minutes, like qBittorrent.
export type SeedLimits = { ratio: number | null; minutes: number | null };
export type Rejected = { propertyName: string; errorMessage: string; severity: 'error' }[];
export type Parsed = { baseUrl: string; apiPath: string; apiKey: string | null; protocol: Protocol; push: IndexerPush };
export type Source = 'webdl' | 'webrip' | 'bluray' | 'remux' | 'rawhd' | 'hdtv' | 'sdtv' | 'dvd';
export type ReleaseSource = Source | 'cam' | 'telesync' | 'unknown';
// A quality is a source with a resolution. A DVD has no resolution.
export type GrabQuality = { id: string; label: string; source: Source; resolution: number | null };
// A profile lists the qualities that ladarr takes, the best first. The qualities of one group have the same rank.
// A quality that is in no group is not taken.
export type Profile = QualityProfile;
export type Release = {
  source: ReleaseSource;
  resolution: number | null;
  sizeBytes: number;
  // Null when the release does not say which audio it has.
  audioLanguages: string[] | null;
};
export type Rejection = 'quality_rejected' | 'quality_not_in_profile' | 'size_below_min' | 'size_above_max' | 'audio_unverified' | 'audio_language_missing';
export type Evaluation = {
  accepted: boolean;
  rejections: Rejection[];
  // A check that could not run, so the user sees the constraint that is missing.
  unchecked: 'size'[];
  // Lower is better. Null when the profile does not take the release.
  rank: number | null;
  mibPerMinute: number | null;
  limits: SizeLimits | null;
};
export type ParsedRelease = {
  // The words before the first marker, as the release spells them.
  title: string;
  year: number | null;
  season: number | null;
  episodes: number[];
  // True when the release is a whole season: it has a season and no episode.
  pack: boolean;
  // True when the season is split and the release holds one part of it.
  part: boolean;
  // More than one season in one release. ladarr does not take these in the MVP.
  multiSeason: boolean;
  // The absolute number of an anime release, which no season and episode give.
  absolute: number | null;
  // YYYY-MM-DD for a daily show.
  airDate: string | null;
  resolution: number | null;
  source: ReleaseSource;
  group: string | null;
  // Null when the name does not say which audio the release has.
  audioLanguages: string[] | null;
};
// One result of a search or of the RSS feed, before any decision.
export type RawRelease = {
  indexerId: number;
  guid: string;
  title: string;
  // The address of the .torrent file, usually through the indexer manager.
  link: string | null;
  magnet: string | null;
  infoHash: string | null;
  sizeBytes: number;
  publishedAt: number | null;
  seeders: number | null;
  peers: number | null;
  categories: number[];
};
export type TorznabErrorCode = 'rejected' | 'unavailable' | 'invalid_response';
export type SearchQuery = {
  kind: 'search' | 'tv' | 'movie';
  q?: string;
  season?: number;
  ep?: number;
  year?: number;
  imdbId?: string;
  tmdbId?: number;
  tvdbId?: number;
  categories: number[];
  limit?: number;
};
export type TorznabOptions = { fetch?: typeof fetch; timeoutMs?: number };
export type IndexerService = ReturnType<typeof createIndexerService>;
// A file of a title that an upgrade can replace. The file holds one episode and its quality is known.
export type UpgradeFile = { title: Title; season: number | null; number: number | null; file: MediaFile; source: ReleaseSource; resolution: number };
// The qualities that the chain defines, the best first. A quality that more than one profile defines keeps the rank of
// the first one.
export type ChainQuality = UpgradeQuality & { rank: number; resolution: number | null };
export type Listed = { path: string; sizeBytes: number };
// One file of an import. The steps of a file go in this order, and each step is saved before the next one starts:
// planned -> staged (a hard link or a copy next to the destination) -> published (the final name)
// -> committed (the library record) -> retired (the file that it replaced is gone).
export type JournalStep = {
  entryIds: string[];
  // The file in the download folder, relative to the download folder.
  source: string;
  // The new file, relative to the root of the title.
  dest: string;
  // The file that this one replaces, relative to the root of the title.
  replaces: string | null;
  state: 'planned' | 'staged' | 'published' | 'committed' | 'retired';
  method: 'hardlink' | 'copy' | null;
  sizeBytes: number;
  episodes: { season: number; number: number }[];
  validation: 'ffprobe' | 'basic';
  association?: { source: 'manual' | 'numbering' | 'automatic'; originalName: string; numberingRevision: number };
  sourceIdentity?: { sizeBytes: number; mtimeMs: number; dev?: number; ino?: number };
  stagedIdentity?: { sizeBytes: number; mtimeMs: number; dev?: number; ino?: number };
  // The inputs must stay the same until the step commits.
  expected?: { entries: Record<string, string>; library: string };
};
// A journal of a download has the hash of the torrent, the client that has it, and the folder of the download (`downloadBase`). It has no `sourceBase`. The other journals have a folder as source:
// a manual import reads a folder that the user named, and a rename reads the root of the title (`kind: 'rename'`).
// An import from a download folder is link only: it never copies. It asks for a search when its files are in, so the
// episodes that it did not bring still get a release.
export type ImportJournal = { id: string; hash: string; torrentName?: string; titleKey: string; steps: JournalStep[]; createdAt: number; kind?: 'rename'; sourceBase?: string; clientId?: string; downloadBase?: string; linkOnly?: true; searchOnFinish?: true; upload?: true; correction?: CorrectionCommit };
export type Fs = { link: typeof fsLink; copyFile: typeof fsCopyFile; rename: typeof fsRename };
export type ImporterDeps = {
  queue: Queue;
  events: Events;
  clients: Clients;
  save: () => Promise<void>;
  probe?: (path: string) => Promise<ProbeResult>;
  status?: ImportStatus;
  // The targets of a pack whose files it does not hold go back to the search. The pack stays good for its other targets.
  partial?: (entries: QueueEntry[], missing: QueueEntry[], detail: { files: number }) => void;
  // How long a check stays in `running` before its work starts. Slow work keeps it there until it ends.
  checkDelayMs?: number;
  // For tests: replace a file operation, or stop after a step to test a restart.
  fs?: Partial<Fs>;
  afterStep?: (state: JournalStep['state'], step: JournalStep) => void | Promise<void>;
  now?: () => number;
};
export type ImportDeps = ImporterDeps;
export type ImporterFound = { abs: string; rel: string; sizeBytes: number };
export type LocalResult = { imported: string[]; blocked: string[] };
export type Selection = { file: InventoryFile; entries: QueueEntry[]; episodes: EpisodeRef[] };
export type PlanInput = {
  title: Title;
  rootReal: string;
  real: string;
  videos: ImporterFound[];
  replace: boolean;
  // An import from a download folder never copies: a file on another disk can not be linked, so it is blocked.
  linkOnly?: boolean;
};
export type CopyProgress = { journalId: string; dest: string; entryIds: string[]; copiedBytes: number; totalBytes: number; observedAt: number };
// A check run of an import. One list belongs to the whole group, so every target of a pack shows the same checks.
export type CheckRun = { entryIds: string[]; checks: ImportCheck[] };
export type CheckResult = { code: string; detail?: string };
export type ImportStatus = ReturnType<typeof createImportStatus>;
// The TMDB part replaces on each refresh. `override` and `fileId` belong to ladarr, so a refresh keeps them.
export type Episode = EpisodeMeta & { override: Override | null; fileId: string | null; removedFromTmdb?: true };
// `meta` holds the TMDB facts. Every other field is a choice of the user or a fact of ladarr,
// and a refresh never changes it. This keeps a refresh from changing a policy.
export type Title = {
  key: string;
  mediaType: MediaType;
  tmdbId: number;
  meta: TitleMeta;
  // Null while the refresh job fetches the TMDB facts of a title that entered the queue first.
  // A record from before this field always has the facts, so it lacks the field.
  metaLoadedAt?: number | null;
  refreshedAt: number;
  addedAt: number;
  // Paused is a control state. It does not change the policy that applies after a resume.
  paused: boolean;
  policy: Policy;
  // With the Future policy, an episode is monitored when it airs at this time or later.
  futureFrom: number;
  seriesType: 'standard' | 'anime';
  // Null uses the default preset of the settings.
  preset: string | null;
  rootId: string;
  // How the releases number the seasons and the episodes. A record from before this field has no ranges.
  numbering?: Numbering;
  // The folder of the title, relative to its root. Null until a folder is known.
  folder: string | null;
  // A movie with this flag can be searched before a known digital or physical release date.
  manualRelease: boolean;
  seasonOverrides: Record<string, Override>;
  // Null until the first refresh has fetched the seasons.
  episodesLoadedAt: number | null;
  episodes: Episode[];
  // The managed file of a movie.
  fileId: string | null;
};
// A file that is gone from the disk does not make an episode or a movie available.
export type Clock = { now: number; files: Record<string, { missing: boolean }> };
export type EpisodeRef = { season: number; number: number };
// One file of the title with the episodes that it holds. An empty list means that its content is unknown.
export type MappingEntry = { path: string; episodes: EpisodeRef[] };
export type CorrectionRow = {
  fileId: string;
  path: string;
  from: EpisodeRef[];
  to: EpisodeRef[];
  // `change` and `same` are valid. `review` needs a person: the content is unknown, or the file is gone.
  // `blocked` is a request that can not be written.
  status: 'change' | 'same' | 'review' | 'blocked';
  reason: 'path_unknown' | 'file_missing' | 'episode_unknown' | 'mixed_season' | 'duplicate' | 'episode_missing' | 'shared_episode' | null;
};
// One episode whose file changes. The paths, or null when the episode has no file.
export type PointerRow = { season: number; number: number; from: string | null; to: string | null };
export type Correction = {
  titleKey: string;
  entries: MappingEntry[];
  ids: string[];
  version: string;
  rows: CorrectionRow[];
  pointers: PointerRow[];
  lostAvailability: EpisodeRef[];
  continued: { id: string; phase: 'importing' }[];
  staysBlocked: { id: string; code: string }[];
};
export type CorrectionCommit = Pick<Correction, 'titleKey' | 'ids' | 'lostAvailability' | 'continued'> & {
  files: MediaFile[];
  pointers: (EpisodeRef & { fileId: string | null })[];
  numbering: Numbering;
};
// The name of a file, without its folders and its extension. The folders stay fixed, so a template can not leave the title folder.
export type NamingTemplates = { movie: string; episode: string };
export type TemplateProblem = 'template_invalid' | 'template_separator' | 'template_token' | 'template_missing_token' | 'template_unreadable';
export type NamedEpisode = { season: number; number: number; name: string };
export type ParsedEpisodes = { season: number; numbers: number[] };
// The facts of an episode that a file name can give. An `Episode` of the library has all of them, and more.
export type EpisodeFacts = { season: number; number: number; name?: string; airDate?: string | null };
// The numbering of a release that counts as two seasons what the title counts as one. `releaseSeason` is the season of
// the release, `season` the season of the title, and `from` the episode of the title that the release numbers as 1.
export type Continuation = { releaseSeason: number; season: number; from: number };
// The tags of a release that name the content of a file. `season` and `episode` hold the numbering of the release,
// which is not always the numbering of TMDB.
export type FormatTags = { title: string | null; season: number | null; episode: number | null };
export type ProbeResult =
  | { ok: true; durationSeconds: number; container: string; videoCodec: string; audioLanguages: string[]; tags?: FormatTags }
  // `unreadable`: ffprobe cannot read the file. `no_video`: it has no video stream. `too_short`: it is shorter than a second.
  | { ok: false; reason: 'unreadable' | 'no_video' | 'too_short' }
  // ffprobe is not installed. The check is skipped, and the caller says so.
  | { ok: 'skipped' };
export type SideData = { side_data_type?: string };
export type Stream = {
  codec_type?: string;
  codec_name?: string;
  codec_tag_string?: string;
  width?: number;
  height?: number;
  display_aspect_ratio?: string;
  avg_frame_rate?: string;
  channels?: number;
  disposition?: { attached_pic?: number };
  side_data_list?: SideData[];
  tags?: { language?: string };
};
export type ProbeRaw = { format?: { duration?: string; format_name?: string; bit_rate?: string; tags?: Record<string, string> }; streams?: Stream[] };
export type Refusal = { error: string; problems?: RootProblem[] };
export type ScanResult = {
  status: 'ok' | 'no_folder' | 'root_unavailable' | 'folder_missing' | 'changed';
  added: number;
  updated: number;
  // Files that were on the disk before and are gone now. They stay in the library, marked as missing.
  missing: number;
  // Video files of a series whose name gives no episode.
  unmatched: string[];
  // Files for an episode that has another file already.
  duplicates: string[];
  // Files for an episode that TMDB does not list.
  unknownEpisodes: string[];
  // The other video files of a movie. A movie has one managed file.
  extraFiles: string[];
};
// A video file of the folder of a title, and what its name says. The scan, the local import, and the choice of a file
// for a target all read the folder through it.
export type InventoryFile = ScanFound & { parsed: ParsedEpisodes | undefined };
export type FolderInventory = { status: 'ok' | 'no_folder' | 'root_unavailable' | 'folder_missing'; rootReal: string | null; files: InventoryFile[] };
export type ScanFound = { path: string; sizeBytes: number; mtimeMs: number; dev?: number; ino?: number; nlink?: number };
export type AddInput = {
  mediaType: MediaType;
  tmdbId: number;
  mode: AddMode;
  seriesType: 'standard' | 'anime';
  preset: string | null;
  rootId: string;
  folder?: string | null;
  seasonOverrides?: Record<string, Override>;
  // The episodes of a series that the caller already holds. They save the wait for the refresh job.
  episodes?: EpisodeMeta[];
  // The facts that the caller already holds. With them, the add waits for no request.
  meta?: TitleMeta;
  // The page has these facts from the search or the preview, so the row looks right before the refresh.
  summary?: { title: string; year: number | null; posterPath: string | null };
  // A movie that the source searched before its release. The import keeps the choice.
  manualRelease?: boolean;
  // The add returns before the TMDB facts arrive. A queue job fetches them, and the summary shows meanwhile.
  deferMetadata?: boolean;
};
export type FilesDeps = { probe?: typeof ffprobeRaw };
export type FilterResult = { test: (title: Title) => boolean } | { error: 'invalid_filter' };
export type FoldersDeps = { tmdb?: Tmdb; events: Events; enqueue: (input: EnqueueInput) => Job };
export type PlansDeps = { tmdb?: Tmdb; events: Events; enqueue: (input: EnqueueInput) => Job; queue?: Queue; cancelJob?: (id: string) => void; clients?: Clients };
export type Failure = { status: number; body: Record<string, unknown> };
// What the preview saw. The apply checks that the library and the disk are still the same.
export type Stored = { preview: PlanPreview; seen: Map<string, Seen>; ids: Map<string, string[]>; points?: Set<string> };
// What the preview saw on the disk. Null: the file was not there.
export type Seen = { sizeBytes: number; mtimeMs: number } | null;
export type Retired = { ok: true; how: 'deleted' | 'gone' } | { ok: false; reason: string };
export type ToolsDeps = { tmdb?: Tmdb; events: Events; enqueue: (input: EnqueueInput) => Job; queue?: Queue; cancelJob?: (id: string) => void; clients?: Clients };
// What the verification of one title must check: the hashes that the source recorded, and the episodes that the
// source monitors. The state stays in the database, so a restart, a client outage, or a second import does not lose it.
export type VerificationState = {
  key: string;
  downloads: SourceDownload[];
  episodes: SourceEpisode[];
  // True until a run of the verification ends with no outage. A periodic job starts the pending ones again.
  pending: boolean;
  updatedAt: number;
};
export type ReleaseKind = 'premiere' | 'theatrical_limited' | 'theatrical' | 'digital' | 'physical' | 'tv';
export type ReleaseDate = { region: string; kind: ReleaseKind; date: string };
export type SeasonSummary = { seasonNumber: number; episodeCount: number; airDate: string | null };
// One page of a discover list, with the number of pages that TMDB has.
export type DiscoverPage = { results: SearchResult[]; totalPages: number };
// The TMDB facts about a title. A refresh replaces all of it, so it never holds a choice of the user.
export type TitleMeta = SearchResult & {
  originalTitle: string;
  aliases: string[];
  // The ISO 3166-1 regions that returned each alias. A title from an older version has no map.
  aliasRegions?: Record<string, string[]>;
  date: string | null;
  status: string;
  rating: number | null;
  votes: number;
  backdropPath: string | null;
  runtime: number | null;
  imdbId: string | null;
  tvdbId: number | null;
  // The names of the genres of TMDB, and the certification of the country of origin. A title from an older version has
  // neither.
  genres?: string[];
  certification?: string | null;
  releaseDates: ReleaseDate[];
  seasons: SeasonSummary[];
};
// A date-only air date stays a date. The caller uses UTC.
// shortcut: no episode overview, to keep the database file small. Fetch it on demand if the UI needs it.
export type EpisodeMeta = {
  tmdbId: number;
  season: number;
  number: number;
  name: string;
  airDate: string | null;
  runtime: number | null;
};
export type TmdbErrorCode = 'not_found' | 'invalid_key' | 'rate_limited' | 'unavailable';
export type TmdbOptions = {
  apiKey: string;
  fetch?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
  // Least time between the starts of two requests. TMDB limits at about 40 requests a second.
  spacingMs?: number;
  ttlMs?: number;
};
// The answers of TMDB are outside data, so these helpers read them without trusting their shape.
export type TmdbRaw = any;
export type Tmdb = ReturnType<typeof createTmdb>;
export type BackupLimits = ZipLimits & { zipBytes: number };
export type MigrationBackupQuality = readonly [name: string, source: string, resolution: number];
export type Row = Record<string, unknown>;
export type MigrationBackupProfileItem = SourceProfile['items'][number];
export type DownloadHistory = { id: number; date: number; failed: boolean };
export type SourceApp = 'sonarr' | 'radarr';
export type SourceQuality = { id?: number; name?: string; source?: string; resolution?: number };
export type MigrationSourceProfileItem = { id?: number; name?: string; quality?: SourceQuality; items?: MigrationSourceProfileItem[]; allowed?: boolean };
export type SourceProfile = {
  id: number;
  name: string;
  cutoff: number;
  items: MigrationSourceProfileItem[];
  minFormatScore: number;
  formatItems: { score?: number }[];
  language: string | null;
};
export type SourceEpisode = { season: number; number: number; monitored: boolean; airDateUtc: string | null };
// One download hash and the episodes or the movie that it covers. The backup records it; the torrent is optional.
export type SourceDownload = { hash: string; episodes: { season: number; number: number }[]; at: number; id: number; failed: boolean };
export type SourceTitle = {
  sourceId: number;
  mediaType: MediaType;
  title: string;
  year: number | null;
  tmdbId: number | null;
  tvdbId: number | null;
  path: string | null;
  monitored: boolean;
  qualityProfileId: number;
  seriesType: 'standard' | 'daily' | 'anime';
  seasons: { seasonNumber: number; monitored: boolean }[];
  minimumAvailability: string | null;
  // The episodes of the series, and the hashes that the source recorded for it.
  episodes?: SourceEpisode[];
  downloads?: SourceDownload[];
};
export type SourceData = {
  app: SourceApp;
  version: string;
  // Source IDs are only unique inside one source, so each ledger key starts with this.
  namespace: string;
  titles: SourceTitle[];
  profiles: SourceProfile[];
};
export type MigrationSourceOptions = { url: string; apiKey: string; fetch?: typeof fetch; timeoutMs?: number };
export type ProfileNote = Extract<ImportNote, 'resolution_not_supported' | 'several_resolutions' | 'sources_not_supported' | 'custom_formats' | 'language_preference'>;
export type Leaf = { quality: SourceQuality; allowed: boolean; id: number | undefined };
export type PathMapping = { from: string; to: string };
export type ZipLimits = {
  // The most entries that the central directory can list.
  entries: number;
  // The most bytes that one entry can have after it is unpacked.
  entryBytes: number;
  // The most that an entry can grow, as a ratio of its packed size.
  ratio: number;
};
export type ZipEntry = { name: string; method: 0 | 8; crc: number; packedSize: number; size: number; offset: number; symlink: boolean };
export type MigrateDeps = { tmdb: Tmdb; events: Events; save: () => Promise<void>; enqueue: (input: EnqueueInput) => Job };
// What a re-import gives to a title that is in the library already. The job adds no title; it synchronizes the
// source facts and verifies the files, the hashes, and the queue.
export type Existing = {
  key: string;
  monitored: boolean;
  folder: string | null;
  seasonOverrides: Record<string, Override>;
  manualRelease: boolean;
  downloads: SourceDownload[];
  episodes: SourceEpisode[];
};
export type MigrationPlan = { rows: MigrationRow[]; requests: Map<string, LedgerEntry['request']>; existing: Map<string, Existing> };
export type CompatDeps = { tmdb?: Tmdb; events: Events; enqueue: (input: EnqueueInput) => Job; services?: Services };
// A command that a caller sent. A search command lists the entries that it started and the search jobs of those entries.
// The search ends when its jobs end, so a command that a restart interrupted still ends, and a later search of the same entry does not change it.
export type CompatCommand = {
  id: number;
  name: string;
  body: Record<string, unknown>;
  queuedAt: number;
  endedAt: number | null;
  status: 'queued' | 'started' | 'completed' | 'failed';
  message: string | null;
  entries: string[];
  jobs: string[];
};
export type Placement = { preset: string; root: Root; monitored: boolean };
export type AdapterOptions = {
  urlBase?: string;
  restorer?: Restorer;
  onChange?: () => void;
  tmdb?: Tmdb;
  events: Events;
  enqueue: (input: EnqueueInput) => Job;
  services?: Services;
};
// The request that a caller of the Seerr API sent. The ID stays the same after a restart.
export type SeerrRequest = {
  id: number;
  mediaType: MediaType;
  tmdbId: number;
  seasons: number[];
  createdAt: number;
  updatedAt: number;
};
export type SeerrOptions = CompatDeps & { restorer?: Restorer };
export type SeasonChoice = { seasonNumber: number; monitored: boolean };
export type SonarrFound = { title: Title } | { meta: TitleMeta } | { count: number };
export type GetDeps = { tmdb?: Tmdb; heartbeat?: () => number; backupDir?: string; clientCheck?: () => Promise<ClientState>; ffprobe?: () => Promise<boolean> };
export type Genre = { id: number; name: string };
export type PostDeps = { enqueue: (input: EnqueueInput) => Job; status: ImportStatus; configDir?: string };
export type SourceDeps = { tmdb?: Tmdb; events: Events; enqueue: (input: EnqueueInput) => Job; status: ImportStatus; configDir?: string };
export type DeleteDeps = { events: Events; queue?: Queue; cancelJob?: (id: string) => void };
export type PatchDeps = { events: Events; enqueue: (input: EnqueueInput) => Job; finder?: Finder };
export type RefreshDeps = { tmdb?: Tmdb; enqueue: (input: EnqueueInput) => Job };
export type RescanDeps = { enqueue: (input: EnqueueInput) => Job };
export type LibraryDeps = { tmdb?: Tmdb; events: Events; enqueue: (input: EnqueueInput) => Job };
// A plan of the kind `upgrades` comes from the Upgrade button of a title page. It searches the files below a quality
// for a release of exactly that quality. Other plans look for the missing files.
export type Kind = 'search' | 'upgrades';
export type SearchPlan = { keys: string[]; targets: number; kind: Kind; quality: string; jobId: string | null };
export type ApplyDeps = { persist?: () => void; events?: Events; queue?: Queue; enqueue?: (input: EnqueueInput) => Job };
export type ProposalDeps = { probe?: typeof probeFile };
export type ProposalRow = ContentProposal & { fileId: string };
export type RenameApplyDeps = { enqueue: (input: EnqueueInput) => Job; status: ImportStatus };
export type StatusDeps = { tmdb?: Tmdb; heartbeat?: () => number; backupDir?: string; clientCheck?: () => Promise<ClientState>; ffprobe?: () => Promise<boolean> };
export type UpdateDeps = { installUpdate?: () => Promise<{ version: string }>; pauseQueue?: () => Promise<void>; resumeQueue?: () => void; restart?: () => void };
export type Manifest = {
  format: 1;
  app: 'ladarr';
  appVersion: string;
  schemaVersion: number;
  createdAt: string;
  kind: BackupKind;
  files: Record<string, { bytes: number; sha256: string }>;
  // The backup holds no media files and no login sessions.
  excludes: string[];
};
export type Sources = { tmdb?: Tmdb; heartbeat?: () => number; backupDir?: string; clientCheck?: () => Promise<ClientState>; ffprobe?: () => Promise<boolean> };
export type Worker = { pause: () => Promise<boolean>; resume: () => void; enqueue: (input: EnqueueInput) => unknown };
export type Restorer = ReturnType<typeof createRestorer>;
export type SupervisorOptions = { execPath?: string; stopTimeoutMs?: number };
export type ReleaseAsset = { name: string; url: string };
export type ReleaseInfo = { version: string; url: string; assets: ReleaseAsset[] };
export type UpdateErrorCode = 'no_update' | 'busy' | 'asset_missing' | 'download_failed' | 'checksum_mismatch' | 'extract_failed';
// Downloads the bundle of the newest release into appDir and replaces the files of the process.
// The caller restarts the process after this call returns.
export type InstallOptions = { appDir?: string; fetchImpl?: typeof fetch; currentVersion?: string };

export type { TorrentStatus, TrackerStatus, IndexerApp, FolderFileStatus, Availability, Override, Policy, MediaType } from '@ladarr/shared/enums';
export type { SizeLimits, FolderFile, FolderPlan, CastMember, PersonCredits, SearchResult } from '@ladarr/shared/types';
