import type { LibraryFilter, LibraryType } from '@ladarr/shared/enums';
import { type Db, db } from '../../core/db.ts';
import { availability, type Title } from '../library.ts';

export const LIBRARY_FILTERS: readonly LibraryFilter[] = ['missing', 'waiting', 'attention', 'available'];

// Turns the `type` value of a request into a library type. No value, or an unknown one, passes every title.
export const libraryType = (value: unknown): LibraryType | undefined => (value === 'movie' || value === 'tv' || value === 'anime' ? value : undefined);

// Anime is a series whose type says so. The other values are the media type.
export const matchesType = (title: Title, type: LibraryType | undefined) => !type || (type === 'anime' ? title.mediaType === 'tv' && title.seriesType === 'anime' : title.mediaType === type);

// The titles that have a target that waits on a problem. Activity counts the same entries.
function attentionKeys() {
  const keys = new Set<string>();
  for (const entry of Object.values(db.data.queue)) {
    if (entry.branch === null && entry.reason !== null && entry.attempt > 0 && !entry.clearedAt) keys.add(entry.titleKey);
  }
  return keys;
}

export type FilterResult = { test: (title: Title) => boolean } | { error: 'invalid_filter' };

// Turns the `filter` value of a request into a test for one title. No value passes every title.
export function libraryFilter(value: unknown): FilterResult {
  if (value === undefined) return { test: () => true };
  if (typeof value !== 'string' || !LIBRARY_FILTERS.includes(value as LibraryFilter)) return { error: 'invalid_filter' };
  const filter = value as LibraryFilter;
  if (filter === 'attention') {
    const keys = attentionKeys();
    return { test: (title) => keys.has(title.key) };
  }
  const clock = { now: Date.now(), files: db.data.files };
  return { test: (title) => availability(title, clock) === filter };
}
