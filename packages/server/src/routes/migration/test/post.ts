import type { RequestHandler } from 'express';
import { testConnection } from '../../../migration/migration-source.ts';
import { parseConnection } from '../../../helpers/migration.ts';

export function migrationTest(): RequestHandler {
  return async (req, res) => {
    const connection = parseConnection(req.body);
    if (!connection) return void res.status(400).json({ error: 'invalid_connection' });
    res.json(await testConnection(connection));
  };
}
