import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { extractEntry, listZip, ZipError, type ZipLimits } from './migration-zip.ts';
import { arr, int, SourceError, str, SUPPORTED_MAJORS, type SourceApp, type SourceData, type SourceDownload, type SourceEpisode, type SourceProfile, type SourceTitle } from './migration-source.ts';

// The backup ZIP is the second source. It gives the same SourceData as a running instance, so the preview,
// the path rules, the ledger, and the import job are the same for both.

const MiB = 1024 * 1024;

export type BackupLimits = ZipLimits & { zipBytes: number };

export const BACKUP_LIMITS: BackupLimits = { zipBytes: 256 * MiB, entryBytes: 1024 * MiB, entries: 32, ratio: 200 };

// The database versions (migration numbers) that the tests cover with versioned fixtures. The fixtures are synthetic.
// The first number of each range is the first schema with the columns that the import reads.
export const SUPPORTED_SCHEMAS: Record<SourceApp, readonly [first: number, last: number]> = { sonarr: [206, 237], radarr: [230, 243] };

// Limits on the rows. A real library has far fewer.
const MAX_TITLES = 100_000;
const MAX_PROFILES = 1000;
const MAX_DOWNLOADS = 200_000;
const HASH = /^[0-9a-f]{40}$/;

const ZIP_ERRORS = { invalid: 'backup_invalid', unsupported: 'backup_unsupported', unsafe: 'backup_unsafe', too_large: 'backup_too_large' } as const;

// ---- quality IDs, from Quality.cs of each program. The IDs of Sonarr and Radarr differ. ----

type Quality = readonly [name: string, source: string, resolution: number];

const SONARR_QUALITIES: Record<number, Quality> = {
  0: ['Unknown', 'unknown', 0],
  1: ['SDTV', 'television', 480],
  2: ['DVD', 'dvd', 480],
  3: ['WEBDL-1080p', 'web', 1080],
  4: ['HDTV-720p', 'television', 720],
  5: ['WEBDL-720p', 'web', 720],
  6: ['Bluray-720p', 'bluray', 720],
  7: ['Bluray-1080p', 'bluray', 1080],
  8: ['WEBDL-480p', 'web', 480],
  9: ['HDTV-1080p', 'television', 1080],
  10: ['Raw-HD', 'televisionRaw', 1080],
  12: ['WEBRip-480p', 'webRip', 480],
  13: ['Bluray-480p', 'bluray', 480],
  14: ['WEBRip-720p', 'webRip', 720],
  15: ['WEBRip-1080p', 'webRip', 1080],
  16: ['HDTV-2160p', 'television', 2160],
  17: ['WEBRip-2160p', 'webRip', 2160],
  18: ['WEBDL-2160p', 'web', 2160],
  19: ['Bluray-2160p', 'bluray', 2160],
  20: ['Bluray-1080p Remux', 'blurayRaw', 1080],
  21: ['Bluray-2160p Remux', 'blurayRaw', 2160],
  22: ['Bluray-576p', 'bluray', 576],
};

const RADARR_QUALITIES: Record<number, Quality> = {
  0: ['Unknown', 'unknown', 0],
  1: ['SDTV', 'tv', 480],
  2: ['DVD', 'dvd', 0],
  3: ['WEBDL-1080p', 'webdl', 1080],
  4: ['HDTV-720p', 'tv', 720],
  5: ['WEBDL-720p', 'webdl', 720],
  6: ['Bluray-720p', 'bluray', 720],
  7: ['Bluray-1080p', 'bluray', 1080],
  8: ['WEBDL-480p', 'webdl', 480],
  9: ['HDTV-1080p', 'tv', 1080],
  10: ['Raw-HD', 'tv', 1080],
  12: ['WEBRip-480p', 'webrip', 480],
  14: ['WEBRip-720p', 'webrip', 720],
  15: ['WEBRip-1080p', 'webrip', 1080],
  16: ['HDTV-2160p', 'tv', 2160],
  17: ['WEBRip-2160p', 'webrip', 2160],
  18: ['WEBDL-2160p', 'webdl', 2160],
  19: ['Bluray-2160p', 'bluray', 2160],
  20: ['Bluray-480p', 'bluray', 480],
  21: ['Bluray-576p', 'bluray', 576],
  22: ['BR-DISK', 'bluray', 1080],
  23: ['DVD-R', 'dvd', 480],
  24: ['WORKPRINT', 'workprint', 0],
  25: ['CAM', 'cam', 0],
  26: ['TELESYNC', 'telesync', 0],
  27: ['TELECINE', 'telecine', 0],
  28: ['DVDSCR', 'dvd', 480],
  29: ['REGIONAL', 'dvd', 480],
  30: ['Remux-1080p', 'bluray', 1080],
  31: ['Remux-2160p', 'bluray', 2160],
};

