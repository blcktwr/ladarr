import type { RequestHandler } from 'express';
import type { IndexerApp } from '../../../../library/grab/indexers.ts';
import type { Db } from '../../../../core/db.ts';
import { save } from '../../../../helpers/indexers-adapter.ts';

export function indexerCreate(db: Db, app: IndexerApp, options: { onChange?: () => void } = {}): RequestHandler {
  return save(db, app, options);
}
