import type {
  Availability,
  BackupKind,
  ClientState,
  FolderFileStatus,
  ImportNote,
  IndexerApp,
  IndexerNotUsed,
  Language,
  LibraryFilter,
  LibraryType,
  MediaType,
  MigrationStatus,
  Override,
  PlanAction,
  PlanSkip,
  Policy,
  QueueActionName,
  QueueBranch,
  QueueStage,
  RootProblem,
  TorrentStatus,
  TrackerStatus,
  WebhookEventType,
} from './enums.ts';

// The shapes of the domain and of the HTTP API. The server and the web app both import them.

// A season and an episode number. A movie file covers none.
export type EpisodeRef = { season: number; number: number };

// MiB for each minute of runtime. A limit that is null is not checked.
export type SizeLimits = { min: number; preferred: number | null; max: number | null };

// A quality profile. The qualities of one group have the same rank.
export type QualityProfile = { id: string; name: string; items: string[][] };

export type AuthStatus = { setupRequired: boolean; authenticated: boolean; csrfToken?: string };

export type SearchResult = {
  mediaType: MediaType;
  tmdbId: number;
  title: string;
  year: number | null;
  overview: string;
  posterPath: string | null;
  originalLanguage: string;
  // The key of the title in the library, or null.
  libraryKey?: string | null;
  // The type of a series in the library. It is null for a movie, and for a title that is not in the library.
  seriesType?: 'standard' | 'anime' | null;
};

// The TMDB facts of a title that may not be in the library. The title page shows them for both.
// The date is the release date of a movie, and the first air date of a series.
export type TitlePreview = SearchResult & { date: string | null; backdropPath: string | null; rating: number | null; runtime: number | null; imdbId: string | null; tvdbId: number | null; providerStatus: string };

export type CastMember = { id: number; name: string; character: string; profilePath: string | null };

// An actor and the movies and series in the credits of the actor.
export type PersonCredits = { person: { id: number; name: string; profilePath: string | null; alsoKnownAs: string[]; popularity: number | null }; credits: SearchResult[] };

export type EpisodeCounts = { total: number; eligible: number; available: number; upcoming: number };

export type TitleSummary = {
  key: string;
  mediaType: MediaType;
  tmdbId: number;
  title: string;
  year: number | null;
  posterPath: string | null;
  providerStatus: string;
  paused: boolean;
  // Series only. It is null for a movie.
  seriesType: 'standard' | 'anime' | null;
  availability: Availability;
  // Series only.
  counts: EpisodeCounts | null;
  // Movies only. The time of the first digital or physical release in the region, or null.
  eligibleAt: number | null;
};

export type SeasonRow = { seasonNumber: number; episodeCount: number; counts: EpisodeCounts; override: Override | null };

export type TitleDetail = TitleSummary & {
  // The status of the title in the queue, or null when the queue has no target for it.
  queueStatus: string | null;
  overview: string;
  aliases: string[];
  // The release date of a movie, and the first air date of a series.
  date: string | null;
  rating: number | null;
  runtime: number | null;
  imdbId: string | null;
  tvdbId: number | null;
  backdropPath: string | null;
  policy: Policy;
  // The preset that applies, and the choice of the title when it differs from the default.
  preset: string;
  presetOverride: string | null;
  rootId: string;
  // The folder of the title under its root, or null.
  folder: string | null;
  manualRelease: boolean;
  // Null while the TMDB facts of a title that entered the queue first are on their way.
  metaLoadedAt: number | null;
  episodesLoadedAt: number | null;
  seasons: SeasonRow[];
};

// The TMDB facts of an episode. A title that is not in the library has them too.
export type EpisodeSummary = { season: number; number: number; name: string; airDate: string | null; runtime: number | null };

export type EpisodeRow = EpisodeSummary & {
  monitored: boolean;
  override: Override | null;
  aired: boolean;
  hasFile: boolean;
  // The status of the target in the queue, or null when the queue has no target for it.
  queue: string | null;
};

