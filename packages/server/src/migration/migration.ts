import { stat } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import type { ImportNote, MigrationStatus } from '@ladarr/shared/enums';
import type { MigrationRow } from '@ladarr/shared/types';
import { type Db, type LedgerEntry, db } from '../core/db.ts';
import type { Events } from '../core/events.ts';
import type { EnqueueInput, Job } from '../core/jobs.ts';
import { titleKey, type Override, type Title } from '../library/library.ts';
import { mapPath, mapProfile, type PathMapping, type SourceData, type SourceDownload, type SourceEpisode, type SourceTitle } from './migration-source.ts';
import type { Tmdb } from '../metadata/tmdb.ts';

const LOOKUPS_AT_ONCE = 4;

export type MigrateDeps = { tmdb: Tmdb; events: Events; save: () => Promise<void>; enqueue: (input: EnqueueInput) => Job };

// What a re-import gives to a title that is in the library already. The job adds no title; it synchronizes the
// source facts and verifies the files, the hashes, and the queue.
type Existing = {
  key: string;
  monitored: boolean;
  folder: string | null;
  seasonOverrides: Record<string, Override>;
  manualRelease: boolean;
  downloads: SourceDownload[];
  episodes: SourceEpisode[];
};

export type Plan = { rows: MigrationRow[]; requests: Map<string, LedgerEntry['request']>; existing: Map<string, Existing> };

async function mapLimit<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await work(items[index]!);
      }
    }),
  );
  return results;
}

const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

function titleNotes(source: SourceTitle): ImportNote[] {
  const notes: ImportNote[] = [];
  if (source.seriesType === 'daily') notes.push('daily_series_type');
  if (source.mediaType === 'tv') notes.push('episode_monitoring');
  else if (source.minimumAvailability && source.minimumAvailability !== 'released') notes.push('minimum_availability');
  return notes;
}