// The database stores a quality as its ID. The API sends an object, and the profile mapping reads that object.
function quality(app: SourceApp, id: number) {
  const known = (app === 'sonarr' ? SONARR_QUALITIES : RADARR_QUALITIES)[id];
  return known ? { id, name: known[0], source: known[1], resolution: known[2] } : { id, name: `Quality ${id}`, source: 'unknown', resolution: 0 };
}

// ---- reading the database ----

type Row = Record<string, unknown>;
type ProfileItem = SourceProfile['items'][number];

// The program writes the keys of a stored document in camel case. The code accepts any case.
const lower = (value: unknown): Row => Object.fromEntries(Object.entries(value && typeof value === 'object' ? value : {}).map(([key, item]) => [key.toLowerCase(), item]));

function profileItems(app: SourceApp, list: unknown[], depth = 0): ProfileItem[] {
  // A profile has groups of qualities, and a group has no groups.
  if (depth > 2) throw new SourceError('backup_database_invalid');
  return list.map((raw) => {
    const node = lower(raw);
    const id = int(node.quality);
    return {
      id: int(node.id) ?? undefined,
      name: str(node.name) ?? undefined,
      ...(id === null ? {} : { quality: quality(app, id) }),
      items: profileItems(app, arr(node.items), depth + 1),
      allowed: node.allowed === true,
    };
  });
}

function readProfiles(db: DatabaseSync, app: SourceApp): SourceProfile[] {
  const have = columns(db, 'QualityProfiles', ['Id', 'Name', 'Cutoff', 'Items', 'UpgradeAllowed', 'MinFormatScore', 'FormatItems']);
  // Only Radarr keeps a language in the profile.
  const rows = query(db, `SELECT Id, Name, Cutoff, Items, UpgradeAllowed, MinFormatScore, FormatItems${have.has('Language') ? ', Language' : ''} FROM QualityProfiles ORDER BY Id LIMIT ${MAX_PROFILES}`);
  return rows.flatMap((row): SourceProfile[] => {
    const id = int(row.Id);
    if (id === null) return [];
    const language = int(row.Language);
    return [
      {
        id,
        name: str(row.Name) ?? `Profile ${id}`,
        cutoff: int(row.Cutoff) ?? -1,
        items: profileItems(app, arr(JSON.parse(str(row.Items) ?? '[]'))),
        minFormatScore: int(row.MinFormatScore) ?? 0,
        formatItems: arr(JSON.parse(str(row.FormatItems) ?? '[]')).map((item) => ({ score: int(lower(item).score) ?? 0 })),
        // -1 is Any.
        language: language !== null && language !== -1 ? `Language ${language}` : null,
      },
    ];
  });
}

const SERIES_TYPES = ['standard', 'daily', 'anime'] as const;
const AVAILABILITY: Record<number, string> = { [-1]: 'deleted', 0: 'tba', 1: 'announced', 2: 'inCinemas', 3: 'released' };

