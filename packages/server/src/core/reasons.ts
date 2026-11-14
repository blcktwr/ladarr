// What the user reads when a target waits or stops, and the action that helps.
// The code is stable. The message is the key of the web i18n. The webhook sends the English text.
export type ReasonAction = 'retry' | 'match' | 'attach' | 'settings' | 'none';
export type ReasonInfo = { message: string; action: ReasonAction; settings?: 'client' | 'indexers' | 'library' };

export const REASONS: Record<string, ReasonInfo> = {
  // The search found nothing to take.
  no_results: { message: 'Not found in any indexers, we will search again.', action: 'retry' },
  all_rejected: { message: 'The indexers have releases, but none fits your selected qualities.', action: 'retry' },
  indexers_failed: { message: 'No indexer answered. The search tries again.', action: 'retry' },
  search_deferred: { message: 'The search reached its request budget. It continues in the next run.', action: 'none' },
  no_indexers: { message: 'No indexer configured', action: 'settings', settings: 'indexers' },
  indexer_unavailable: { message: 'The indexer does not answer. The search tries again.', action: 'none' },
  indexer_rejected: { message: 'The indexer rejects the API key. Sync the indexers again.', action: 'settings', settings: 'indexers' },

  // The client.
  client_missing: { message: 'No download client configured', action: 'settings', settings: 'client' },
  client_unreachable: { message: 'The download client does not answer. The attempt runs again later.', action: 'none' },
  client_rejected: { message: 'The download client rejects the login.', action: 'settings', settings: 'client' },
  client_error: { message: 'The download client reports an error for this torrent.', action: 'retry' },
  torrent_exists: { message: 'This torrent is in the client already and was not added by the app.', action: 'attach' },
  torrent_missing: { message: 'The torrent is not in the client now.', action: 'retry' },
  grab_failed: { message: 'The release did not reach the client.', action: 'retry' },
  too_many_attempts: { message: 'Several releases failed. Select a release by hand, or try again.', action: 'retry' },
  job_removed: { message: 'The job was removed from the queue. Start it again.', action: 'retry' },

  // The import.
  file_not_found: { message: 'The download has no file for this target.', action: 'match' },
  file_unreadable: { message: 'The file is damaged or not a video.', action: 'none' },
  destination_exists: { message: 'A file with this name is in the library folder already. It is not replaced.', action: 'retry' },
  destination_outside_root: { message: 'The destination is outside the library folder.', action: 'settings', settings: 'library' },
  disk_full: { message: 'The disk has no room for the file.', action: 'retry' },
  permission_denied: { message: 'The library folder is not writable.', action: 'settings', settings: 'library' },
  copy_incomplete: { message: 'The copy is not complete.', action: 'retry' },
  import_failed: { message: 'The import stopped because of a file error.', action: 'retry' },
  path_outside_downloads: { message: 'The files of the download are outside the save folder that the client reports.', action: 'none' },
  download_not_found: { message: 'The download folder is not the same as configured as media.', action: 'none' },
  root_unavailable: { message: 'The library folder is missing, or its disk is not mounted.', action: 'settings', settings: 'library' },
  title_unavailable: { message: 'The title is not in the library now.', action: 'none' },
};

export const reasonInfo = (code: string): ReasonInfo => REASONS[code] ?? { message: 'Something stopped this target.', action: 'retry' };
