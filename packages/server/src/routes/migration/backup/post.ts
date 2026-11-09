import { randomUUID } from 'node:crypto';
import type { MigrationBackup } from '@ladarr/shared/types';
import type { RequestHandler } from 'express';
import { BACKUP_LIMITS, readBackup } from '../../../migration/migration-backup.ts';
import { SourceError } from '../../../migration/migration-source.ts';
import { MAX_UPLOADS, uploads } from '../../../helpers/migration.ts';

let reading = false;

// The body is the ZIP file. The name of the file is in the query, because the version of the program is in the name.
export function migrationBackup(): RequestHandler {
  return async (req, res) => {
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
  };
}
