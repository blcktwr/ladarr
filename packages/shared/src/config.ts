import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { TMDB_API_KEY } from './constants.ts';

export function loadConfig() {
  const configDir = process.env.LADARR_CONFIG_DIR ?? join(process.cwd(), 'config');
  mkdirSync(configDir, { recursive: true });
  return {
    configDir,
    dbFile: join(configDir, 'db.json'),
    queueFile: join(configDir, 'queue.json'),
    backupDir: join(configDir, 'backups'),
    logFile: join(configDir, 'logs', 'ladarr.log'),
    webDir: process.env.LADARR_WEB_DIR,
    port: Number(process.env.PORT ?? 3000),
    // The default key is in the source on purpose, so a container needs no env var. TMDB_API_KEY overrides it.
    tmdbApiKey: process.env.TMDB_API_KEY?.trim() || TMDB_API_KEY,
    // Only the end-to-end tests set this, to point the server at a local fake.
    tmdbBaseUrl: process.env.LADARR_TMDB_BASE_URL?.trim() || undefined,
    urlBase: (process.env.LADARR_URL_BASE ?? '').replace(/\/+$/, ''),
  };
}