function readTitles(db: DatabaseSync, app: SourceApp): SourceTitle[] {
  if (app === 'sonarr') {
    columns(db, 'Series', ['Id', 'Title', 'Year', 'TmdbId', 'TvdbId', 'Path', 'Monitored', 'QualityProfileId', 'SeriesType', 'Seasons']);
    return titleRows(db, 'SELECT Id, Title, Year, TmdbId, TvdbId, Path, Monitored, QualityProfileId, SeriesType, Seasons FROM Series ORDER BY Id').flatMap((row): SourceTitle[] => {
      const id = int(row.Id);
      if (id === null) return [];
      return [
        {
          sourceId: id,
          mediaType: 'tv',
          title: str(row.Title) ?? '',
          year: int(row.Year) || null,
          // The database stores 0 for an ID that the source does not know.
          tmdbId: int(row.TmdbId) || null,
          tvdbId: int(row.TvdbId) || null,
          path: str(row.Path),
          monitored: Number(row.Monitored) === 1,
          qualityProfileId: int(row.QualityProfileId) ?? 0,
          seriesType: SERIES_TYPES[int(row.SeriesType) ?? 0] ?? 'standard',
          seasons: arr(JSON.parse(str(row.Seasons) ?? '[]')).flatMap((season) => {
            const { seasonnumber, monitored } = lower(season);
            return int(seasonnumber) === null ? [] : [{ seasonNumber: seasonnumber as number, monitored: monitored === true }];
          }),
          minimumAvailability: null,
        },
      ];
    });
  }

  columns(db, 'Movies', ['Id', 'Path', 'Monitored', 'QualityProfileId', 'MinimumAvailability', 'MovieMetadataId']);
  columns(db, 'MovieMetadata', ['Id', 'TmdbId', 'Title', 'Year']);
  return titleRows(
    db,
    'SELECT m.Id, d.Title, d.Year, d.TmdbId, m.Path, m.Monitored, m.QualityProfileId, m.MinimumAvailability FROM Movies m JOIN MovieMetadata d ON d.Id = m.MovieMetadataId ORDER BY m.Id',
  ).flatMap((row): SourceTitle[] => {
    const id = int(row.Id);
    if (id === null) return [];
    return [
      {
        sourceId: id,
        mediaType: 'movie',
        title: str(row.Title) ?? '',
        year: int(row.Year) || null,
        tmdbId: int(row.TmdbId) || null,
        tvdbId: null,
        path: str(row.Path),
        monitored: Number(row.Monitored) === 1,
        qualityProfileId: int(row.QualityProfileId) ?? 0,
        seriesType: 'standard',
        seasons: [],
        minimumAvailability: AVAILABILITY[int(row.MinimumAvailability) ?? 3] ?? null,
      },
    ];
  });
}

// ---- the episodes and the downloads of the source ----

const stamp = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = str(value);
  const at = text ? Date.parse(text) : NaN;
  return Number.isFinite(at) ? at : 0;
};

function readEpisodes(db: DatabaseSync): Map<number, SourceEpisode[]> {
  const bySeries = new Map<number, SourceEpisode[]>();
  columns(db, 'Episodes', ['Id', 'SeriesId', 'SeasonNumber', 'EpisodeNumber', 'Monitored', 'AirDateUtc']);
  const rows = query(db, 'SELECT SeriesId, SeasonNumber, EpisodeNumber, Monitored, AirDateUtc FROM Episodes ORDER BY Id');
  for (const row of rows) {
    const seriesId = int(row.SeriesId);
    const season = int(row.SeasonNumber);
    const number = int(row.EpisodeNumber);
    if (seriesId === null || season === null || number === null) continue;
    const airDate = str(row.AirDateUtc);
    const list = bySeries.get(seriesId) ?? [];
    list.push({ season, number, monitored: Number(row.Monitored) === 1, airDateUtc: airDate && Number.isFinite(Date.parse(airDate)) ? airDate : null });
    bySeries.set(seriesId, list);
  }
  return bySeries;
}

type DownloadHistory = { id: number; date: number; failed: boolean };

// Groups the history rows by the title and the hash. A pack writes one row for each episode. The newest row of a hash
// tells if the last event failed.
function recordDownload(byTitle: Map<number, Map<string, SourceDownload>>, titleId: number, row: Row) {
  const hash = str(row.DownloadId)?.toLowerCase();
  if (!hash || !HASH.test(hash)) return;
  const byHash = byTitle.get(titleId) ?? new Map<string, SourceDownload>();
  const item = byHash.get(hash);
  const found: DownloadHistory = { id: int(row.Id) ?? 0, date: stamp(row.Date), failed: int(row.EventType) === 3 };
  if (!item) {
    const season = int(row.SeasonNumber);
    const number = int(row.EpisodeNumber);
    byHash.set(hash, {
      hash,
      episodes: season !== null && number !== null ? [{ season, number }] : [],
      at: found.date,
      id: found.id,
      failed: found.failed,
    });
  } else {
    const season = int(row.SeasonNumber);
    const number = int(row.EpisodeNumber);
    if (season !== null && number !== null && !item.episodes.some((episode) => episode.season === season && episode.number === number)) item.episodes.push({ season, number });
    if (found.id >= item.id) {
      item.id = found.id;
      item.at = found.date;
      item.failed = found.failed;
    }
  }
  byTitle.set(titleId, byHash);
}

