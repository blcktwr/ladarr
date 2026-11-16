import { db } from '../../../../core/db.ts';
import type { RequestHandler } from 'express';
import { resource } from '../../../../helpers/indexers-adapter.ts';
import type { IndexerApp } from '@ladarr/shared/enums';

export function indexerListGet(app: IndexerApp): RequestHandler {
  return (_req, res) => {
    res.json(Object.values(db.data.indexers).filter((indexer) => indexer.push[app]).map((indexer) => resource(app, indexer)));
  };
}