// The seasons and the episodes of a series that is not in the library.
export type SeasonEpisodes = { seasonNumber: number; episodes: EpisodeSummary[] };

export type SeriesEpisodes = { seasons: SeasonEpisodes[] };

// ---- files, bulk actions, and folders without a title ----

export type FileRow = {
  id: string;
  path: string;
  sizeBytes: number;
  mtimeMs: number;
  missing: boolean;
  episodes: EpisodeRef[];
};

export type FileDetails =
  | {
      state: 'ok';
      container: string;
      durationSeconds: number | null;
      bitrate: number | null;
      video: { codec: string; width: number | null; height: number | null; frameRate: number | null } | null;
      audio: { codec: string; channels: number | null; language: string }[];
      subtitles: { codec: string; language: string }[];
    }
  | { state: 'missing' | 'unreadable' | 'no_video' | 'root_unavailable' | 'ffprobe_missing' };

export type PlanRequest = {
  action: PlanAction;
  keys: string[];
  // For `remove`: delete the files too.
  deleteFiles?: boolean;
  // For `remove` on a series: only this season.
  season?: number;
  // For `preset`: a preset ID, or null for the default.
  preset?: string | null;
  // For `delete_files` with one title: only these files.
  fileIds?: string[];
};

export type PlanTitle = {
  key: string;
  title: string;
  year: number | null;
  mediaType: MediaType;
  files: number;
  bytes: number;
  activeDownloads: number;
  // The action changes nothing for this title.
  unchanged: boolean;
  // The apply leaves this title as it is.
  skip: PlanSkip | null;
};

export type PlanFile = {
  id: string;
  titleKey: string;
  path: string;
  sizeBytes: number;
  // False when the file is not on the disk now.
  present: boolean;
  // Set when ladarr cannot delete the file.
  problem: 'outside_root' | 'not_a_file' | 'unreadable' | null;
  episodes: EpisodeRef[];
};

export type PlanPreview = {
  planId: string;
  request: PlanRequest;
  titles: PlanTitle[];
  // Every file that the action deletes. Empty for an action that keeps files.
  files: PlanFile[];
  // Files that stay in the folder of a removed title, and the number that the list cuts off.
  stays: { titleKey: string; path: string }[];
  staysCutOff: number;
  expiresAt: number;
};

export type PlanResult = {
  changed: number;
  deleted: number;
  skipped: { key: string; reason: string }[];
  failed: { path: string; reason: string }[];
};

export type UntitledFolder = {
  rootId: string;
  mediaType: MediaType;
  folder: string;
  videoFiles: number;
  sizeBytes: number;
  // The title and year that the folder name suggests.
  guess: { title: string; year: number | null };
};

export type SetupChecks = {
  client: { state: ClientState };
  // The number of indexers that the indexer manager pushed for each app.
  indexers: { series: number; movies: number };
};

// A notice for the person: a problem of the setup. `title` and `message` are keys of the web i18n. `params` fills their
// variables.
export type AlertView = { id: string; title: string; message: string; params?: Record<string, string | number> };

// A problem of the setup. `fix` names an action that a button can do. The text of `action` says the same in words.
// `message` and `action` are keys of the web i18n. `params` fills their variables.
export type Problem = { id: string; message: string; action: string; params?: Record<string, string | number>; fix?: { kind: 'accept_mount'; rootId: string } };

export type SystemStatus = { problems: Problem[] };

// The version of the server that runs.
export type VersionInfo = { version: string };
// The latest release of the repository, and whether it is newer than the installed version. notes is the text of the
// release, which holds the changelog.
export type UpdateCheck = { available: boolean; latest: string; url: string; notes: string | null };

export type RootCheck = { problems: RootProblem[]; freeBytes: number | null };
export type RootRow = { id: string; path: string; mediaType: MediaType; check: RootCheck };
// The folders inside a folder of the server, for the picker of the settings. parent is null at the top of the disk.
export type FolderListing = { path: string; parent: string | null; folders: string[] };