function readSonarrDownloads(db: DatabaseSync): Map<number, SourceDownload[]> {
  const have = columns(db, 'History', ['Id', 'DownloadId', 'Date', 'EpisodeId']);
  columns(db, 'Episodes', ['Id', 'SeriesId', 'SeasonNumber', 'EpisodeNumber']);
  const event = have.has('EventType') ? 'h.EventType' : '0';
  const rows = query(db, `SELECT h.Id, h.DownloadId, h.Date, ${event} AS EventType, e.SeriesId, e.SeasonNumber, e.EpisodeNumber FROM History h JOIN Episodes e ON e.Id = h.EpisodeId ORDER BY h.Id LIMIT ${MAX_DOWNLOADS + 1}`);
  if (rows.length > MAX_DOWNLOADS) throw new SourceError('backup_too_large');
  const byTitle = new Map<number, Map<string, SourceDownload>>();
  for (const row of rows) {
    const seriesId = int(row.SeriesId);
    if (seriesId !== null) recordDownload(byTitle, seriesId, row);
  }
  return flatten(byTitle);
}

function readRadarrDownloads(db: DatabaseSync): Map<number, SourceDownload[]> {
  const have = columns(db, 'History', ['Id', 'DownloadId', 'Date', 'MovieId']);
  const event = have.has('EventType') ? 'h.EventType' : '0';
  const rows = query(db, `SELECT h.Id, h.DownloadId, h.Date, ${event} AS EventType, h.MovieId FROM History h WHERE h.MovieId IS NOT NULL ORDER BY h.Id LIMIT ${MAX_DOWNLOADS + 1}`);
  if (rows.length > MAX_DOWNLOADS) throw new SourceError('backup_too_large');
  const byTitle = new Map<number, Map<string, SourceDownload>>();
  for (const row of rows) {
    const movieId = int(row.MovieId);
    if (movieId !== null) recordDownload(byTitle, movieId, row);
  }
  return flatten(byTitle);
}

const flatten = (byTitle: Map<number, Map<string, SourceDownload>>) => new Map([...byTitle].map(([id, byHash]) => [id, [...byHash.values()]]));

const query = (db: DatabaseSync, sql: string) => db.prepare(sql).all() as Row[];

function titleRows(db: DatabaseSync, sql: string) {
  const rows = query(db, `${sql} LIMIT ${MAX_TITLES + 1}`);
  if (rows.length > MAX_TITLES) throw new SourceError('backup_too_large');
  return rows;
}

// Returns the columns of a table, and refuses a table that lacks a column which the import needs.
// The table must be a plain table. A view or a virtual table in a file from a user can run code that does not end,
// and the read blocks the process. The code calls this before it reads from a table.
function columns(db: DatabaseSync, table: string, needed: string[]) {
  const [definition] = query(db, `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = '${table}' COLLATE NOCASE`);
  if (!definition || /^\s*CREATE\s+VIRTUAL/i.test(String(definition.sql))) throw new SourceError('backup_database_invalid');
  const have = new Set(query(db, `PRAGMA table_info("${table}")`).map((row) => String(row.name)));
  if (!needed.every((name) => have.has(name))) throw new SourceError('backup_database_invalid');
  return have;
}

