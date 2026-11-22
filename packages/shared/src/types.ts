import type {
  Availability,
  BackupKind,
  ClientState,
  FolderFileStatus,
  ImportCheckId,
  ImportCheckState,
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
  QueueResolutionAction,
  RootProblem,
  TorrentStatus,
  TrackerStatus,
  WebhookEventType,
} from './enums.ts';
import type { Phase, QueueState, Status, Tab } from './queue.ts';

// The shapes of the domain and of the HTTP API. The server and the web app both import them.

// A season and an episode number. A movie file covers none.
export type EpisodeRef = { season: number; number: number };

// One correspondence between the episodes of the catalog and the episodes of a release. The catalog episodes run from
// `from` to `to`, and the release numbers the first one as `releaseFrom`. The release end follows from the length.
export type NumberingRange = { season: number; from: number; to: number; releaseSeason: number; releaseFrom: number };

// The numbering of a series: how the releases count the seasons and the episodes. `revision` rises with each save.
export type Numbering = { revision: number; ranges: NumberingRange[] };

// MiB for each minute of runtime. A limit that is null is not checked.
export type SizeLimits = { min: number | null; preferred: number | null; max: number | null };

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
  // The state of a title in the library, for the bookmark of its poster. Both are null for a title that is not in the library.
  queueStatus?: string | null;
  availability?: Availability | null;
  // Series only. The counts of the title in the library, which the bookmark uses to show a downloaded series.
  counts?: EpisodeCounts | null;
};

// A list of the discovery page. The page names the row and keeps its order.
export type DiscoveryRow = { id: 'movies' | 'series'; results: SearchResult[] };

// A page of the discovery lists. The page reads the next one while page < totalPages.
export type DiscoveryPage = { page: number; totalPages: number; rows: DiscoveryRow[] };

// The order of the discovery lists. The server names the field of TMDB that each media type uses.
export type DiscoverySort = 'popularity.asc' | 'popularity.desc' | 'release.asc' | 'release.desc' | 'rating.asc' | 'rating.desc';

// A genre of the discovery filter. TMDB names the genres of movies and series differently, so the same genre holds the ID of each list. An ID is null when the list does not have the genre.
export type DiscoveryGenre = { name: string; movie: number | null; tv: number | null };

// A country of the watch providers, named as TMDB names it.
export type WatchRegion = { code: string; name: string };

// A streaming service of a country. The logo is a path of the TMDB image host.
export type WatchProvider = { id: number; name: string; logoPath: string | null };

// The lists of the filter panel of the discovery page.
export type DiscoveryFilters = { genres: DiscoveryGenre[]; regions: WatchRegion[] };

// The TMDB facts of a title that may not be in the library. The title page shows them for both.
// The date is the release date of a movie, and the first air date of a series.
// The certification belongs to the country of origin of the title.
export type TitlePreview = SearchResult & { date: string | null; backdropPath: string | null; rating: number | null; runtime: number | null; genres: string[]; certification: string | null; imdbId: string | null; tvdbId: number | null; providerStatus: string };

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
  // The status of the title in the queue, or null when the queue has no target for it.
  queueStatus: string | null;
  // Series only.
  counts: EpisodeCounts | null;
  // Movies only. The time of the first digital or physical release in any region, or null.
  eligibleAt: number | null;
};

export type SeasonRow = { seasonNumber: number; episodeCount: number; counts: EpisodeCounts; override: Override | null };

export type TitleDetail = TitleSummary & {
  overview: string;
  aliases: string[];
  // The release date of a movie, and the first air date of a series.
  date: string | null;
  rating: number | null;
  runtime: number | null;
  genres: string[];
  certification: string | null;
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
  // The resolutions of the files of the title, the highest first, without duplicates.
  resolutions: number[];
  // Series only. How the releases number the seasons and the episodes.
  numbering: Numbering;
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
  // The resolution of the file, from its release or from its name. Null when neither says.
  resolution: number | null;
};

