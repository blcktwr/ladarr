import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { zipSync, type Zippable } from 'fflate';

// SYNTHETIC FIXTURES. These databases are not backups of a real Sonarr or Radarr.
// The tables and columns come from the public migration files of each program:
// https://github.com/Sonarr/Sonarr (src/NzbDrone.Core/Datastore/Migration) and https://github.com/Radarr/Radarr (same folder).
// Each fixture holds only some of the real columns: the columns that the import reads, a few columns next to them,
// and tables with secrets that the import must never read. A real backup of each version is still necessary.

// ---- profiles. The Items column holds the quality as an ID, as QualityIntConverter writes it. ----

const leaf = (quality: number, allowed = true) => ({ quality, items: [], allowed });
const group = (id: number, name: string, qualities: number[], allowed = true) => ({ id, name, items: qualities.map((quality) => leaf(quality)), allowed });

export const SONARR_PROFILES = [
  // WEB 1080p group as cutoff, upgrades on.
  { id: 1, name: 'HD-1080p', upgrade: 1, cutoff: 1002, items: [leaf(1, false), group(1002, 'WEB 1080p', [15, 3])] },
  { id: 2, name: 'Ultra-HD', upgrade: 0, cutoff: 18, items: [leaf(18)] },
  // A profile with a custom format score and a source that ladarr does not use.
  { id: 3, name: 'Scored', upgrade: 0, cutoff: 7, items: [leaf(7), leaf(10)], formats: [{ format: 4, score: 100 }] },
];

export const RADARR_PROFILES = [
  { id: 1, name: 'HD Bluray + WEB', upgrade: 1, cutoff: 7, items: [leaf(7), group(1001, 'WEB 1080p', [15, 3])], language: -1 },
  { id: 2, name: 'Remux 2160p', upgrade: 0, cutoff: 31, items: [leaf(31)], language: 1 },
];

// ---- the data ----

export type FixtureSeries = { id: number; title: string; year: number; tvdbId: number; tmdbId: number; path: string; monitored: boolean; profile: number; seriesType: 0 | 1 | 2; seasons: { seasonNumber: number; monitored: boolean }[] };
export type FixtureMovie = { id: number; title: string; year: number; tmdbId: number; path: string; monitored: boolean; profile: number; availability: number };
export type FixtureEpisode = { id: number; seriesId: number; seasonNumber: number; episodeNumber: number; monitored: boolean; airDateUtc: string | null };
export type FixtureHistory = { id: number; episodeId: number | null; movieId: number | null; downloadId: string; eventType: number; date: string };

const seasons = [
  { seasonNumber: 0, monitored: false },
  { seasonNumber: 1, monitored: true },
  { seasonNumber: 2, monitored: false },
];

export const SONARR_SERIES: FixtureSeries[] = [
  { id: 1, title: 'Show 1', year: 2001, tvdbId: 1001, tmdbId: 5001, path: '/tv/Show 1', monitored: true, profile: 1, seriesType: 0, seasons },
  { id: 2, title: 'Show 2', year: 2002, tvdbId: 1002, tmdbId: 0, path: '/tv/Show 2', monitored: false, profile: 2, seriesType: 2, seasons },
  { id: 3, title: 'Show 3', year: 2003, tvdbId: 1003, tmdbId: 5003, path: 'D:\\TV\\Show 3', monitored: true, profile: 3, seriesType: 1, seasons },
];

export const RADARR_MOVIES: FixtureMovie[] = [
  { id: 1, title: 'Movie 1', year: 2001, tmdbId: 9001, path: '/movies/Movie 1 (2001)', monitored: true, profile: 1, availability: 3 },
  { id: 2, title: 'Movie 2', year: 2002, tmdbId: 9002, path: '/movies/Movie 2 (2002)', monitored: false, profile: 2, availability: 2 },
];

// ---- the databases ----

// Secrets that sit in other tables of a real database. A test makes sure that none of them reaches the result.
export const SECRETS = ['SECRET-INDEXER-KEY', 'SECRET-CLIENT-PASSWORD', 'SECRET-USER-HASH'];

