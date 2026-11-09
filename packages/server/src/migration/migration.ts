import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import type { ImportNote, MigrationStatus } from '@ladarr/shared/enums';
import type { MigrationBackup, MigrationPreview, MigrationProgress, MigrationRow } from '@ladarr/shared/types';
import { Router } from 'express';
import type { Db, LedgerEntry } from '../core/db.ts';
import type { Events } from '../core/events.ts';
import type { EnqueueInput, Job } from '../core/jobs.ts';
import { titleKey, type Override, type Title } from '../library/library.ts';
import { BACKUP_LIMITS, readBackup } from './migration-backup.ts';
import { mapPath, mapProfile, readFromApi, SourceError, testConnection, type PathMapping, type SourceData, type SourceDownload, type SourceEpisode, type SourceTitle } from './migration-source.ts';
import { requestVerification } from '../library/verification.ts';
import type { Tmdb } from '../metadata/tmdb.ts';

const MAX_PLANS = 3;
const MAX_UPLOADS = 3;
const MAX_MAPPINGS = 50;
const LOOKUPS_AT_ONCE = 4;

export type MigrateDeps = { db: Db; tmdb: Tmdb; events: Events; save: () => Promise<void>; enqueue: (input: EnqueueInput) => Job };

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

type Plan = { rows: MigrationRow[]; requests: Map<string, LedgerEntry['request']>; existing: Map<string, Existing> };

// shortcut: plans stay in memory, so a restart drops them. The user starts the preview again.
const plans = new Map<string, Plan & { info: Pick<MigrationPreview, 'app' | 'version'> }>();

