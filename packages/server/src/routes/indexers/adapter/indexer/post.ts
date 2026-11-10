import { get } from '../../../../core/db.ts';
import type { RequestHandler } from 'express';
import type { IndexerApp } from '../../../../library/grab/indexers.ts';
import { save } from '../../../../helpers/indexers-adapter.ts';

export function indexerCreate(app: IndexerApp, options: { onChange?: () => void } = {}): RequestHandler {
  const db = get();
  return save(db, app, options);
}
