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
    // The page in development runs on its own port, so the server allows that page, also from another host on the network.
    devOrigin: process.env.LADARR_DEV_ORIGIN,
    // The Sonarr, Radarr and Seerr ports. Set LADARR_COMPAT_PORTS=0 to turn them off.
    proxy: process.env.LADARR_COMPAT_PORTS !== '0',
    // The key is the constant in the source on purpose. There is no environment variable.
    tmdbApiKey: TMDB_API_KEY,
    // Only the end-to-end tests set this, to point the server at a local fake.
    tmdbBaseUrl: process.env.LADARR_TMDB_BASE_URL?.trim() || undefined,
    urlBase: (process.env.LADARR_URL_BASE ?? '').replace(/\/+$/, ''),
  };
}
