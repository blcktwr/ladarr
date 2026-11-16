import { db } from '../../../../../core/db.ts';
import type { RequestHandler } from 'express';
import { save } from '../../../../../helpers/indexers-adapter.ts';
import type { IndexerApp } from '@ladarr/shared/enums';

export function indexerUpdate(app: IndexerApp, options: { onChange?: () => void } = {}): RequestHandler<{ id: string }> {
  return save(app, options);
}
