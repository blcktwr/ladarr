import { db } from '../../../../../core/db.ts';
import type { RequestHandler } from 'express';
import type { IndexerApp } from '../../../../../library/grab/indexers.ts';
import { resource } from '../../../../../helpers/indexers-adapter.ts';

export function indexerGet(app: IndexerApp): RequestHandler<{ id: string }> {
  return (req, res) => {
    const indexer = db.data.indexers[Number(req.params.id)];
    if (!indexer?.push[app]) return void res.status(404).json({ message: 'NotFound' });
    res.json(resource(app, indexer));
  };
}
