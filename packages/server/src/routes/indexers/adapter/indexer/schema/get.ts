import type { RequestHandler } from 'express';
import { IMPLEMENTATIONS } from '../../../../../library/grab/indexers.ts';
import { schemaResource } from '../../../../../helpers/indexers-adapter.ts';
import type { IndexerApp } from '@ladarr/shared/enums';

export function indexerSchemaGet(app: IndexerApp): RequestHandler {
  return (_req, res) => {
    res.json(IMPLEMENTATIONS.map((implementation) => schemaResource(app, implementation)));
  };
}
