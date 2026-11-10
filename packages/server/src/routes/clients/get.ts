import { get } from '../../core/db.ts';
import type { RequestHandler } from 'express';
import { view } from '../../helpers/clients.ts';

export function clientsGet(): RequestHandler {
  const db = get();
  return (_req, res) => void res.json({ clients: db.data.downloadClients.map(view) });
}
