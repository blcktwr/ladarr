import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEvents } from '../../src/core/events.ts';
import { BACKUP_LIMITS, readBackup, SUPPORTED_SCHEMAS, type BackupLimits } from '../../src/migration/migration-backup.ts';
import { mapProfile, readFromApi, SourceError, type SourceData } from '../../src/migration/migration-source.ts';
import { buildPlan } from '../../src/migration/migration.ts';
import { migrationImportHandler } from '../../src/jobs/migration-import.ts';
import { startTestApp } from '../helpers/test-app.ts';
import { backupZip, CONFIG_XML, RADARR_MOVIES, radarrDatabase, SECRETS, SONARR_SERIES, sonarrDatabase } from '../helpers/test-backup.ts';
import { createTmdb } from '../../src/metadata/tmdb.ts';

// Every database in these tests is synthetic. See test-backup.ts. No test here reads a real backup of Sonarr or Radarr.

const NAME = 'sonarr_backup_v4.0.20.3014_2026.01.01_12.00.00.zip';
const stream = (zip: Buffer) => Readable.from([zip]);
const read = (zip: Buffer, options: Parameters<typeof readBackup>[1] = {}) => readBackup(stream(zip), options);
const code = (promise: Promise<unknown>) => promise.then(() => 'ok', (err: SourceError) => `${err.code}${err.detail ? `:${err.detail}` : ''}`);
const work = () => readdirSync(tmpdir()).filter((entry) => entry.startsWith('ladarr-backup-'));

const [sonarrFirst, sonarrLast] = SUPPORTED_SCHEMAS.sonarr;
const [radarrFirst, radarrLast] = SUPPORTED_SCHEMAS.radarr;

// ---- editing a ZIP file, to make archives that a real program never writes ----

const sig = (value: number) => {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
};

// Calls patch with the central directory record of one entry.
function patch(zip: Buffer, name: string, change: (record: Buffer) => void) {
  const copy = Buffer.from(zip);
  const end = copy.lastIndexOf(sig(0x06054b50));
  let at = copy.readUInt32LE(end + 16);
  while (copy.readUInt32LE(at) === 0x02014b50) {
    const length = 46 + copy.readUInt16LE(at + 28) + copy.readUInt16LE(at + 30) + copy.readUInt16LE(at + 32);
    if (copy.toString('utf8', at + 46, at + 46 + copy.readUInt16LE(at + 28)) === name) change(copy.subarray(at, at + length));
    at += length;
  }
  return copy;
}

