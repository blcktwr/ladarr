// The values that a field of the domain and of the API takes.
// They are string unions, not TypeScript enums, so they erase at build time.

export type MediaType = 'movie' | 'tv';

// The language of the interface.
export type Language = 'en' | 'es';

// The state of a title, or of an episode, in the library.
export type Availability = 'waiting' | 'missing' | 'available';

// The choice of the user for the monitoring of a season.
export type Override = 'monitored' | 'unmonitored';

// The episodes of a series that ladarr monitors: all of them, or the ones that air from now.
export type Policy = 'all' | 'future';

// The journey of a queue target: Queued, Searching, Fetching the release, Sending to client, Downloading, Validating, Importing, Available.
// A stage can be skipped when its work is not needed. A stage never shows progress that did not happen.
export type QueueStage = 'queued' | 'searching' | 'fetching' | 'sending' | 'downloading' | 'validating' | 'importing' | 'available';

// A branch is a state beside the journey. It does not move the entry forward.
// "waiting" means that no release is eligible yet.
export type QueueBranch = 'paused' | 'cancelled' | 'waiting';

// The checks of an import, in the order that the importer runs them.
export const IMPORT_CHECK_IDS = [
  'download_complete',
  'title_folder',
  'root_available',
  'download_in_client',
  'download_readable',
  'download_inside',
  'files_found',
  'destination_inside',
  'file_readable',
  'destination_free',
  'names_unique',
  'staged',
  'published',
  'committed',
  'retired',
] as const;
export type ImportCheckId = (typeof IMPORT_CHECK_IDS)[number];
export type ImportCheckState = 'pending' | 'running' | 'ok' | 'failed';

// The state of a download client connection.
export type ClientState = 'unconfigured' | 'ok' | 'rejected' | 'unreachable';

// The state of the torrent of a target, as the client writes it and as ladarr maps it.
export type TorrentStatus = 'metadata' | 'queued' | 'checking' | 'moving' | 'downloading' | 'stalled' | 'paused' | 'complete' | 'seeding' | 'error' | 'unknown';

export type TrackerStatus = 'disabled' | 'not_contacted' | 'working' | 'updating' | 'not_working' | 'unknown';

// The status of a queue entry that starts a webhook.
export type WebhookEventType = 'stuck' | 'available';

// The app of the indexer manager.
export type IndexerApp = 'sonarr' | 'radarr';

// The reasons why ladarr does not use an indexer for an app.
export type IndexerNotUsed = 'usenet' | 'tags' | 'download_client';

export type AddMode = 'all' | 'future' | 'paused';

export type PlanAction = 'pause' | 'resume' | 'refresh' | 'preset' | 'remove' | 'delete_files';

export type PlanSkip = 'import_running' | 'root_unavailable';

export type RootProblem = 'not_found' | 'not_directory' | 'not_readable' | 'not_writable' | 'mount_changed' | 'low_space';

export type BackupKind = 'auto' | 'manual' | 'safety';

export type FolderFileStatus = 'new' | 'replace' | 'register' | 'exists' | 'in_place' | 'unmatched' | 'unknown_episode' | 'duplicate' | 'extra' | 'blocked';

export type ImportNote =
  | 'resolution_not_supported'
  | 'several_resolutions'
  | 'sources_not_supported'
  | 'upgrades_allowed'
  | 'custom_formats'
  | 'language_preference'
  | 'daily_series_type'
  | 'episode_monitoring'
  | 'minimum_availability';

export type MigrationStatus = 'new' | 'matched' | 'conflict' | 'unmatched' | 'imported' | 'pending' | 'failed';

export type QueueActionName = 'pause' | 'resume' | 'retry' | 'priority' | 'unpriority' | 'clear' | 'remove_torrent' | 'replace';

export type LibraryFilter = 'missing' | 'waiting' | 'attention' | 'available';

// The type menu of the catalog: a movie, a series, or the series whose type is anime.
export type LibraryType = 'movie' | 'tv' | 'anime';