export type PresetRow = { id: string; label: string };

export type QualityRow = { id: string; label: string; source: string; resolution: number | null; sizes: SizeLimits };
// The qualities of a profile, the best group first. The qualities of one group have the same rank.
export type ProfileData = QualityProfile;

export type SettingsData = {
  setupCompleted: boolean;
  region: string;
  timeZone: string;
  language: Language;
  theme: 'dark' | 'light';
  defaultRoots: { movie: string | null; tv: string | null };
  audio: { language: string; strict: boolean } | null;
  keepQueueLogs: boolean;
  naming: { movie: string; episode: string };
};

export type SettingsResponse = {
  settings: SettingsData;
  presets: PresetRow[];
  qualityTableVersion: number;
  // The language codes of the aliases of every title, for the tag input of the indexer settings.
  aliasLanguageOptions: string[];
};

export type SettingsSaved = { settings: SettingsData };

// The setup needs the settings and the folders that exist.
export type SetupData = { settings: SettingsData; roots: RootRow[] };

export type QualityResponse = { qualities: QualityRow[]; profiles: ProfileData[] };

// ---- backups, logs, and the state of the system ----

export type BackupRow = { name: string; kind: BackupKind; createdAt: number; bytes: number };
export type BackupsResponse = { backups: BackupRow[] };

export type LogEntry = { time: string; level?: string; message: string; type?: 'system' | 'catalog'; event?: string; [field: string]: unknown };
export type LogsResponse = { entries: LogEntry[] };

// ---- import and rename ----

export type FolderFile = {
  rel: string;
  sizeBytes: number;
  status: FolderFileStatus;
  reason: string | null;
  episodes: { season: number; number: number; name: string }[];
  dest: string | null;
  replaces: string | null;
};

export type FolderPlan = {
  titleKey: string;
  path: string;
  // False when neither the folder nor the files have the name of the title. Null when the title has no letters to compare.
  nameMatch: boolean | null;
  files: FolderFile[];
  // Series only. The seasons that the files touch, and the episodes that they leave without a file.
  coverage: { season: number; total: number; covered: number; missing: number[] }[];
  importable: number;
  truncated: boolean;
};

// A folder that the import page reads. The source stays where it is: the import only links its files.
export type SourceFolder = {
  path: string;
  mediaType: MediaType;
  guess: { title: string; year: number | null };
  videoFiles: number;
  sizeBytes: number;
  truncated: boolean;
  // The TMDB results of the guess, with the detected media type first.
  results: SearchResult[];
};

export type SourcePreview = {
  titleKey: string;
  // True when the start adds the title to the catalog.
  created: boolean;
  rootId: string;
  rootPath: string;
  folder: string;
  rootProblems: RootProblem[];
  freeBytes: number | null;
  plan: FolderPlan;
};

export type RenameRow = {
  fileId: string;
  from: string;
  to: string | null;
  status: 'rename' | 'unchanged' | 'blocked';
  reason: string | null;
};

export type RenameCheck = { problems: { movie: string | null; episode: string | null }; examples: { movie: string; episode: string } | null };

export type RenameOverview = { titles: { titleKey: string; title: string; year: number | null; rename: number; blocked: number }[]; total: number };

// A run of an import or a rename. The journal holds the steps after a restart.
export type RunStatus = {
  id: string;
  kind: 'import' | 'rename';
  titleKey: string;
  total: number;
  done: number;
  problems: { file: string; code: string; detail?: string }[];
  finished: boolean;
  startedAt: number;
};

export type RunStep = {
  source: string;
  dest: string;
  state: string;
  method: 'hardlink' | 'copy' | null;
  copiedBytes: number | null;
  totalBytes: number;
};

export type RunView = { run: RunStatus; steps: RunStep[] };

// ---- migration from Sonarr and Radarr ----

