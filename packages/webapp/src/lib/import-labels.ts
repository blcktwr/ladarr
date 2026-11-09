import { describeError, labels } from './format.ts';
import { t } from '../i18n/index.ts';

// The texts for the manual import, the rename, and their problems. The codes come from the server.

export const folderStatusLabel: Record<string, string> = labels({
  new: 'Import',
  replace: 'Replace',
  register: 'Add to the library',
  exists: 'Has a file',
  in_place: 'Already in the library',
  unmatched: 'No episode in the name',
  unknown_episode: 'Episode not in TMDB',
  duplicate: 'Duplicate',
  extra: 'Extra file',
  blocked: 'Blocked',
});

export const folderStatusColor = (status: string): 'default' | 'accent' | 'success' | 'warning' | 'danger' =>
  status === 'new' || status === 'register' ? 'success' : status === 'replace' ? 'accent' : status === 'blocked' ? 'danger' : status === 'in_place' ? 'default' : 'warning';

// The reason that a file is blocked, and the problem that stops a file during a run.
export const problemLabel: Record<string, string> = labels({
  destination_exists: 'The name is taken by another file.',
  destination_outside_root: 'The name is outside the library folder.',
  source_is_library_file: 'The file is a library file already. Use Rename files.',
  partial_overlap: 'The replace would leave an episode without a file.',
  name_collision: 'Two files get this name.',
  file_missing: 'The file is not on the disk.',
  not_a_regular_file: 'The path is a link, not a file.',
  episode_unknown: 'TMDB does not list an episode of this file.',
  file_unreadable: 'The file is damaged or not a video.',
  disk_full: 'The disk has no room for the file.',
  permission_denied: 'The library folder is not writable.',
  copy_incomplete: 'The copy is not complete.',
  hard_link_unavailable: 'The disk does not allow a hard link, so the file keeps its name.',
  import_failed: 'The step stopped because of a file error.',
});

export const stepLabel: Record<string, string> = labels({
  planned: 'Planned',
  staged: 'Staged',
  published: 'Published',
  committed: 'Committed',
  retired: 'Done',
});

export const requestError: Record<string, string> = labels({
  title_not_found: 'This title is not in the library.',
  invalid_title: 'The title is not valid.',
  path_not_absolute: 'Enter a full path that starts with /.',
  folder_not_found: 'The folder does not exist.',
  not_a_folder: 'The path is not a folder.',
  folder_too_broad: 'Select a folder, not the top of the disk.',
  folder_not_allowed: 'This folder cannot be used.',
  folder_has_library: 'This folder holds a library folder.',
  folder_not_readable: 'This folder cannot be read.',
  root_unavailable: 'The library folder is missing, or its disk is not mounted.',
  title_busy: 'This title has an open import. Wait until it ends.',
  nothing_to_import: 'No file can be imported.',
  nothing_to_rename: 'No file can be renamed.',
});

export const templateError = (problem: string, kind: 'movie' | 'episode') => {
  switch (problem) {
    case 'template_separator':
      return t('Do not use / or \\ in a name.');
    case 'template_token':
      return kind === 'movie' ? t('Use only {title} and {year}.') : t('Use only {title}, {year}, {season}, {episode}, and {episodeTitle}.');
    case 'template_missing_token':
      return kind === 'movie' ? t('The name must have {title}.') : t('The name must have {title}, {season}, and {episode}.');
    case 'template_unreadable':
      return t('The season and the episodes must be in the name. Use S{season}E{episode}.');
    default:
      return t('Enter a name of 1 to 150 characters.');
  }
};

// The text of an API error for the dialogs of a title. A code that has no text gives the general text.
export const requestMessage = (err: unknown) => requestError[err instanceof Error ? err.message : ''] ?? describeError(err);