// shortcut: a backup that the user sent stays in memory, so a restart drops it. The user sends the file again.
const uploads = new Map<string, SourceData>();

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
export async function buildPlan(db: Db, tmdb: Tmdb, source: SourceData, mappings: PathMapping[]): Promise<Plan> {
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

    if (status === 'new' && tmdbId) {
      const defaultRoot = db.data.settings.defaultRoots[item.mediaType];
      requests.set(ledgerKey, {
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
      });
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
function applyExisting(db: Db, source: Existing) {
  const title = db.data.titles[source.key];
  if (!title) return;
  title.paused = !source.monitored;
  title.seasonOverrides = source.seasonOverrides;
  if (!hasFiles(title) && source.folder) title.folder = source.folder;
  if (title.mediaType === 'movie') title.manualRelease = source.manualRelease;
}

function parseConnection(body: unknown) {
  const { url, apiKey } = (body ?? {}) as Record<string, unknown>;
  if (typeof url !== 'string' || typeof apiKey !== 'string' || !url || !apiKey || url.length > 500 || apiKey.length > 200) return;
  return { url, apiKey };
}

function parseMappings(value: unknown): PathMapping[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_MAPPINGS) return;
  const out: PathMapping[] = [];
  for (const rule of value) {
    if (typeof rule?.from !== 'string' || typeof rule?.to !== 'string' || !rule.from || rule.from.length > 500 || rule.to.length > 500 || !isAbsolute(rule.to)) return;
    out.push({ from: rule.from, to: rule.to });
  }
  return out;
}

export function migrationRouter(db: Db, { tmdb, events, enqueue }: { tmdb?: Tmdb; events: Events; enqueue: (input: EnqueueInput) => Job }) {
  const router = Router();

  const progress = (): MigrationProgress => {
    const counts: MigrationProgress = { pending: 0, imported: 0, matched: 0, failed: 0 };
    for (const entry of Object.values(db.data.ledger)) counts[entry.status]++;
    return counts;
  };

  router.post('/test', async (req, res) => {
    const connection = parseConnection(req.body);
    if (!connection) return void res.status(400).json({ error: 'invalid_connection' });
    res.json(await testConnection(connection));
  });

  // The body is the ZIP file. The name of the file is in the query, because the version of the program is in the name.
  let reading = false;
  router.post('/backup', async (req, res) => {
    if (!req.is(['application/zip', 'application/octet-stream'])) return void res.status(400).json({ error: 'backup_invalid' });
    // A refusal by size does not read the body, so the connection closes.
    if (Number(req.headers['content-length']) > BACKUP_LIMITS.zipBytes) return void res.set('Connection', 'close').status(413).json({ error: 'backup_too_large' });
    if (reading) return void res.status(429).json({ error: 'backup_busy' });

    reading = true;
    try {
      const source = await readBackup(req, { name: typeof req.query.name === 'string' ? req.query.name.slice(0, 200) : undefined });
      const backupId = randomUUID();
      uploads.set(backupId, source);
      while (uploads.size > MAX_UPLOADS) uploads.delete(uploads.keys().next().value!);
      res.json({ backupId, app: source.app, version: source.version, titles: source.titles.length } satisfies MigrationBackup);
    } catch (err) {
      if (err instanceof SourceError && err.code === 'backup_too_large') res.set('Connection', 'close');
      throw err;
    } finally {
      reading = false;
    }
  });

  router.post('/preview', async (req, res) => {
    if (!tmdb) return void res.status(503).json({ error: 'metadata_unavailable' });
    const mappings = parseMappings(req.body?.mappings);
    const backupId = typeof req.body?.backupId === 'string' ? req.body.backupId : undefined;
    // The source is a backup that the user sent, or a running instance.
    const connection = backupId ? undefined : parseConnection(req.body);
    if (!mappings || (!backupId && !connection)) return void res.status(400).json({ error: 'invalid_connection' });

    const source = backupId ? uploads.get(backupId) : await readFromApi(connection!);
    if (!source) return void res.status(404).json({ error: 'backup_not_found' });
    const plan = await buildPlan(db, tmdb, source, mappings);
    const planId = randomUUID();
    plans.set(planId, { ...plan, info: { app: source.app, version: source.version } });
    while (plans.size > MAX_PLANS) plans.delete(plans.keys().next().value!);

    const counts = { new: 0, matched: 0, conflict: 0, unmatched: 0, imported: 0, pending: 0, failed: 0, verify: 0 } satisfies Record<MigrationStatus, number> & { verify: number };
    for (const row of plan.rows) counts[row.status]++;
    // A new title is verified after the add. A title that is in the library is verified by this import alone.
    for (const ledgerKey of plan.existing.keys()) if (plan.rows.find((row) => row.ledgerKey === ledgerKey)?.status !== 'new') counts.verify++;
    const used = new Set(source.titles.map((title) => title.qualityProfileId));
    const preview: MigrationPreview = {
      planId,
      app: source.app,
      version: source.version,
      counts,
      rows: plan.rows,
      profiles: source.profiles.filter((profile) => used.has(profile.id)).map((profile) => ({ id: profile.id, name: profile.name, ...mapProfile(profile) })),
    };
    res.json(preview);
  });

  // Writes the ledger, and a job adds the titles. A restart keeps the rest of the work.
  router.post('/import', (req, res) => {
    const plan = typeof req.body?.planId === 'string' ? plans.get(req.body.planId) : undefined;
    if (!plan) return void res.status(404).json({ error: 'plan_not_found' });
    const selected = Array.isArray(req.body.select) ? new Set(req.body.select.filter((key: unknown) => typeof key === 'string')) : undefined;

    let queued = 0;
    let verified = 0;
    for (const row of plan.rows) {
      if (selected && !selected.has(row.ledgerKey)) continue;
      const request = plan.requests.get(row.ledgerKey);
      if (request) {
        if (db.data.ledger[row.ledgerKey]?.status === 'pending') continue;
        if (!request.rootId) {
          db.data.ledger[row.ledgerKey] = { status: 'failed', app: plan.info.app, sourceId: row.sourceId, title: row.title, year: row.year, key: null, error: 'root_required', request, updatedAt: Date.now() };
          continue;
        }
        db.data.ledger[row.ledgerKey] = { status: 'pending', app: plan.info.app, sourceId: row.sourceId, title: row.title, year: row.year, key: null, error: null, request, updatedAt: Date.now() };
        queued++;
        continue;
      }
      // A title that is in the library already has no request. Its verification runs now, with the new facts of the source.
      const current = plan.existing.get(row.ledgerKey);
      if (!current) continue;
      applyExisting(db, current);
      requestVerification(db, enqueue, current.key, { downloads: current.downloads, episodes: current.episodes });
      verified++;
    }
    if (queued) enqueue({ type: 'migration.import', dedupeKey: 'migration.import' });
    // The plan is spent. A new preview shows what is left.
    plans.delete(req.body.planId);
    res.status(202).json({ queued, verified, ...progress() });
  });

  router.get('/status', (_req, res) => {
    res.json(progress());
  });

  return router;
}