export type MigrationRow = {
  ledgerKey: string;
  sourceId: number;
  mediaType: MediaType;
  title: string;
  year: number | null;
  tmdbId: number | null;
  match: 'tmdb' | 'tvdb' | 'none' | 'ambiguous';
  status: MigrationStatus;
  // Why the title is not new: for example duplicate_in_source, folder_differs, tvdb_not_found, or a TMDB error code.
  reason: string | null;
  sourcePath: string | null;
  mappedPath: string | null;
  pathStatus: 'ok' | 'missing' | 'outside_roots' | 'no_path';
  profileName: string;
  preset: string | null;
  notes: ImportNote[];
};

export type MigrationPreview = {
  planId: string;
  app: 'sonarr' | 'radarr';
  version: string;
  // The titles to verify again, on top of the new ones. A re-import of a done title has no new row.
  counts: Record<MigrationStatus, number> & { verify: number };
  rows: MigrationRow[];
  profiles: { id: number; name: string; preset: string | null; notes: ImportNote[] }[];
};

// The answer after the user sends a backup ZIP. The backup ID goes in the preview request.
export type MigrationBackup = { backupId: string; app: 'sonarr' | 'radarr'; version: string; titles: number };

export type MigrationProgress = { pending: number; imported: number; matched: number; failed: number };

// --- Queue ---------------------------------------------------------------------------------

export type QueueReason = { code: string; message: string; action: 'retry' | 'match' | 'attach' | 'settings' | 'none'; settings: 'client' | 'indexers' | 'library' | null };

export type QueueTransfer = {
  hash: string;
  progress: number;
  sizeBytes: number;
  downloadRate: number;
  etaSeconds: number | null;
  status: string;
  observedAt: number;
  stale: boolean;
  shared: boolean;
  sharedWith: number;
  seeds: number;
  peers: number;
};

// A release that the last search found and rejected. A grabbable release passes the safety checks, so a person can
// take it by hand; the others stay in the list with the reasons that stopped them.
export type QueueRejectedRelease = {
  indexerId: number;
  guid: string;
  title: string;
  sizeBytes: number;
  seeders: number | null;
  resolution: number | null;
  source: string;
  kind: 'single' | 'multi' | 'pack';
  grabbable: boolean;
  reasons: string[];
};

export type QueueSearch = {
  at: number;
  indexers: { id: number; name: string; state: 'waiting' | 'done' | 'failed' | 'skipped'; count: number | null; error?: string }[];
  candidates: number;
  accepted: number;
  result: string | null;
  topRejections: string[];
  nextAt: number | null;
  rejected: QueueRejectedRelease[];
};

export type QueueEntryView = {
  id: string;
  titleKey: string;
  mediaType: MediaType;
  title: string;
  year: number | null;
  // The poster of the title in the catalog. The row shows it before the text.
  posterPath: string | null;
  season: number | null;
  number: number | null;
  episodeName: string | null;
  label: string;
  stage: QueueStage;
  branch: QueueBranch | null;
  // The key that the pages show: a branch, or a result of the search that keeps the target waiting.
  key: string;
  reason: QueueReason | null;
  stageSince: number;
  revision: number;
  lane: number | null;
  attempt: number;
  completedAt: number | null;
  clearedAt: number | null;
  // `quality` is the source and the resolution that the release name gives, for example "BluRay 1080p".
  release: { title: string; indexer: string; sizeBytes: number; kind: 'single' | 'multi' | 'pack'; manual: boolean; quality: string | null; comment: string | null } | null;
  // The file of the target: the file of its open import, or its record in the library.
  file: { name: string; sizeBytes: number } | null;
  search: QueueSearch | null;
  transfer: QueueTransfer | null;
  // The client has a torrent for this target.
  hasTorrent: boolean;
  // The user attached the torrent. ladarr did not add it.
  attached: boolean;
  importResult: { at: number; ok: boolean; method: 'hardlink' | 'copy' | null; path: string | null; validation: 'ffprobe' | 'basic' } | null;
  // The step of the open import. The method and the step do not depend on the bytes of a copy.
  import: { state: 'planned' | 'staged' | 'published' | 'committed' | 'retired'; method: 'hardlink' | 'copy' | null; copy: { copiedBytes: number; totalBytes: number; observedAt: number } | null } | null;
};

