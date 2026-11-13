import { ApiError } from './api.ts';
import { t } from '../i18n/index.ts';
import type { Availability, MediaType, RootProblem } from '@ladarr/shared/enums';
import type { QueueGroupRow, TitleSummary } from '@ladarr/shared/types';
import type { ThumbnailState } from 'nebula';

// A map of labels. The text goes through t() when a page reads it, so a map made at import time follows the language.
export const labels = <Key extends string>(map: Record<Key, string>) =>
  new Proxy(map, { get: (target, key) => (typeof key === 'string' && Object.hasOwn(target, key) ? t(target[key as Key]) : undefined) });

// shortcut: posters load from the TMDB image host, so the browser contacts TMDB. Cache them on the server if that matters.
// A title key is "movie:603". The page of the title is /catalog/movie/603.
export const catalogPath = (key: string) => `/catalog/${key.replace(':', '/')}`;

export const posterUrl = (path: string | null, size: 'w92' | 'w185' | 'w342' | 'w1280' | 'h632' | 'original' = 'w185') => (path ? `https://image.tmdb.org/t/p/${size}${path}` : undefined);

export const availabilityLabel: Record<Availability, string> = labels({
  waiting: 'Waiting for release',
  missing: 'Missing',
  available: 'Available',
});

// The type of a title, as the bookmark of its poster shows it. A movie is Movies. A series is Anime only when its type says so.
export const contentType = (mediaType: MediaType, seriesType?: 'standard' | 'anime' | null) => (mediaType === 'movie' ? t('Movies') : seriesType === 'anime' ? t('Anime') : t('Series'));

export const rootProblemLabel: Record<RootProblem, string> = labels({
  not_found: 'The folder does not exist.',
  not_directory: 'The path is not a folder.',
  not_readable: 'The folder is not readable.',
  not_writable: 'The folder is not writable.',
  mount_changed: 'Another disk is mounted here now, or the mount is gone.',
  low_space: 'The folder has little free space.',
});

export const formatBytes = (bytes: number | null) => {
  if (bytes === null) return t('unknown');
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
};

const errorTexts: Record<string, string> = {
  already_in_library: 'This title is in the library already.',
  last_profile: 'The list needs one quality profile.',
  profile_in_use: 'Titles use this profile.',
  invalid_profile: 'The profile is not valid.',
  invalid_order: 'The order of the profiles is not valid.',
  invalid_sizes: 'The sizes are not in order. The minimum is the smallest, then the preferred size, then the maximum.',
  root_required: 'Set a library folder for this type in Settings.',
  metadata_unavailable: 'TMDB does not answer. Try again later.',
  metadata_key_rejected: 'TMDB rejects the API key.',
  files_exist: 'This title has files. Moving them needs its own action.',
  root_in_use: 'Titles use this folder.',
  root_is_default: 'This folder is the default. Select another default first.',
  root_overlaps_root: 'This folder overlaps a saved folder.',
  root_overlaps_config: 'This folder overlaps the configuration folder.',
  root_too_broad: 'Select a folder, not the top of the disk.',
  path_not_absolute: 'Enter a full path that starts with /.',
  root_unusable: 'This folder cannot be used.',
};

Object.assign(errorTexts, {
  source_url_invalid: 'Enter an address such as http://sonarr:8989.',
  source_unreachable: 'The instance cannot be reached.',
  source_key_rejected: 'The instance rejects the API key.',
  source_wrong_app: 'The address is not Sonarr or Radarr.',
  source_version_unsupported: 'This version cannot be read. Tested versions are Sonarr 4 and Radarr 5 and 6.',
  source_invalid_response: 'The instance sent an answer that cannot be read.',
  backup_invalid: 'The file is not a ZIP file that can be read.',
  backup_unsupported: 'The ZIP file uses encryption, ZIP64, or a method that is not supported.',
  backup_unsafe: 'The ZIP file has an entry with an unsafe name or type. It is not read.',
  backup_too_large: 'The file is too large. The ZIP file can have 256 MB at most. The database can have 1 GB at most.',
  backup_no_database: 'The ZIP file has no database of Sonarr or Radarr.',
  backup_database_invalid: 'The database in this file cannot be read.',
  backup_busy: 'Another backup is being read now. Wait, then try again.',
  backup_not_found: 'The backup expired. Send the file again.',
  invalid_connection: 'Enter the address and the API key.',
  plan_not_found: 'The preview expired. Start the preview again.',
  nothing_to_search: 'Nothing to search, not released yet or not available digitally.',
  no_better_qualities: 'The quality profile has no better quality than the current file.',
});

export const errorMessages = labels(errorTexts);

// Turns an error of the API into a sentence for the user.
export function describeError(err: unknown): string {
  if (!(err instanceof ApiError)) return t('The request did not complete. Try again.');
  const problems = err.body.problems as RootProblem[] | undefined;
  if (problems?.length) return problems.map((problem) => rootProblemLabel[problem]).join(' ');
  return errorMessages[err.message] ?? t('The request did not complete. Try again.');
}


