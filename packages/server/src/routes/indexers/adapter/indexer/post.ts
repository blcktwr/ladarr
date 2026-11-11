import { db } from '../../../../core/db.ts';
import type { RequestHandler } from 'express';
import type { IndexerApp } from '../../../../library/grab/indexers.ts';
import { save } from '../../../../helpers/indexers-adapter.ts';

export function indexerCreate(app: IndexerApp, options: { onChange?: () => void } = {}): RequestHandler {
  return save(app, options);
}