function build(create: (db: DatabaseSync) => void, wal: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'ladarr-fixture-'));
  try {
    const path = join(dir, 'fixture.db');
    const db = new DatabaseSync(path);
    if (wal) db.exec('PRAGMA journal_mode = WAL');
    create(db);
    if (wal) db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
    return readFileSync(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function common(db: DatabaseSync, schema: number) {
  db.exec(`CREATE TABLE "VersionInfo" ("Version" INTEGER NOT NULL, "AppliedOn" DATETIME, "Description" TEXT)`);
  db.prepare('INSERT INTO "VersionInfo" VALUES (?, ?, ?)').run(1, '2020-01-01T00:00:00Z', 'initial_setup');
  db.prepare('INSERT INTO "VersionInfo" VALUES (?, ?, ?)').run(schema, '2025-01-01T00:00:00Z', 'latest');
  // Tables that a real database has and the import must not read.
  db.exec(`CREATE TABLE "Indexers" ("Id" INTEGER PRIMARY KEY, "Name" TEXT, "Settings" TEXT)`);
  db.prepare('INSERT INTO "Indexers" VALUES (1, ?, ?)').run('Indexer', JSON.stringify({ apiKey: SECRETS[0] }));
  db.exec(`CREATE TABLE "DownloadClients" ("Id" INTEGER PRIMARY KEY, "Name" TEXT, "Settings" TEXT)`);
  db.prepare('INSERT INTO "DownloadClients" VALUES (1, ?, ?)').run('Client', JSON.stringify({ password: SECRETS[1] }));
  db.exec(`CREATE TABLE "Users" ("Id" INTEGER PRIMARY KEY, "Identifier" TEXT, "Username" TEXT, "Password" TEXT)`);
  db.prepare('INSERT INTO "Users" VALUES (1, ?, ?, ?)').run('id', 'owner', SECRETS[2]);
}

// The episodes of a Sonarr series and the history of the downloads. A history row names an episode or a movie.
function downloads(db: DatabaseSync, episodes: FixtureEpisode[], history: FixtureHistory[]) {
  db.exec(`CREATE TABLE "Episodes" ("Id" INTEGER PRIMARY KEY, "SeriesId" INTEGER NOT NULL, "SeasonNumber" INTEGER NOT NULL, "EpisodeNumber" INTEGER NOT NULL, "Monitored" INTEGER NOT NULL, "AirDateUtc" TEXT)`);
  for (const episode of episodes) {
    db.prepare('INSERT INTO "Episodes" ("Id", "SeriesId", "SeasonNumber", "EpisodeNumber", "Monitored", "AirDateUtc") VALUES (?, ?, ?, ?, ?, ?)').run(
      episode.id,
      episode.seriesId,
      episode.seasonNumber,
      episode.episodeNumber,
      episode.monitored ? 1 : 0,
      episode.airDateUtc,
    );
  }
  db.exec(`CREATE TABLE "History" ("Id" INTEGER PRIMARY KEY, "DownloadId" TEXT, "Date" TEXT, "EpisodeId" INTEGER, "MovieId" INTEGER, "EventType" INTEGER NOT NULL DEFAULT 0)`);
  for (const row of history) {
    db.prepare('INSERT INTO "History" ("Id", "DownloadId", "Date", "EpisodeId", "MovieId", "EventType") VALUES (?, ?, ?, ?, ?, ?)').run(
      row.id,
      row.downloadId,
      row.date,
      row.episodeId,
      row.movieId,
      row.eventType,
    );
  }
}

type Profile = { id: number; name: string; upgrade: number; cutoff: number; items: unknown[]; formats?: unknown[]; language?: number };

function profiles(db: DatabaseSync, list: Profile[], { upgradeColumn, language }: { upgradeColumn: boolean; language: boolean }) {
  db.exec(
    `CREATE TABLE "QualityProfiles" ("Id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "Name" TEXT NOT NULL, "Cutoff" INTEGER NOT NULL, "Items" TEXT NOT NULL, "UpgradeAllowed" INTEGER, "MinFormatScore" INTEGER NOT NULL DEFAULT 0, "CutoffFormatScore" INTEGER NOT NULL DEFAULT 0, "FormatItems" TEXT NOT NULL DEFAULT '[]'${
      upgradeColumn ? `, "MinUpgradeFormatScore" INTEGER NOT NULL DEFAULT 1` : ''
    }${language ? `, "Language" INTEGER` : ''})`,
  );
  for (const profile of list) {
    db.prepare(`INSERT INTO "QualityProfiles" ("Id", "Name", "Cutoff", "Items", "UpgradeAllowed", "FormatItems"${language ? ', "Language"' : ''}) VALUES (?, ?, ?, ?, ?, ?${language ? ', ?' : ''})`).run(
      profile.id,
      profile.name,
      profile.cutoff,
      JSON.stringify(profile.items),
      profile.upgrade,
      JSON.stringify(profile.formats ?? []),
      ...(language ? [profile.language ?? -1] : []),
    );
  }
}

// A Sonarr database at one migration number. Sonarr 4 adds TmdbId in 206, MinUpgradeFormatScore in 212, and PendingPath in 234.
export function sonarrDatabase(schema: number, { series = SONARR_SERIES, episodes = [], history = [], wal = false }: { series?: FixtureSeries[]; episodes?: FixtureEpisode[]; history?: FixtureHistory[]; wal?: boolean } = {}) {
  return build((db) => {
    common(db, schema);
    profiles(db, SONARR_PROFILES, { upgradeColumn: schema >= 212, language: false });
    downloads(db, episodes, history);
    db.exec(
      `CREATE TABLE "Series" ("Id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "TvdbId" INTEGER NOT NULL, "TvRageId" INTEGER NOT NULL DEFAULT 0, "ImdbId" TEXT, "Title" TEXT NOT NULL, "TitleSlug" TEXT NOT NULL, "CleanTitle" TEXT NOT NULL, "Status" INTEGER NOT NULL DEFAULT 0, "Overview" TEXT, "Images" TEXT NOT NULL DEFAULT '[]', "Path" TEXT NOT NULL, "Monitored" INTEGER NOT NULL, "SeasonFolder" INTEGER NOT NULL DEFAULT 1, "Runtime" INTEGER NOT NULL DEFAULT 0, "SeriesType" INTEGER NOT NULL, "UseSceneNumbering" INTEGER NOT NULL DEFAULT 0, "Year" INTEGER, "Seasons" TEXT, "QualityProfileId" INTEGER NOT NULL, "Tags" TEXT, "Added" DATETIME, "TmdbId" INTEGER NOT NULL DEFAULT 0, "MonitorNewItems" INTEGER NOT NULL DEFAULT 0${
        schema >= 234 ? `, "PendingPath" TEXT` : ''
      })`,
    );
    for (const item of series) {
      db.prepare(
        `INSERT INTO "Series" ("Id", "TvdbId", "Title", "TitleSlug", "CleanTitle", "Path", "Monitored", "SeriesType", "Year", "Seasons", "QualityProfileId", "TmdbId") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(item.id, item.tvdbId, item.title, `slug-${item.id}`, item.title.toLowerCase(), item.path, item.monitored ? 1 : 0, item.seriesType, item.year, JSON.stringify(item.seasons), item.profile, item.tmdbId);
    }
  }, wal);
}

// A Radarr database at one migration number. Radarr calls the table QualityProfiles from 230, and adds MinUpgradeFormatScore in 239.
export function radarrDatabase(schema: number, { movies = RADARR_MOVIES, history = [], wal = false }: { movies?: FixtureMovie[]; history?: FixtureHistory[]; wal?: boolean } = {}) {
  return build((db) => {
    common(db, schema);
    profiles(db, RADARR_PROFILES, { upgradeColumn: schema >= 239, language: true });
    downloads(db, [], history);
    db.exec(
      `CREATE TABLE "MovieMetadata" ("Id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "TmdbId" INTEGER NOT NULL UNIQUE, "ImdbId" TEXT, "Images" TEXT NOT NULL DEFAULT '[]', "Title" TEXT NOT NULL, "CleanTitle" TEXT, "OriginalLanguage" INTEGER NOT NULL DEFAULT 1, "Status" INTEGER NOT NULL DEFAULT 0, "Runtime" INTEGER NOT NULL DEFAULT 0, "Year" INTEGER, "Recommendations" TEXT NOT NULL DEFAULT '[]'${
        schema >= 242 ? `, "Keywords" TEXT` : ''
      })`,
    );
    db.exec(
      `CREATE TABLE "Movies" ("Id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "Path" TEXT NOT NULL, "Monitored" INTEGER NOT NULL, "QualityProfileId" INTEGER NOT NULL, "MinimumAvailability" INTEGER NOT NULL, "Added" DATETIME, "Tags" TEXT, "MovieFileId" INTEGER NOT NULL DEFAULT 0, "MovieMetadataId" INTEGER NOT NULL DEFAULT 0${schema >= 234 ? `, "LastSearchTime" DATETIME` : ''})`,
    );
    for (const movie of movies) {
      db.prepare(`INSERT INTO "MovieMetadata" ("Id", "TmdbId", "Title", "CleanTitle", "Year") VALUES (?, ?, ?, ?, ?)`).run(movie.id, movie.tmdbId, movie.title, movie.title.toLowerCase(), movie.year);
      db.prepare(`INSERT INTO "Movies" ("Id", "Path", "Monitored", "QualityProfileId", "MinimumAvailability", "MovieMetadataId") VALUES (?, ?, ?, ?, ?, ?)`).run(
        movie.id,
        movie.path,
        movie.monitored ? 1 : 0,
        movie.profile,
        movie.availability,
        movie.id,
      );
    }
  }, wal);
}

// ---- the archive ----

export const CONFIG_XML = `<Config><ApiKey>${'0123456789abcdef'.repeat(2)}</ApiKey><UrlBase></UrlBase></Config>`;

// A flat archive, as the program writes it: the database and config.xml.
export function backupZip(database: Uint8Array, { name = 'sonarr.db', extra = {} as Zippable, level = 6 as 0 | 6 } = {}) {
  return Buffer.from(zipSync({ 'config.xml': new TextEncoder().encode(CONFIG_XML), [name]: database, ...extra }, { level }));
}