const stageTexts: Record<string, string> = {
    queued: 'Waiting',
    searching: 'Searching',
    not_found: 'Not found',
    no_match: 'No match',
    stuck: 'Stuck',
    fetching: 'Fetching the release',
    sending: 'Sending to client',
    downloading: 'Downloading',
    validating: 'Validating',
    importing: 'Importing',
    available: 'Available',
    waiting: 'Searching',
    paused: 'Paused',
    cancelled: 'Cancelled',
};
export const stageLabel = (key: string) => (Object.hasOwn(stageTexts, key) ? t(stageTexts[key]!) : key);

// A target that waits for its turn in the queue is Waiting. A target that waits for its next search is Searching,
// because the search runs again later.
const shownStages: Record<string, string> = { waiting: 'searching' };
export const shownKey = (key: string) => shownStages[key] ?? key;

// The short status of a target. A column and a count hold one or two words, so this text stays short.
const statusTexts: Record<string, string> = {
  queued: 'Waiting',
  searching: 'Searching',
  not_found: 'Not found',
  no_match: 'No match',
  stuck: 'Stuck',
  fetching: 'Fetching',
  sending: 'Sending',
  downloading: 'Downloading',
  validating: 'Validating',
  importing: 'Importing',
  available: 'Available',
  paused: 'Paused',
  cancelled: 'Cancelled',
};
export const statusLabel = (key: string) => (Object.hasOwn(statusTexts, key) ? t(statusTexts[key]!) : key);

// The queue state that the bookmark of a poster shows. A state that has no icon in the design does not show one.
const bookmarkStates: Record<string, ThumbnailState> = {
  searching: 'searching',
  // The search found no release. The target still waits in the queue for the next search, so it searches.
  not_found: 'searching',
  downloading: 'downloading',
  validating: 'validating',
  importing: 'importing',
  queued: 'waiting',
  stuck: 'stuck',
  available: 'available',
};

// The stage that a status belongs to, when the status names the result of its work. The bookmark names the stage and
// the result in parentheses, such as Waiting (Not found).
const statusStages: Record<string, string> = { not_found: 'queued', no_match: 'queued' };

// The name of a status, with the stage that it belongs to. The result of the search stays in lowercase.
const statusName = (status: string) => {
  const stage = statusStages[status];
  return stage ? `${statusLabel(stage)} (${statusLabel(status).toLowerCase()})` : statusLabel(status);
};

// The state of a title, and its name. The queue wins over the availability of the title. A title that is not in the
// library has neither, so it shows no state.
export function posterState(title: { availability?: Availability | null; queueStatus?: string | null }): { state: ThumbnailState; label: string } | null {
  const state = title.queueStatus ? bookmarkStates[title.queueStatus] : undefined;
  if (state) return { state, label: statusName(title.queueStatus!) };
  if (title.availability === 'available') return { state: 'available', label: availabilityLabel.available };
  if (title.availability === 'waiting') return { state: 'upcoming', label: availabilityLabel.waiting };
  return null;
}

// The counts of a series or a season follow the same keys, so one stage is one count.
export function shownCounts(counts: Record<string, number>) {
  const shown: Record<string, number> = {};
  for (const [key, count] of Object.entries(counts)) shown[shownKey(key)] = (shown[shownKey(key)] ?? 0) + count;
  return shown;
}

// A status text is one word, so a Hint says what the word means and what the person does next. The text of a status that has no hint is empty.
const statusHelp: Record<string, string> = {
  queued: 'The target waits for its turn. The search starts when the turn comes.',
  searching: 'The indexers are asked for a release. Nothing to do.',
  not_found: 'The indexers returned no release. The search runs again later.',
  no_match: 'The indexers returned releases, but no release fits the preset. The search runs again later.',
  stuck: 'A problem stops this target. Open Activity to see the reason.',
  fetching: 'ladarr gets the torrent from the indexer and checks it. Nothing to do.',
  sending: 'The request goes to the download client. Nothing to do.',
  downloading: 'The download client gets the files. Nothing to do.',
  validating: 'The downloaded files are checked: names, order, missing files, and more.',
  importing: 'The files move into the library. Nothing to do.',
  available: 'The title is in the library. Nothing to do.',
  waiting: 'No release is eligible yet. The search runs again later.',
  paused: 'The download is stopped in the client.',
  cancelled: 'The target stopped. Select Clear from the list to remove it.',
};
export const statusHelpText = (key: string) => (Object.hasOwn(statusHelp, key) ? t(statusHelp[key]!) : '');

// The color is a second signal. The text of the label always says the state.
export const stageColor = (key: string): 'default' | 'accent' | 'success' | 'warning' | 'danger' =>
  key === 'available' ? 'success' : key === 'paused' ? 'warning' : key === 'queued' || key === 'cancelled' ? 'default' : 'accent';

export function formatDuration(seconds: number) {
  if (seconds < 60) return `${Math.round(seconds)} s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  const hours = Math.floor(seconds / 3600);
  return `${hours} h ${Math.round((seconds % 3600) / 60)} min`;
}

// A season as the page names it. Season 0 is Specials.
export const seasonName = (season: number) => (season === 0 ? t('Specials') : t('Season {number}', { number: season }));

// The name of a group: its title and its year, and its season. A series that waits for its episodes has no season.
export const groupName = (group: Pick<QueueGroupRow, 'title' | 'year' | 'season'>) =>
  `${group.title}${group.year ? ` (${group.year})` : ''}${group.season === null ? '' : ` ${seasonName(group.season)}`}`;

