import { db } from '../../../../../core/db.ts';
import type { RequestHandler } from 'express';
import { removePush } from '../../../../../library/grab/indexers.ts';
import type { IndexerApp } from '@ladarr/shared/enums';

export function indexerDelete(app: IndexerApp, { onChange = () => {} }: { onChange?: () => void } = {}): RequestHandler<{ id: string }> {
  return async (req, res) => {
    if (!removePush(app, Number(req.params.id))) return void res.status(404).json({ message: 'NotFound' });
    await db.write();
    onChange();
    res.json({});
  };
}
