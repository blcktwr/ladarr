import type { RequestHandler } from 'express';
import type { IndexerApp } from '../../../../library/grab/indexers.ts';
import type { Db } from '../../../../core/db.ts';
import { resource } from '../../../../helpers/indexers-adapter.ts';

export function indexerListGet(db: Db, app: IndexerApp): RequestHandler {
  return (_req, res) => {
    res.json(Object.values(db.data.indexers).filter((indexer) => indexer.push[app]).map((indexer) => resource(app, indexer)));
  };
}
