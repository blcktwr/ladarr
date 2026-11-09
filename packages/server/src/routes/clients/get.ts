import type { RequestHandler } from 'express';
import type { Db } from '../../core/db.ts';
import { view } from '../../helpers/clients.ts';

export function clientsGet(db: Db): RequestHandler {
  return (_req, res) => void res.json({ clients: db.data.downloadClients.map(view) });
}