function readDatabase(path: string, app: SourceApp, name: string | undefined): SourceData {
  const db = new DatabaseSync(path, { readOnly: true, defensive: true });
  try {
    // FluentMigrator keeps the applied migrations in this table.
    columns(db, 'VersionInfo', ['Version']);
    const schema = Number(query(db, 'SELECT MAX(Version) AS version FROM VersionInfo')[0]?.version);
    const [oldest, newest] = SUPPORTED_SCHEMAS[app];
    if (!Number.isInteger(schema)) throw new SourceError('backup_database_invalid');
    if (schema < oldest || schema > newest) throw new SourceError('source_version_unsupported', `schema ${schema}`);

    // The name of a backup holds the version of the program. A name that the user changed holds none.
    const named = name ? new RegExp(`^${app}_backup_v(\\d+(?:\\.\\d+){1,3})_`, 'i').exec(name)?.[1] : undefined;
    if (named && !SUPPORTED_MAJORS[app].includes(Number(named.split('.')[0]))) throw new SourceError('source_version_unsupported', named);

    const titles = readTitles(db, app);
    // The episodes and the download hashes are facts of the source, not of the title. They stay off the record when
    // the source has none, so a source with no history gives the same titles as its API.
    if (app === 'sonarr') {
      const episodes = readEpisodes(db);
      const downloads = readSonarrDownloads(db);
      for (const title of titles) {
        const list = episodes.get(title.sourceId);
        if (list?.length) title.episodes = list;
        const hashes = downloads.get(title.sourceId);
        if (hashes?.length) title.downloads = hashes;
      }
    } else {
      const downloads = readRadarrDownloads(db);
      for (const title of titles) {
        const hashes = downloads.get(title.sourceId);
        if (hashes?.length) title.downloads = hashes;
      }
    }
    // The database holds no ID of the instance. The titles stand in for it, so one file always gives one namespace.
    // Two instances get one namespace only when their titles are the same. A newer backup of an instance gets another one.
    const fingerprint = createHash('sha256').update(`backup|${app}`);
    for (const title of titles) fingerprint.update(`|${title.sourceId}:${title.tmdbId ?? ''}:${title.tvdbId ?? ''}:${title.title}`);
    return {
      app,
      version: named ?? `schema ${schema}`,
      namespace: `${app}:${fingerprint.digest('hex').slice(0, 8)}`,
      titles,
      profiles: readProfiles(db, app),
    };
  } finally {
    db.close();
  }
}

// ---- reading the upload ----

// Writes the body to a file, and stops at the limit.
async function saveUpload(body: Readable, destination: string, maxBytes: number) {
  let total = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      total += chunk.length;
      done(total > maxBytes ? new SourceError('backup_too_large') : null, chunk);
    },
  });
  try {
    await pipeline(body, counter, createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
  } catch (err) {
    // A client that stops the upload ends here.
    throw err instanceof SourceError ? err : new SourceError('backup_invalid');
  }
}

const SQLITE_HEADER = 'SQLite format 3\0';

// Reads a backup ZIP of Sonarr or Radarr from a stream. The read is safe in four ways:
// the upload and the database have size limits, the code never uses a name from the archive as a path,
// the database is a copy that is opened read-only, and the copy is deleted at the end.
// The code does not open config.xml, so the API key in it is never read.
export async function readBackup(body: Readable, { name, limits = BACKUP_LIMITS }: { name?: string; limits?: BackupLimits } = {}): Promise<SourceData> {
  const dir = await mkdtemp(join(tmpdir(), 'ladarr-backup-'));
  try {
    const zip = join(dir, 'upload.zip');
    await saveUpload(body, zip, limits.zipBytes);

    const database = join(dir, 'source.db');
    let app: SourceApp;
    try {
      const entries = await listZip(zip, limits);
      const found = entries.filter((entry) => /^(sonarr|radarr)\.db$/i.test(entry.name));
      if (found.length !== 1) {
        // The programs before Sonarr 4 name the database nzbdrone.db.
        if (entries.some((entry) => /^nzbdrone\.db$/i.test(entry.name))) throw new SourceError('source_version_unsupported', 'nzbdrone.db');
        throw new SourceError('backup_no_database');
      }
      app = found[0]!.name.toLowerCase().startsWith('sonarr') ? 'sonarr' : 'radarr';
      await extractEntry(zip, found[0]!, database, limits);
    } catch (err) {
      throw err instanceof ZipError ? new SourceError(ZIP_ERRORS[err.code]) : err;
    }

    const file = await open(database, 'r');
    const header = Buffer.alloc(16);
    await file.read(header, 0, 16, 0).finally(() => file.close());
    if (header.toString('latin1') !== SQLITE_HEADER) throw new SourceError('backup_database_invalid');

    try {
      return readDatabase(database, app, name);
    } catch (err) {
      // A damaged database or a wrong layout can throw any error of SQLite or JSON.
      throw err instanceof SourceError ? err : new SourceError('backup_database_invalid');
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
