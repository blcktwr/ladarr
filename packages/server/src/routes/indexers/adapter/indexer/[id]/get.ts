import { db } from '../../../../../core/db.ts';
import type { RequestHandler } from 'express';
import { resource } from '../../../../../helpers/indexers-adapter.ts';
import type { IndexerApp } from '@ladarr/shared/enums';

export function indexerGet(app: IndexerApp): RequestHandler<{ id: string }> {
  return (req, res) => {
    const indexer = db.data.indexers[Number(req.params.id)];
    if (!indexer?.push[app]) return void res.status(404).json({ message: 'NotFound' });
    res.json(resource(app, indexer));
  };
}
