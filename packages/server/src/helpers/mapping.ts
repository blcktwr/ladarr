import { isObject } from './rename.ts';
import type { EpisodeRef, MappingEntry } from '../types.ts';

// The most files that one request can hold. A title with more files needs more than one request.
const MAX_ENTRIES = 5_000;

// The mapping of the request: one row for each file, with the episodes that the file holds. An empty list marks a
// file whose content is unknown. A request that does not have this shape is a problem of the client.
export function mappingOf(body: unknown): MappingEntry[] | undefined {
  if (!isObject(body) || !Array.isArray(body.entries) || body.entries.length > MAX_ENTRIES) return;
  const entries: MappingEntry[] = [];
  for (const item of body.entries) {
    if (!isObject(item) || typeof item.path !== 'string' || !item.path || !Array.isArray(item.episodes)) return;
    const episodes: EpisodeRef[] = [];
    for (const episode of item.episodes) {
      if (!isObject(episode)) return;
      const { season, number } = episode;
      if (!Number.isInteger(season) || !Number.isInteger(number)) return;
      episodes.push({ season: season as number, number: number as number });
    }
    entries.push({ path: item.path, episodes });
  }
  return entries;
}

export function titleOf(body: unknown): string | undefined {
  const key = isObject(body) ? body.titleKey : undefined;
  return typeof key === 'string' && key ? key : undefined;
}