export type QueueEntryDetail = QueueEntryView & {
  history: { at: number; stage: QueueStage; branch: QueueBranch | null; attempt: number; cause: string; detail?: string }[];
  attempts: { n: number; startedAt: number; endedAt: number | null; reason: string; release: string | null; outcome: string; detail?: string }[];
};

// The targets of a group that finished each stage. A target that is available finished every stage.
export type QueueReached = { found: number; completed: number; validated: number; imported: number };

export type QueueGroupRow = {
  kind: 'group';
  key: string;
  titleKey: string;
  title: string;
  year: number | null;
  posterPath: string | null;
  // A group covers every season of the series, so it has no season.
  season: number | null;
  total: number;
  reached: QueueReached;
  matching: number;
  counts: Record<string, number>;
  priority: boolean;
  // The series is in the queue already, but its episodes are still loading, so it has no target yet.
  pending?: boolean;
};

export type QueueRow = QueueGroupRow | ({ kind: 'entry' } & QueueEntryView);

// A page of the queue. The table is not virtual, so it shows one page at a time.
export type QueuePage = { cursor: number; total: number; items: QueueRow[] };

export type QueueSummary = {
  cursor: number;
  counts: Record<string, number>;
  // The targets that can still move, by stage. A stopped target is not in it.
  working: Record<string, number>;
  // The targets that stopped on a reason and wait for the person.
  stopped: number;
  // The user paused the queue.
  paused: boolean;
  targets: number;
  activeTransfers: number;
  downloadRate: number;
  recentCompletions: number;
  client: { state: ClientState; lastOkAt: number | null };
  hasClient: boolean;
  indexers: number;
  // The item job that the worker runs now, as the jobs page lists it first.
  currentJob: { type: string; label: string | null } | null;
};

// A job of the item flow that waits for the worker or runs now, with the payload that it hands to its handler.
export type QueueJob = {
  id: string;
  type: string;
  state: 'waiting' | 'running';
  payload: unknown;
  runAt: number;
  // The time when the worker can start the job. It includes the wait for the next request of its indexer.
  eta: number;
  attempts: number;
  priority: number | null;
  lastError: { kind: string; message: string } | null;
  // The label of the target that the job works on, or null when the job has no target.
  label: string | null;
  // The poster of the title of the target, or null when the job has no target.
  posterPath: string | null;
};

export type QueueActionPreview = {
  action: QueueActionName;
  affected: { id: string; label: string; stage: string; key: string; lane: number | null }[];
  unsupported: { id: string; reason: string }[];
  sharedTransfers: { name: string; entries: number }[];
};

export type QueueMatchPreview = {
  file: string;
  // The file that each target has now, or null.
  affected: { id: string; label: string; current: string | null }[];
  // Targets that lose their file, because another target takes it.
  replaces: { id: string; label: string }[];
  // Targets that wait for a repair. Their import starts again.
  retries: { id: string; label: string }[];
};

// What the client reports for the torrent of a target. A value that the client does not report is null.
export type QueueClientDetail = {
  observedAt: number;
  // The state as the client writes it, and the state that ladarr maps from it.
  state: string;
  status: TorrentStatus;
  // The host of the first working tracker.
  tracker: string | null;
  trackers: { host: string | null; status: TrackerStatus; tier: number; message: string; seeds: number | null; peers: number | null; downloaded: number | null }[] | null;
  swarm: { seeds: number | null; peers: number | null };
  availability: number | null;
  // The wait for a slot. Position is the place in the queue of the client.
  queue: { waiting: boolean; position: number | null };
  slots: { queueing: boolean | null; maxActiveDownloads: number | null; maxActiveTorrents: number | null; maxActiveUploads: number | null } | null;
};

export type ExternalTorrent = { hash: string; name: string; sizeBytes: number; progress: number; complete: boolean; category: string; addedAt: number };

