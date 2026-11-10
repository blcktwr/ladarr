import { get } from '../../../../../core/db.ts';
import type { RequestHandler } from 'express';
import type { IndexerApp } from '../../../../../library/grab/indexers.ts';
import { save } from '../../../../../helpers/indexers-adapter.ts';

export function indexerUpdate(app: IndexerApp, options: { onChange?: () => void } = {}): RequestHandler<{ id: string }> {
  const db = get();
  return save(db, app, options);
}
