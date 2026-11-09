import type { RequestHandler } from 'express';
import { IMPLEMENTATIONS, type IndexerApp } from '../../../../../library/grab/indexers.ts';
import { schemaResource } from '../../../../../helpers/indexers-adapter.ts';

export function indexerSchemaGet(app: IndexerApp): RequestHandler {
  return (_req, res) => {
    res.json(IMPLEMENTATIONS.map((implementation) => schemaResource(app, implementation)));
  };
}