// Runs one statement on a copy of a fixture, to make a database that does not match its schema number.
function without(database: Buffer, statement: string) {
  const dir = mkdtempSync(join(tmpdir(), 'ladarr-fixture-'));
  try {
    const path = join(dir, 'fixture.db');
    writeFileSync(path, database);
    const db = new DatabaseSync(path);
    db.exec(statement);
    db.close();
    return readFileSync(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('versioned fixtures', () => {
  it.each([sonarrFirst, sonarrLast])('reads a Sonarr database at schema %i', async (schema) => {
    const data = await read(backupZip(sonarrDatabase(schema)), { name: NAME });
    expect(data).toMatchObject({ app: 'sonarr', version: '4.0.20.3014' });
    expect(data.namespace).toMatch(/^sonarr:[0-9a-f]{8}$/);
    expect(data.titles).toHaveLength(3);
    expect(data.titles[0]).toEqual({
      sourceId: 1,
      mediaType: 'tv',
      title: 'Show 1',
      year: 2001,
      tmdbId: 5001,
      tvdbId: 1001,
      path: '/tv/Show 1',
      monitored: true,
      qualityProfileId: 1,
      seriesType: 'standard',
      seasons: [
        { seasonNumber: 0, monitored: false },
        { seasonNumber: 1, monitored: true },
        { seasonNumber: 2, monitored: false },
      ],
      minimumAvailability: null,
    });
    // A TMDB ID of 0 means that the source does not know it.
    expect(data.titles[1]).toMatchObject({ tmdbId: null, tvdbId: 1002, seriesType: 'anime', monitored: false });
    expect(data.titles[2]).toMatchObject({ seriesType: 'daily', path: 'D:\\TV\\Show 3' });
    expect(data.profiles.map((profile) => [profile.id, profile.name, mapProfile(profile)])).toEqual([
      [1, 'HD-1080p', { preset: 'p1080', notes: [] }],
      [2, 'Ultra-HD', { preset: 'p2160', notes: [] }],
      [3, 'Scored', { preset: 'p1080', notes: ['sources_not_supported', 'custom_formats'] }],
    ]);
  });

  it.each([radarrFirst, radarrLast])('reads a Radarr database at schema %i', async (schema) => {
    const data = await read(backupZip(radarrDatabase(schema), { name: 'radarr.db' }), { name: 'radarr_backup_v6.0.0.1_2026.01.01_12.00.00.zip' });
    expect(data).toMatchObject({ app: 'radarr', version: '6.0.0.1' });
    expect(data.titles[0]).toEqual({
      sourceId: 1,
      mediaType: 'movie',
      title: 'Movie 1',
      year: 2001,
      tmdbId: 9001,
      tvdbId: null,
      path: '/movies/Movie 1 (2001)',
      monitored: true,
      qualityProfileId: 1,
      seriesType: 'standard',
      seasons: [],
      minimumAvailability: 'released',
    });
    expect(data.titles[1]).toMatchObject({ monitored: false, minimumAvailability: 'inCinemas' });
    expect(data.profiles.map((profile) => [profile.name, mapProfile(profile)])).toEqual([
      ['HD Bluray + WEB', { preset: 'p1080', notes: [] }],
      ['Remux 2160p', { preset: 'p2160', notes: ['language_preference'] }],
    ]);
  });

  it('reads a database in WAL mode and a stored (not packed) entry', async () => {
    expect((await read(backupZip(sonarrDatabase(sonarrLast, { wal: true })))).titles).toHaveLength(3);
    expect((await read(backupZip(sonarrDatabase(sonarrLast), { level: 0 }))).titles).toHaveLength(3);
  });

  it('refuses a schema outside the tested range, and says which one', async () => {
    expect(await code(read(backupZip(sonarrDatabase(sonarrFirst - 1))))).toBe(`source_version_unsupported:schema ${sonarrFirst - 1}`);
    expect(await code(read(backupZip(sonarrDatabase(sonarrLast + 1))))).toBe(`source_version_unsupported:schema ${sonarrLast + 1}`);
    expect(await code(read(backupZip(radarrDatabase(radarrFirst - 1), { name: 'radarr.db' })))).toBe(`source_version_unsupported:schema ${radarrFirst - 1}`);
    expect(await code(read(backupZip(radarrDatabase(radarrLast + 1), { name: 'radarr.db' })))).toBe(`source_version_unsupported:schema ${radarrLast + 1}`);
  });

  it('refuses a major version in the file name that ladarr does not read', async () => {
    const zip = backupZip(sonarrDatabase(sonarrLast));
    expect(await code(read(zip, { name: 'sonarr_backup_v3.0.10.1567_2024.09.28_17.43.14.zip' }))).toBe('source_version_unsupported:3.0.10.1567');
    expect(await code(read(zip, { name: 'sonarr_backup_v5.0.0.1_2026.01.01_12.00.00.zip' }))).toBe('source_version_unsupported:5.0.0.1');
    // A name of another program, or a name that the user changed, gives no version. The schema decides.
    expect((await read(zip, { name: 'radarr_backup_v6.0.0.1_x.zip' })).version).toBe(`schema ${sonarrLast}`);
    expect((await read(zip, { name: 'backup.zip' })).version).toBe(`schema ${sonarrLast}`);
    expect((await read(zip)).version).toBe(`schema ${sonarrLast}`);
  });

  it('refuses the database name of Sonarr 3, an archive without a database, and an archive with two', async () => {
    const database = sonarrDatabase(sonarrLast);
    expect(await code(read(backupZip(database, { name: 'nzbdrone.db' })))).toBe('source_version_unsupported:nzbdrone.db');
    expect(await code(read(backupZip(database, { name: 'other.db' })))).toBe('backup_no_database');
    expect(await code(read(backupZip(database, { extra: { 'radarr.db': radarrDatabase(radarrLast) } })))).toBe('backup_no_database');
  });

  it('refuses a file that is not a database, a database without the migration table, and a table without a column', async () => {
    expect(await code(read(backupZip(Buffer.from('this is not a database'))))).toBe('backup_database_invalid');
    expect(await code(read(backupZip(sonarrDatabase(sonarrLast).subarray(0, 2000))))).toBe('backup_database_invalid');
    // The layout of Radarr in a file that is named for Sonarr.
    expect(await code(read(backupZip(radarrDatabase(sonarrLast))))).toBe('backup_database_invalid');
    expect(await code(read(backupZip(sonarrDatabase(radarrFirst), { name: 'radarr.db' })))).toBe('backup_database_invalid');
    expect(await code(read(backupZip(without(sonarrDatabase(sonarrLast), 'ALTER TABLE "Series" DROP COLUMN "TmdbId"'))))).toBe('backup_database_invalid');
    expect(await code(read(backupZip(without(sonarrDatabase(sonarrLast), 'DROP TABLE "VersionInfo"'))))).toBe('backup_database_invalid');
  });
});

describe('the episodes and the download hashes of a backup', () => {
  const pack = 'ABCDEF0123456789ABCDEF0123456789ABCDEF01';
  const failed = 'F'.repeat(40);
  const episodes = [
    { id: 1, seriesId: 1, seasonNumber: 1, episodeNumber: 1, monitored: true, airDateUtc: '2001-01-01T00:00:00Z' },
    { id: 2, seriesId: 1, seasonNumber: 1, episodeNumber: 2, monitored: false, airDateUtc: null },
    { id: 3, seriesId: 1, seasonNumber: 2, episodeNumber: 1, monitored: true, airDateUtc: '2002-01-01T00:00:00Z' },
  ];
  const history = [
    { id: 1, episodeId: 1, movieId: null, downloadId: pack, eventType: 1, date: '2001-01-02T00:00:00Z' },
    { id: 2, episodeId: 2, movieId: null, downloadId: pack, eventType: 1, date: '2001-01-02T00:00:00Z' },
    { id: 3, episodeId: 3, movieId: null, downloadId: pack, eventType: 1, date: '2001-01-02T00:00:00Z' },
    { id: 4, episodeId: 1, movieId: null, downloadId: 'not a hash', eventType: 1, date: '2001-01-02T00:00:00Z' },
    { id: 5, episodeId: 1, movieId: null, downloadId: failed, eventType: 3, date: '2001-01-03T00:00:00Z' },
    { id: 6, episodeId: 2, movieId: null, downloadId: failed, eventType: 3, date: '2001-01-03T00:00:00Z' },
    // An episode that the source does not list is not a target.
    { id: 7, episodeId: 999, movieId: null, downloadId: '1'.repeat(40), eventType: 1, date: '2001-01-03T00:00:00Z' },
  ];

  it('keeps the episodes of a Sonarr series, their monitoring, and their air date', async () => {
    const data = await read(backupZip(sonarrDatabase(sonarrLast, { episodes, history })));
    expect(data.titles[0]!.episodes).toEqual([
      { season: 1, number: 1, monitored: true, airDateUtc: '2001-01-01T00:00:00Z' },
      { season: 1, number: 2, monitored: false, airDateUtc: null },
      { season: 2, number: 1, monitored: true, airDateUtc: '2002-01-01T00:00:00Z' },
    ]);
  });

  it('groups the hashes of a pack by title and hash, lowercases them, and keeps the newest event', async () => {
    const data = await read(backupZip(sonarrDatabase(sonarrLast, { episodes, history })));
    const downloads = data.titles[0]!.downloads!;
    expect(downloads).toHaveLength(2);
    expect(downloads.find((download) => download.hash === pack.toLowerCase())).toMatchObject({
      episodes: [
        { season: 1, number: 1 },
        { season: 1, number: 2 },
        { season: 2, number: 1 },
      ],
      id: 3,
      failed: false,
    });
    expect(downloads.find((download) => download.hash === failed.toLowerCase())).toMatchObject({ id: 6, failed: true });
    // The invalid hash and the orphan episode are gone.
    expect(downloads.some((download) => download.hash === '1'.repeat(40))).toBe(false);
  });

  it('keeps the movie hash of a Radarr backup', async () => {
    const hash = 'C'.repeat(40);
    const data = await read(backupZip(radarrDatabase(radarrLast, { history: [{ id: 1, episodeId: null, movieId: 1, downloadId: hash, eventType: 1, date: '2001-01-02T00:00:00Z' }] }), { name: 'radarr.db' }));
    expect(data.titles[0]!.downloads).toEqual([{ hash: hash.toLowerCase(), episodes: [], at: Date.parse('2001-01-02T00:00:00Z'), id: 1, failed: false }]);
    expect(data.titles[1]!.downloads).toBeUndefined();
  });
});

describe('a database that tries to run code or to be too large', () => {
  // These views return a good answer. The code must refuse them for what they are, not for the answer.
  it('refuses a view or a virtual table in place of a table', async () => {
    const view = (table: string, select: string) => without(sonarrDatabase(sonarrLast), `ALTER TABLE "${table}" RENAME TO "${table}Real"; CREATE VIEW "${table}" AS ${select}`);
    expect(await code(read(backupZip(view('VersionInfo', `SELECT ${sonarrLast} AS Version`))))).toBe('backup_database_invalid');
    expect(await code(read(backupZip(view('Series', 'SELECT * FROM "SeriesReal"'))))).toBe('backup_database_invalid');
    expect(await code(read(backupZip(view('QualityProfiles', 'SELECT * FROM "QualityProfilesReal"'))))).toBe('backup_database_invalid');
    const virtual = without(sonarrDatabase(sonarrLast), `DROP TABLE "VersionInfo"; CREATE VIRTUAL TABLE "VersionInfo" USING fts5(Version); INSERT INTO "VersionInfo" VALUES ('${sonarrLast}')`);
    expect(await code(read(backupZip(virtual)))).toBe('backup_database_invalid');
  });

  it('refuses a library with more titles than the limit', async () => {
    const many = without(
      sonarrDatabase(sonarrLast),
      `WITH RECURSIVE n(i) AS (SELECT 4 UNION ALL SELECT i + 1 FROM n WHERE i < 100003)
       INSERT INTO "Series" ("Id", "TvdbId", "Title", "TitleSlug", "CleanTitle", "Path", "Monitored", "SeriesType", "QualityProfileId") SELECT i, i, 'S', 's' || i, 's', '/tv/' || i, 1, 0, 1 FROM n`,
    );
    expect(await code(read(backupZip(many)))).toBe('backup_too_large');
  });
});

describe('what the read keeps and what it deletes', () => {
  it('reads titles and profiles only: no credential, no API key, no other table', async () => {
    const data = await read(backupZip(sonarrDatabase(sonarrLast)), { name: NAME });
    const text = JSON.stringify(data);
    for (const secret of [...SECRETS, CONFIG_XML.match(/<ApiKey>(.*)<\/ApiKey>/)![1]!]) expect(text).not.toContain(secret);
    expect(Object.keys(data).sort()).toEqual(['app', 'namespace', 'profiles', 'titles', 'version']);
  });

  it('deletes its files after a good read and after each failure', async () => {
    const before = work();
    await read(backupZip(sonarrDatabase(sonarrLast)));
    await read(Buffer.from('not a zip')).catch(() => {});
    await read(backupZip(sonarrDatabase(sonarrLast - 1000))).catch(() => {});
    await readBackup(Readable.from([Buffer.alloc(10, 1)]), { limits: { ...BACKUP_LIMITS, zipBytes: 5 } }).catch(() => {});
    expect(work()).toEqual(before);
  });

  it('gives one file one namespace, and another instance another', async () => {
    const a = await read(backupZip(sonarrDatabase(sonarrLast)));
    expect((await read(backupZip(sonarrDatabase(sonarrLast)))).namespace).toBe(a.namespace);
    const other = SONARR_SERIES.map((series) => ({ ...series, title: `Other ${series.id}`, tvdbId: series.tvdbId + 100, tmdbId: series.tmdbId + 100 }));
    expect((await read(backupZip(sonarrDatabase(sonarrLast, { series: other })))).namespace).not.toBe(a.namespace);
    // Two instances can start with the same title. The rest of the titles must still tell them apart.
    const sameStart = [SONARR_SERIES[0]!, { ...SONARR_SERIES[1]!, title: 'Another show', tvdbId: 4242 }];
    expect((await read(backupZip(sonarrDatabase(sonarrLast, { series: sameStart })))).namespace).not.toBe(a.namespace);
  });
});

describe('the same data from the API and from the backup', () => {
  let server: Server;
  let url: string;
  beforeAll(async () => {
    const q = (id: number, name: string, source: string, resolution: number, allowed = true) => ({ quality: { id, name, source, resolution }, items: [], allowed });
    const group = (id: number, name: string, items: ReturnType<typeof q>[]) => ({ id, name, items, allowed: true });
    // The shapes that the API of Sonarr 4 sends, as in the OpenAPI file.
    const profiles = [
      { id: 1, name: 'HD-1080p', cutoff: 1002, minFormatScore: 0, formatItems: [], items: [q(1, 'SDTV', 'television', 480, false), group(1002, 'WEB 1080p', [q(15, 'WEBRip-1080p', 'webRip', 1080), q(3, 'WEBDL-1080p', 'web', 1080)])] },
      { id: 2, name: 'Ultra-HD', cutoff: 18, minFormatScore: 0, formatItems: [], items: [q(18, 'WEBDL-2160p', 'web', 2160)] },
      { id: 3, name: 'Scored', cutoff: 7, minFormatScore: 0, formatItems: [{ format: 4, name: 'x', score: 100 }], items: [q(7, 'Bluray-1080p', 'bluray', 1080), q(10, 'Raw-HD', 'televisionRaw', 1080)] },
    ];
    const types = ['standard', 'daily', 'anime'];
    const series = SONARR_SERIES.map((item) => ({ id: item.id, title: item.title, year: item.year, tvdbId: item.tvdbId, tmdbId: item.tmdbId, path: item.path, monitored: item.monitored, qualityProfileId: item.profile, seriesType: types[item.seriesType], seasons: item.seasons }));
    server = createServer((req, res) => {
      const body = req.url === '/api/v3/system/status' ? { appName: 'Sonarr', version: '4.0.20.3014' } : req.url === '/api/v3/series' ? series : req.url === '/api/v3/qualityprofile' ? profiles : {};
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  it('gives the same titles and profiles', async () => {
    const api = await readFromApi({ url, apiKey: 'k' });
    const backup = await read(backupZip(sonarrDatabase(sonarrLast)), { name: NAME });
    expect(backup.titles).toEqual(api.titles);
    expect(backup.profiles.map((profile) => ({ ...profile, formatItems: undefined }))).toEqual(api.profiles.map((profile) => ({ ...profile, formatItems: undefined })));
    expect(backup.profiles.map(mapProfile)).toEqual(api.profiles.map(mapProfile));
    expect(backup.profiles[2]!.formatItems).toEqual([{ score: 100 }]);
  });
});

describe('safe ZIP reading', () => {
  const database = sonarrDatabase(sonarrLast);
  const good = backupZip(database);

  it('refuses a file that is not a ZIP file, or is cut short, with a clear code', async () => {
    for (const bad of [Buffer.alloc(0), Buffer.from('hello'), Buffer.alloc(300, 7), good.subarray(0, good.length >> 1), good.subarray(0, good.length - 5)]) {
      expect(await code(read(bad))).toBe('backup_invalid');
    }
  });

  it('refuses a name that leaves the folder, before any file is made', async () => {
    const escape = `ladarr-escape-${process.pid}.db`;
    for (const name of [`../${escape}`, `/tmp/${escape}`, `a\\${escape}`, `C:${escape}`, `a/../../${escape}`]) {
      expect(await code(read(backupZip(database, { extra: { [name]: new Uint8Array(4) } })))).toBe('backup_unsafe');
    }
    expect(existsSync(join(tmpdir(), escape))).toBe(false);
  });

  it('refuses two entries with one name', async () => {
    expect(await code(read(backupZip(database, { extra: { 'SONARR.DB': database } })))).toBe('backup_unsafe');
  });

  it('refuses a link, encryption, ZIP64, and a method that is not stored or deflate', async () => {
    const link = Buffer.from(zipSync({ 'sonarr.db': [database, { os: 3, attrs: 0o120777 * 65536 }] }));
    expect(await code(read(link))).toBe('backup_unsafe');
    expect(await code(read(patch(good, 'sonarr.db', (record) => record.writeUInt16LE(record.readUInt16LE(8) | 1, 8))))).toBe('backup_unsupported');
    expect(await code(read(patch(good, 'sonarr.db', (record) => record.writeUInt16LE(12, 10))))).toBe('backup_unsupported');
    const zip64 = Buffer.from(good);
    zip64.writeUInt16LE(0xffff, zip64.lastIndexOf(sig(0x06054b50)) + 10);
    expect(await code(read(zip64))).toBe('backup_unsupported');
  });

  it('refuses an entry whose data does not match its checksum or its local header', async () => {
    expect(await code(read(patch(good, 'sonarr.db', (record) => record.writeUInt32LE((record.readUInt32LE(16) ^ 1) >>> 0, 16))))).toBe('backup_invalid');
    // Damage inside the packed data.
    const damaged = Buffer.from(good);
    damaged[damaged.indexOf(Buffer.from('sonarr.db')) + 9 + 50] ^= 0xff;
    expect(await code(read(damaged))).toBe('backup_invalid');
    // The central directory and the local header name different files.
    expect(await code(read(patch(good, 'sonarr.db', (record) => record.write('radarr.db', 46))))).toBe('backup_invalid');
    // The central directory points to the wrong entry.
    expect(await code(read(patch(good, 'sonarr.db', (record) => record.writeUInt32LE(record.readUInt32LE(42) + 1, 42))))).toBe('backup_invalid');
  });

  it('stops a ZIP bomb by its ratio, even when the headers tell the truth', async () => {
    const bomb = backupZip(Buffer.alloc(8 * 1024 * 1024));
    expect(bomb.length).toBeLessThan(64 * 1024);
    expect(await code(read(bomb))).toBe('backup_too_large');
  });

  it('stops a ZIP bomb that lies about its size, by the count of the real bytes', async () => {
    // The ratio of the header is small (1000 / packed), so only the count can stop this entry.
    const lie = patch(backupZip(Buffer.alloc(8 * 1024 * 1024)), 'sonarr.db', (record) => {
      record.writeUInt32LE(1000, 24);
      record.writeUInt32LE(record.readUInt32LE(20) / 2, 20);
    });
    // The packed size is wrong too, so the data is cut. Either way the read must refuse and not grow.
    expect(await code(read(lie))).toMatch(/^backup_(too_large|invalid)$/);

    const smaller = patch(backupZip(database), 'sonarr.db', (record) => record.writeUInt32LE(1000, 24));
    expect(await code(read(smaller))).toBe('backup_too_large');
  });

  it('applies the limits of the caller', async () => {
    const limits = (change: Partial<BackupLimits>): BackupLimits => ({ ...BACKUP_LIMITS, ...change });
    expect(await code(read(good, { limits: limits({ zipBytes: good.length - 1 }) }))).toBe('backup_too_large');
    expect(await code(read(good, { limits: limits({ zipBytes: good.length }) }))).toBe('ok');
    expect(await code(read(good, { limits: limits({ entryBytes: database.length - 1 }) }))).toBe('backup_too_large');
    expect(await code(read(good, { limits: limits({ entries: 1 }) }))).toBe('backup_too_large');
    expect(await code(read(good, { limits: limits({ ratio: 1 }) }))).toBe('backup_too_large');
  });

  it('does not write the archive to a path from the archive, and does not read config.xml', async () => {
    // The key in config.xml never reaches the result, and a bad config.xml does not matter.
    const broken = backupZip(database, { extra: { 'config.xml': new Uint8Array([0xff, 0xfe, 0x00]) } });
    expect((await read(broken)).titles).toHaveLength(3);
  });
});

// ---- through the API ----

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const tmdbFetch = (async (input: URL | string) => {
  const path = new URL(String(input)).pathname.replace('/3', '');
  if (path === '/find/1002') return json({ tv_results: [{ id: 7002, name: 'Found by TVDB' }] });
  const show = /^\/tv\/(\d+)$/.exec(path);
  if (show) return json({ id: Number(show[1]), name: `Series ${show[1]}`, first_air_date: '2000-01-01', status: 'Ended', seasons: [] });
  const movie = /^\/movie\/(\d+)$/.exec(path);
  if (movie) return json({ id: Number(movie[1]), title: `Movie ${movie[1]}`, release_date: '2000-01-01', status: 'Released' });
  return json({}, 404);
}) as unknown as typeof fetch;

describe('backup through the API', () => {
  let app: Awaited<ReturnType<typeof startTestApp>>;
  let dir: string;
  let runImport: () => Promise<void>;
  const events = createEvents();

  beforeAll(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'ladarr-migration-backup-')));
    for (const folder of ['tv/Show 1', 'tv/Show 2', 'tv/Show 3', 'movies/Movie 1 (2001)']) mkdirSync(join(dir, folder), { recursive: true });
    const tmdb = createTmdb({ apiKey: 'k', fetch: tmdbFetch, baseUrl: 'https://tmdb.test/3', spacingMs: 0, ttlMs: 0 });
    app = await startTestApp({ tmdb, events });
    await app.post('/roots', { path: join(dir, 'tv'), mediaType: 'tv' });
    await app.post('/roots', { path: join(dir, 'movies'), mediaType: 'movie' });
    const handler = migrationImportHandler({ db: app.db, tmdb, events, save: async () => {}, enqueue: () => ({}) as never });
    runImport = () => handler.run({} as never, { signal: new AbortController().signal });
  });
  afterAll(() => {
    app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function upload(body: Buffer, { name = NAME, type = 'application/zip' } = {}) {
    const { csrfToken } = await (await fetch(`${app.base}/auth/status`, { headers: { cookie: app.cookie } })).json();
    const res = await fetch(`${app.base}/migration/backup?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { cookie: app.cookie, 'x-csrf-token': csrfToken, 'content-type': type }, body: new Blob([new Uint8Array(body)]) });
    return { status: res.status, body: (await res.json()) as any };
  }
  const mappings = () => [
    { from: '/tv', to: join(dir, 'tv') },
    { from: 'D:\\TV', to: join(dir, 'tv') },
    { from: '/movies', to: join(dir, 'movies') },
  ];
  const sonarr = () => backupZip(sonarrDatabase(sonarrLast));
  const row = (body: { rows: { sourceId: number }[] }, id: number) => body.rows.find((r) => r.sourceId === id) as any;

  it('sends a backup, shows a preview that changes nothing, and imports with the same ledger as the API', async () => {
    const sent = await upload(sonarr());
    expect(sent).toMatchObject({ status: 200, body: { app: 'sonarr', version: '4.0.20.3014', titles: 3 } });

    const before = JSON.stringify(app.db.data);
    const { status, body } = await app.post('/migration/preview', { backupId: sent.body.backupId, mappings: mappings() });
    expect(status).toBe(200);
    expect(JSON.stringify(app.db.data)).toBe(before);
    expect(body).toMatchObject({ app: 'sonarr', version: '4.0.20.3014', counts: { new: 3 } });
    expect(row(body, 1)).toMatchObject({ status: 'new', match: 'tmdb', preset: 'p1080', pathStatus: 'ok', mappedPath: join(dir, 'tv', 'Show 1'), notes: ['episode_monitoring'] });
    expect(row(body, 2)).toMatchObject({ status: 'new', match: 'tvdb', tmdbId: 7002, pathStatus: 'ok', preset: 'p2160' });
    expect(row(body, 3)).toMatchObject({ mappedPath: join(dir, 'tv', 'Show 3'), pathStatus: 'ok', notes: expect.arrayContaining(['daily_series_type', 'sources_not_supported', 'custom_formats']) });

    expect((await app.post('/migration/import', { planId: body.planId })).body.queued).toBe(3);
    await runImport();
    expect(app.db.data.titles['tv:5001']).toMatchObject({ folder: 'Show 1', preset: 'p1080', paused: false, seriesType: 'standard', seasonOverrides: { 2: 'unmonitored' } });
    expect(app.db.data.titles['tv:7002']).toMatchObject({ paused: true, seriesType: 'anime' });
    expect(Object.keys(app.db.data.ledger).every((key) => /^sonarr:[0-9a-f]{8}:\d+$/.test(key))).toBe(true);
    expect(JSON.stringify(app.db.data)).not.toContain('SECRET');
  });

  it('skips what is done when the same file comes again, and adds nothing twice', async () => {
    const titles = Object.keys(app.db.data.titles);
    const ledger = Object.keys(app.db.data.ledger);
    const sent = await upload(sonarr());
    const { body } = await app.post('/migration/preview', { backupId: sent.body.backupId, mappings: mappings() });
    expect(body.counts).toMatchObject({ new: 0, imported: 3 });
    expect((await app.post('/migration/import', { planId: body.planId })).body.queued).toBe(0);
    expect(Object.keys(app.db.data.titles)).toEqual(titles);
    expect(Object.keys(app.db.data.ledger)).toEqual(ledger);
  });

  it('does not take a source ID for done when another instance has the same ID', async () => {
    // The ledger entry is for Show 1. A source with the same namespace and ID but another title must not match it.
    const tmdb = createTmdb({ apiKey: 'k', fetch: tmdbFetch, baseUrl: 'https://tmdb.test/3', spacingMs: 0, ttlMs: 0 });
    const [key, entry] = Object.entries(app.db.data.ledger).find(([, candidate]) => candidate.sourceId === 1)!;
    expect(entry.status).toBe('imported');
    const source: SourceData = { app: 'sonarr', version: 'x', namespace: key.replace(/:1$/, ''), profiles: [], titles: [{ ...(await read(sonarr())).titles[0]!, tmdbId: 6001, tvdbId: null }] };
    const { rows } = await buildPlan(app.db, tmdb, source, []);
    expect(rows[0]).toMatchObject({ ledgerKey: key, status: 'new' });
  });

  it('reads a Radarr backup', async () => {
    const sent = await upload(backupZip(radarrDatabase(radarrLast), { name: 'radarr.db' }), { name: 'radarr_backup_v6.0.0.1_2026.01.01_12.00.00.zip' });
    expect(sent.body).toMatchObject({ app: 'radarr', version: '6.0.0.1', titles: RADARR_MOVIES.length });
    const { body } = await app.post('/migration/preview', { backupId: sent.body.backupId, mappings: mappings() });
    expect(row(body, 1)).toMatchObject({ mediaType: 'movie', status: 'new', preset: 'p1080', pathStatus: 'ok', notes: [] });
    expect(row(body, 2)).toMatchObject({ preset: 'p2160', pathStatus: 'missing', notes: ['language_preference', 'minimum_availability'] });
  });

  it('refuses a bad file with a clear code', async () => {
    expect(await upload(Buffer.from('nope'))).toMatchObject({ status: 400, body: { error: 'backup_invalid' } });
    expect(await upload(backupZip(sonarrDatabase(sonarrFirst - 1)))).toMatchObject({ status: 400, body: { error: 'source_version_unsupported', detail: `schema ${sonarrFirst - 1}` } });
    expect(await upload(backupZip(Buffer.from('x'), { name: 'other.db' }))).toMatchObject({ status: 400, body: { error: 'backup_no_database' } });
    expect(await upload(backupZip(sonarrDatabase(sonarrLast), { extra: { '../evil': new Uint8Array(1) } }))).toMatchObject({ status: 400, body: { error: 'backup_unsafe' } });
    expect(await upload(sonarr(), { type: 'text/plain' })).toMatchObject({ status: 400, body: { error: 'backup_invalid' } });
  });

  it('refuses a body that is too large before it reads the body', async () => {
    const { csrfToken } = await (await fetch(`${app.base}/auth/status`, { headers: { cookie: app.cookie } })).json();
    const url = new URL(`${app.base}/migration/backup`);
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(url, { method: 'POST', headers: { cookie: app.cookie, 'x-csrf-token': csrfToken, 'content-type': 'application/zip', 'content-length': String(BACKUP_LIMITS.zipBytes + 1) } }, (res) => {
        res.resume();
        resolve(res.statusCode!);
        req.destroy();
      });
      req.on('error', (err) => ((err as NodeJS.ErrnoException).code === 'ECONNRESET' ? undefined : reject(err)));
      req.flushHeaders();
    });
    expect(status).toBe(413);
  });

  it('reads one backup at a time', async () => {
    const { csrfToken } = await (await fetch(`${app.base}/auth/status`, { headers: { cookie: app.cookie } })).json();
    const url = new URL(`${app.base}/migration/backup`);
    // The first request sends a part of its body and waits.
    const first = request(url, { method: 'POST', headers: { cookie: app.cookie, 'x-csrf-token': csrfToken, 'content-type': 'application/zip', 'transfer-encoding': 'chunked' } });
    const done = new Promise<number>((resolve, reject) => {
      first.on('response', (res) => {
        res.resume();
        resolve(res.statusCode!);
      });
      first.on('error', reject);
    });
    first.write(Buffer.alloc(10));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect((await upload(sonarr())).status).toBe(429);
    first.end();
    expect(await done).toBe(400);
    expect((await upload(sonarr())).status).toBe(200);
  });

  it('refuses a preview with an unknown backup, or with no source', async () => {
    expect((await app.post('/migration/preview', { backupId: 'nope', mappings: [] })).status).toBe(404);
    expect((await app.post('/migration/preview', { mappings: [] })).status).toBe(400);
    expect((await app.post('/migration/preview', { backupId: 'nope', mappings: 'x' })).status).toBe(400);
  });
});