// Looks at the source and the library and says what an import would do. It changes nothing.
export async function buildPlan(tmdb: Tmdb, source: SourceData, mappings: PathMapping[]): Promise<Plan> {
  const profiles = new Map(source.profiles.map((profile) => [profile.id, { profile, ...mapProfile(profile) }]));

  const resolved = await mapLimit(source.titles, LOOKUPS_AT_ONCE, async (item) => {
    if (item.tmdbId) return { tmdbId: item.tmdbId, match: 'tmdb' as const, reason: null };
    if (item.mediaType === 'movie' || !item.tvdbId) return { tmdbId: null, match: 'none' as const, reason: 'no_tmdb_id' };
    // A TVDB ID must give exactly one series. Otherwise the title waits for a match and nothing is guessed.
    const found = await tmdb.findSeriesByTvdb(item.tvdbId);
    if (found.length === 1) return { tmdbId: found[0]!.tmdbId, match: 'tvdb' as const, reason: null };
    return found.length === 0 ? { tmdbId: null, match: 'none' as const, reason: 'tvdb_not_found' } : { tmdbId: null, match: 'ambiguous' as const, reason: 'tvdb_ambiguous' };
  });

  const rows: MigrationRow[] = [];
  const requests = new Map<string, LedgerEntry['request']>();
  const existing = new Map<string, Existing>();
  const seen = new Set<string>();

  for (const [index, item] of source.titles.entries()) {
    const { tmdbId, match, reason: matchReason } = resolved[index]!;
    const ledgerKey = `${source.namespace}:${item.sourceId}`;
    const mapped = profiles.get(item.qualityProfileId);
    const mappedPath = item.path ? mapPath(item.path, mappings) : null;

    // The folder must be inside a folder of ladarr for the same media type. It is only read, never changed.
    let pathStatus: MigrationRow['pathStatus'] = item.path ? 'outside_roots' : 'no_path';
    let rootId: string | null = null;
    let folder: string | null = null;
    if (mappedPath) {
      const root = Object.values(db.data.roots).find((candidate) => candidate.mediaType === item.mediaType && inside(candidate.path, mappedPath));
      if (root) {
        rootId = root.id;
        folder = relative(root.path, mappedPath).split(sep).join('/');
        pathStatus = (await stat(mappedPath).catch(() => undefined))?.isDirectory() ? 'ok' : 'missing';
      }
    }

    let status: MigrationStatus = 'new';
    let reason: string | null = null;
    const key = tmdbId ? titleKey(item.mediaType, tmdbId) : null;
    const entry = db.data.ledger[ledgerKey];
    if (!tmdbId) {
      status = 'unmatched';
      reason = matchReason;
    } else if (seen.has(key!)) {
      status = 'conflict';
      reason = 'duplicate_in_source';
    } else if (entry?.status === 'pending') status = 'pending';
    else if (entry && (entry.status === 'imported' || entry.status === 'matched') && entry.key === key && db.data.titles[key!]) status = 'imported';
    else if (db.data.titles[key!]) {
      const existing = db.data.titles[key!]!;
      status = existing.folder && folder && existing.folder !== folder ? 'conflict' : 'matched';
      reason = status === 'conflict' ? 'folder_differs' : null;
    } else if (entry?.status === 'failed') reason = entry.error;
    if (key && tmdbId) seen.add(key);

    rows.push({
      ledgerKey,
      sourceId: item.sourceId,
      mediaType: item.mediaType,
      title: item.title,
      year: item.year,
      tmdbId,
      match,
      status,
      reason,
      sourcePath: item.path,
      mappedPath,
      pathStatus,
      profileName: mapped?.profile.name ?? `Profile ${item.qualityProfileId}`,
      preset: mapped?.preset ?? null,
      notes: [...(mapped?.notes ?? []), ...titleNotes(item)],
    });

    const overrides = seasonOverridesOf(item);
    const downloads = item.downloads ?? [];
    const episodes = item.episodes ?? [];
    const manualRelease = item.mediaType === 'movie' && item.minimumAvailability !== null && item.minimumAvailability !== 'released';

    if ((status === 'new' || status === 'pending') && tmdbId) {
      const defaultRoot = db.data.settings.defaultRoots[item.mediaType];
      const built: LedgerEntry['request'] = {
        mediaType: item.mediaType,
        tmdbId,
        // A title outside the folders of ladarr goes to the default folder. Its path is not kept.
        rootId: rootId ?? defaultRoot ?? '',
        folder,
        preset: mapped?.preset ?? null,
        paused: !item.monitored,
        seriesType: item.seriesType === 'anime' ? 'anime' : 'standard',
        seasonOverrides: overrides,
        downloads,
        sourceEpisodes: episodes,
        manualRelease,
      };
      // A title that waits from an earlier try keeps the choices of that try. A new import starts the job again.
      requests.set(ledgerKey, status === 'pending' ? entry?.request ?? built : built);
    }
    // A re-import verifies a title that is in the library already. It also applies the source facts that the first
    // import did not read: the paused state, the season and episode monitoring, and the source folder.
    if (key && status !== 'new' && db.data.titles[key] && (downloads.length || episodes.length || status === 'imported' || status === 'matched' || status === 'conflict')) {
      existing.set(ledgerKey, { key, monitored: item.monitored, folder, seasonOverrides: overrides, manualRelease, downloads, episodes });
    }
  }
  return { rows, requests, existing };
}

function seasonOverridesOf(item: SourceTitle): Record<string, Override> {
  const overrides: Record<string, Override> = {};
  for (const season of item.seasons) {
    if (season.seasonNumber > 0 && !season.monitored) overrides[season.seasonNumber] = 'unmonitored';
    if (season.seasonNumber === 0 && season.monitored) overrides[0] = 'monitored';
  }
  return overrides;
}

const hasFiles = (title: Title) => Boolean(title.fileId || title.episodes.some((episode) => episode.fileId));

// The facts of the source that the first import did not keep. The files of a title that has them keep their folder.
export function applyExisting(source: Existing) {
  const title = db.data.titles[source.key];
  if (!title) return;
  title.paused = !source.monitored;
  title.seasonOverrides = source.seasonOverrides;
  if (!hasFiles(title) && source.folder) title.folder = source.folder;
  if (title.mediaType === 'movie') title.manualRelease = source.manualRelease;
}

