import { db } from '../../../../core/db.ts';
import type { RequestHandler } from 'express';

// The edit form shows the key of an indexer that the user added. The list and the answers to a change never hold it.
export function indexerKeyGet(): RequestHandler<{ id: string }> {
  return (req, res) => {
    const indexer = db.data.indexers[Number(req.params.id)];
    if (!indexer?.manual) return void res.status(404).json({ error: 'not_found' });
    res.json({ apiKey: indexer.apiKey });
  };
}