export type FileDetails =
  | {
      state: 'ok';
      container: string;
      durationSeconds: number | null;
      bitrate: number | null;
      video: { codec: string; width: number | null; height: number | null; aspectRatio: string | null; frameRate: number | null; dolbyVision: boolean } | null;
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
  // With a revision, season uses the release numbering of the preview.
  numberingRevision?: number;
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

export type QualityRow = { id: string; label: string; source: string; resolution: number | null };
// A quality of the chain of a title that an upgrade can reach.
export type UpgradeQuality = { id: string; label: string };
// The qualities of a profile, the best group first. The qualities of one group have the same rank.
export type ProfileData = QualityProfile;

export type SettingsData = {
  setupCompleted: boolean;
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
};

export type SettingsSaved = { settings: SettingsData };

// The setup needs the settings and the folders that exist.
export type SetupData = { settings: SettingsData; roots: RootRow[] };

export type QualityResponse = { qualities: QualityRow[]; profiles: ProfileData[]; sizes: Record<MediaType, Record<string, SizeLimits>> };

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

// The cause of the problem, when the server kept one. A target that used its attempts keeps the failure of its last
// release, such as a damaged .torrent or a pack that lacks episodes.
export type QueueReason = { code: string; message: string; action: 'retry' | 'match' | 'attach' | 'settings' | 'none' | 'numbering'; settings: 'client' | 'indexers' | 'library' | null; detail: string | null };

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

// A release that the last search found and rejected. A person can take any of them by hand; the row says the reason
// that stopped the automatic search.
export type QueueRejectedRelease = {
  indexerId: number;
  guid: string;
  title: string;
  sizeBytes: number;
  seeders: number | null;
  resolution: number | null;
  source: string;
  kind: 'single' | 'multi' | 'pack';
  reasons: string[];
  // The size check that stopped the release, with the numbers. Null when the size did not stop it.
  sizeRejection: { code: 'size_below_min' | 'size_above_max'; value: number; limit: number } | null;
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

// One check of an import. The state and the reason are the ones of the last run.
export type ImportCheck = {
  id: ImportCheckId;
  state: ImportCheckState;
  code: string | null;
  detail: string | null;
  at: number | null;
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
  releaseEpisode: EpisodeRef | null;
  episodeName: string | null;
  label: string;
  // The derived status, tab, and phase of the state of the target.
  status: Status;
  tab: Tab | null;
  phase: Phase;
  // The problem of a stuck target, or the result of a search that keeps it waiting. Null otherwise.
  reason: QueueReason | null;
  actions: QueueResolution[];
  stateSince: number;
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
  // The checks of the open import. Null when the target has no check run.
  checks: ImportCheck[] | null;
};

export type QueueEntryDetail = QueueEntryView & {
  history: { at: number; state: QueueState; stage: Phase; attempt: number; cause: string; detail?: string }[];
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
  // A group is one season of a series.
  season: number | null;
  numberingRevision?: number;
  // The status of the whole group, from all of its targets, independent of the selected tab.
  status: Status | null;
  total: number;
  reached: QueueReached;
  // The part of the download that the client reports for the least advanced download that runs, from 0 to 1. Null
  // when no target of the group downloads.
  download: number | null;
  matching: number;
  // The targets of the group by status, and the tabs that hold one of them.
  counts: Record<string, number>;
  tabs: Tab[];
  // The most frequent problem of the blocked targets of the group.
  problem: QueueReason | null;
  actions: QueueResolution[];
  // The targets of the group whose pack did not hold every episode of the season. The card of the season offers the
  // search of the other seasons of the releases while the count is above zero.
  otherSeasons: number;
  priority: boolean;
};

// A series that waits for its episodes. Its initial job has no target yet, so the row is not a group of entries.
export type QueuePendingRow = {
  kind: 'pending';
  key: string;
  titleKey: string;
  title: string;
  year: number | null;
  posterPath: string | null;
  season: null;
  priority: boolean;
};

export type QueueRow = QueueGroupRow | QueuePendingRow | ({ kind: 'entry' } & QueueEntryView);

// A page of the queue. The table is not virtual, so it shows one page at a time.
export type QueuePage = { cursor: number; total: number; items: QueueRow[] };

// The aggregate of a whole group, before the tab filter and the page. The inspector header reads it beside the
// filtered items, so the row and the header show the same status.
export type QueueGroupSummary = Pick<QueueGroupRow, 'status' | 'counts' | 'tabs' | 'total' | 'reached' | 'download' | 'problem' | 'otherSeasons' | 'actions'>;

export type QueueMappingEpisode = EpisodeRef & {
  id: string;
  releaseSeason: number;
  torrent: { hash: string; name: string } | null;
  match: { file: string; path: string | null } | null;
};

export type QueueGroupPage = { cursor: number; group: QueueGroupSummary; items: QueueEntryView[]; mapping?: QueueMappingEpisode[]; numberingRevision?: number };

export type QueueSummary = {
  cursor: number;
  // The number of rows in each tab. A row counts once in each tab that holds one of its targets.
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

export type QueueResolution = {
  action: QueueResolutionAction;
  label: string;
  ids: string[];
  phase: Phase;
  cause: string;
  source: string | null;
  fileSource?: 'library' | 'download';
  settings?: string;
};

export type QueueActionPreview = {
  action: QueueActionName;
  version?: string;
  numbering?: { id: string; from: Numbering; to: Numbering; phase: Phase }[];
  affected: { id: string; label: string; status: Status; phase: Phase; lane: number | null }[];
  unsupported: { id: string; reason: string }[];
  sharedTransfers: { name: string; entries: number }[];
};

export type QueueMatchPreview = {
  file: string;
  source: 'library' | 'download';
  version?: string;
  effects: {
    lostAvailability: EpisodeRef[];
    continued: { id: string; phase: Phase }[];
    staysBlocked: { id: string; code: string }[];
    conflicts: { file: string; ids: string[]; code: string }[];
  };
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

export type AttachPreview = {
  hash: string;
  name: string;
  version?: string;
  affected: { id: string; label: string }[];
  blocked?: { id: string; label: string; code: string; coverage: 'absent' | 'unknown' }[];
};

// The files of a download, and the targets that the same download can cover.
export type QueuePackFiles = {
  source: 'library' | 'download';
  sources: ('library' | 'download')[];
  files: {
    rel: string;
    sizeBytes: number;
    originalName?: string;
    location?: string;
    source?: { hash: string; clientId: string | null } | null;
    current?: EpisodeRef[];
    metadata?: { title: string | null; season: number | null; episode: number | null; durationSeconds: number | null };
    proposal?: { episodes: EpisodeRef[]; step: string; evidence: string } | null;
    rejection?: { reason: string; evidence: string } | null;
  }[];
  entries: { id: string; label: string; season: number | null; number: number | null }[];
};

// The files that the .torrent of a release holds, and what the file says about itself. The server reads them from the
// indexer, so the client is not needed.
export type QueueTorrent = {
  name: string;
  // The info hash of the torrent, in hexadecimal.
  hash: string;
  files: { path: string; sizeBytes: number }[];
  totalBytes: number;
  // The resolution that the name of the torrent says, for example 1080. Null when the name does not say.
  resolution: number | null;
  // The source that the name of the torrent says, for example "BluRay". Null when the name says none.
  quality: string | null;
  // The fields that the writer of the torrent added. Absent in most torrents.
  comment: string | null;
  source: string | null;
  createdBy: string | null;
  // Milliseconds, or null when the file has no date.
  createdAt: number | null;
  pieceLength: number | null;
  pieceCount: number | null;
  private: boolean;
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
  // The Torznab categories that a search sends. No categories means every category.
  categories: number[];
  priority: number;
  delaySeconds: number;
  nextRequestAt: number;
  // The languages of the names that the indexer should receive. No languages means every language.
  preferredLanguages: string[];
  // A release with no seeders is rejected, so the target does not wait on a torrent that cannot download.
  rejectZeroSeeders: boolean;
  enableRss: boolean;
  enableAutomaticSearch: boolean;
  enableInteractiveSearch: boolean;
  health: IndexerHealth;
  // The apps for which ladarr does not use the indexer, and why.
  notUsed: { app: IndexerApp; reason: IndexerNotUsed }[];
};

// The answer of a connection test. It saves nothing. The categories are the ones that the indexer lists.
export type IndexerTestResult = { ok: true; categories: number[] } | { ok: false; code: string };
export type ClientTestResult = { ok: true; version: string; apiVersion: string } | { ok: false; code: string };
export type WebhookTestResult = { ok: true } | { ok: false; code: 'unreachable' | 'rejected'; status: number | null };

export type BlocklistRow = { id: string; title: string; reason: { code: string; message: string }; at: number };
// The host of the webhook destination. The rest of the address can hold a token, so the API never sends it.
export type WebhookView = { id: string; type: WebhookEventType; host: string };

// A download client as the user sees it. The secrets stay on the server.
export type ClientView = { id: string; name: string; type: 'qbittorrent'; host: string; port: number; auth: 'apiKey' | 'password'; username: string | null; enabled: boolean; maxDownloads: number };

// --- Library filters, search on a selection, and calendar ----------------------------------

// What a search on a selection will start. `planId` is null when nothing needs a search.
export type SearchPlan = {
  planId: string | null;
  titles: number;
  targets: number;
  sample: { key: string; mediaType: MediaType; title: string; year: number | null; targets: number }[];
};

// The selection of a search on the library: titles that the user chose, or a filter with a media type.
export type LibrarySearchRequest = { kind: 'search' | 'upgrades'; filter?: LibraryFilter; type?: LibraryType; keys?: string[]; quality?: string };

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
  // The date in UTC, as YYYY-MM-DD.
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
  events: CalendarEvent[];
  undated: CalendarUndated[];
  truncated: boolean;
};