export type AttachCandidates = {
  torrents: ExternalTorrent[];
  total: number;
  // Other targets of the same title that can use the same download.
  siblings: { id: string; label: string }[];
};

export type AttachPreview = { hash: string; name: string; affected: { id: string; label: string }[] };

// The files of a download, and the targets that the same download can cover.
export type QueuePackFiles = {
  files: { rel: string; sizeBytes: number }[];
  entries: { id: string; label: string; season: number | null; number: number | null }[];
};

// --- Indexers and client -------------------------------------------------------------------

export type IndexerHealth = { okAt: number | null; failedAt: number | null; failures: number; retryAt: number; error: string | null };

export type IndexerRow = {
  id: number;
  name: string;
  type: 'torznab' | 'newznab';
  // The user added the indexer in Settings. Only then can the user change its fields. The indexer manager owns the others.
  manual: boolean;
  baseUrl: string;
  apps: IndexerApp[];
  priority: number;
  delaySeconds: number;
  nextRequestAt: number;
  // The languages of the names that the indexer should receive. No languages means every language.
  preferredLanguages: string[];
  enableRss: boolean;
  enableAutomaticSearch: boolean;
  enableInteractiveSearch: boolean;
  health: IndexerHealth;
  // The apps for which ladarr does not use the indexer, and why.
  notUsed: { app: IndexerApp; reason: IndexerNotUsed }[];
};

// The answer of a connection test. It saves nothing.
export type IndexerTestResult = { ok: true } | { ok: false; code: string };
export type ClientTestResult = { ok: true; version: string; apiVersion: string } | { ok: false; code: string };
export type WebhookTestResult = { ok: true } | { ok: false; code: 'unreachable' | 'rejected'; status: number | null };

export type BlocklistRow = { id: string; title: string; reason: { code: string; message: string }; at: number };
// The host of the webhook destination. The rest of the address can hold a token, so the API never sends it.
export type WebhookView = { id: string; type: WebhookEventType; host: string };

// A download client as the user sees it. The secrets stay on the server.
export type ClientView = { id: string; name: string; type: 'qbittorrent'; host: string; port: number; auth: 'apiKey' | 'password'; username: string | null; enabled: boolean; maxDownloads: number };

export type ReleaseRow = {
  indexerId: number;
  guid: string;
  title: string;
  indexer: string;
  sizeBytes: number;
  seeders: number | null;
  kind: 'single' | 'multi' | 'pack';
  accepted: boolean;
  overridable: boolean;
  rejections: { code: string; message: string }[];
};

// --- Library filters, search on a selection, and calendar ----------------------------------

// What a search on a selection will start. `planId` is null when nothing needs a search.
export type SearchPlan = {
  planId: string | null;
  titles: number;
  targets: number;
  sample: { key: string; mediaType: MediaType; title: string; year: number | null; targets: number }[];
};

// The selection of a search on the library: titles that the user chose, or a filter with a media type.
export type LibrarySearchRequest = { kind: 'search' | 'upgrades'; filter?: LibraryFilter; type?: LibraryType; keys?: string[]; resolution?: number };

export type CalendarEvent = {
  // The queue entry ID of the target.
  id: string;
  titleKey: string;
  mediaType: MediaType;
  title: string;
  year: number | null;
  season: number | null;
  number: number | null;
  episodeName: string | null;
  // The date in the configured time zone, as YYYY-MM-DD.
  day: string;
  // The instant of the release when its date has a time. Null when the date has no time.
  at: number | null;
  // A target that is not monitored is never Missing.
  availability: Availability;
  monitored: boolean;
  paused: boolean;
};

// A title with no known date. It has no position in the calendar.
export type CalendarUndated = { titleKey: string; mediaType: MediaType; title: string; year: number | null; count: number };

export type CalendarResponse = {
  from: string;
  to: string;
  today: string;
  timeZone: string;
  events: CalendarEvent[];
  undated: CalendarUndated[];
  truncated: boolean;
};
