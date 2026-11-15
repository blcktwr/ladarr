import { db } from '../core/db.ts';
import { PlanError } from './imports/plan.ts';
import type { Episode } from './library.ts';

// A file of the library gets the episodes that it holds, from a mapping that a person reviewed. The correction writes
// the two directions of the record: the coverage of each file, and the file of each episode.

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

export type Correction = { titleKey: string; rows: CorrectionRow[]; pointers: PointerRow[] };

const keyOf = (episode: EpisodeRef) => `${episode.season}x${episode.number}`;
const sorted = (episodes: EpisodeRef[]) => [...episodes].sort((a, b) => a.season - b.season || a.number - b.number);
const same = (a: EpisodeRef[], b: EpisodeRef[]) => a.length === b.length && a.every((episode, at) => keyOf(episode) === keyOf(b[at]!));
const covers = (episodes: EpisodeRef[], episode: Episode) => episodes.some((item) => item.season === episode.season && item.number === episode.number);

// The episodes of one entry, or the reason why they can not be written.
function check(entry: MappingEntry, catalog: Set<string>): { reason: CorrectionRow['reason']; episodes: EpisodeRef[] } {
  const episodes = sorted(entry.episodes);
  if (!episodes.length) return { reason: 'episode_unknown', episodes };
  if (new Set(episodes.map((episode) => episode.season)).size > 1) return { reason: 'mixed_season', episodes };
  const keys = episodes.map(keyOf);
  if (new Set(keys).size !== keys.length) return { reason: 'duplicate', episodes };
  if (keys.some((key) => !catalog.has(key))) return { reason: 'episode_missing', episodes };
  return { reason: null, episodes };
}

// Reads the request against the library. It changes nothing.
export function correctionOf(titleKey: string, entries: MappingEntry[]): Correction {
  const title = db.data.titles[titleKey];
  if (!title) throw new PlanError('title_not_found');
  if (title.mediaType !== 'tv') throw new PlanError('not_a_series');
  const catalog = new Set(title.episodes.map(keyOf));
  const files = Object.values(db.data.files)
    .filter((file) => file.titleKey === titleKey)
    .sort((a, b) => a.path.localeCompare(b.path));
  const byPath = new Map<string, MappingEntry>();
  for (const entry of entries) if (!byPath.has(entry.path)) byPath.set(entry.path, entry);

  const rows: CorrectionRow[] = [];
  // The paths that claim an episode, to find an episode that two files claim.
  const claims = new Map<string, string[]>();

  for (const file of files) {
    const from = sorted(file.episodes);
    const entry = byPath.get(file.path);
    if (!entry) {
      rows.push({ fileId: file.id, path: file.path, from, to: from, status: 'same', reason: null });
      continue;
    }
    // A file that is gone keeps its coverage until a person removes it.
    if (file.missing) {
      rows.push({ fileId: file.id, path: file.path, from, to: from, status: 'review', reason: 'file_missing' });
      continue;
    }
    const checked = check(entry, catalog);
    if (checked.reason === 'episode_unknown') {
      rows.push({ fileId: file.id, path: file.path, from, to: [], status: 'review', reason: 'episode_unknown' });
      continue;
    }
    if (checked.reason) {
      rows.push({ fileId: file.id, path: file.path, from, to: checked.episodes, status: 'blocked', reason: checked.reason });
      continue;
    }
    rows.push({ fileId: file.id, path: file.path, from, to: checked.episodes, status: same(from, checked.episodes) ? 'same' : 'change', reason: null });
    for (const episode of checked.episodes) claims.set(keyOf(episode), [...(claims.get(keyOf(episode)) ?? []), file.path]);
  }

  // An entry for a path that the title does not hold.
  const known = new Set(files.map((file) => file.path));
  for (const entry of entries) {
    if (known.has(entry.path)) continue;
    rows.push({ fileId: '', path: entry.path, from: [], to: sorted(entry.episodes), status: 'blocked', reason: 'path_unknown' });
  }

  // One episode, one file. Two files that claim the same episode are both held back.
  for (const paths of claims.values()) {
    if (paths.length < 2) continue;
    for (const path of paths) {
      const row = rows.find((item) => item.path === path)!;
      row.status = 'blocked';
      row.reason = 'shared_episode';
    }
  }

  // The coverage that the title has after the correction. A request that a person must read keeps the old coverage.
  const coverage = new Map(rows.map((row) => [row.path, row.status === 'blocked' ? row.from : row.to]));
  const pointers: PointerRow[] = [];
  for (const episode of title.episodes) {
    const current = episode.fileId ? db.data.files[episode.fileId] : undefined;
    // A file that is gone keeps its pointer, so the episode shows as missing.
    if (current && current.missing) continue;
    if (current && covers(coverage.get(current.path) ?? [], episode)) continue;
    const next = files.find((file) => !file.missing && covers(coverage.get(file.path) ?? [], episode));
    pointers.push({ season: episode.season, number: episode.number, from: current?.path ?? null, to: next?.path ?? null });
  }

  return { titleKey, rows, pointers };
}

// Writes the two directions of the record. The caller saves the database.
export function applyCorrection(correction: Correction): void {
  const title = db.data.titles[correction.titleKey];
  if (!title) throw new PlanError('title_not_found');
  if (correction.rows.some((row) => row.status === 'blocked')) throw new PlanError('mapping_blocked');
  for (const row of correction.rows) {
    const file = row.fileId ? db.data.files[row.fileId] : undefined;
    if (!file || file.missing || row.status === 'same') continue;
    file.episodes = row.to.map((episode) => ({ season: episode.season, number: episode.number }));
  }
  for (const pointer of correction.pointers) {
    const episode = title.episodes.find((item) => item.season === pointer.season && item.number === pointer.number);
    if (!episode) continue;
    const file = pointer.to ? Object.values(db.data.files).find((item) => item.titleKey === title.key && item.path === pointer.to && !item.missing) : undefined;
    episode.fileId = file?.id ?? null;
  }
}
