import type { RequestHandler } from 'express';
import { parsePush, type IndexerApp } from '../../../../../library/grab/indexers.ts';

// The test only checks the body. The address is the address of the indexer manager, so ladarr does not call it here.
export function indexerTest(app: IndexerApp): RequestHandler {
  return (req, res) => {
    const body = req.body as { implementation?: string };
    if (body?.implementation === 'Newznab') return void res.json({});
    const parsed = parsePush(app, body);
    if ('errors' in parsed) return void res.status(400).json(parsed.errors);
    res.json({});
  };
}
