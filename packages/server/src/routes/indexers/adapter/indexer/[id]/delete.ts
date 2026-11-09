import type { RequestHandler } from 'express';
import { removePush, type IndexerApp } from '../../../../../library/grab/indexers.ts';
import type { Db } from '../../../../../core/db.ts';

export function indexerDelete(db: Db, app: IndexerApp, { onChange = () => {} }: { onChange?: () => void } = {}): RequestHandler<{ id: string }> {
  return async (req, res) => {
    if (!removePush(db, app, Number(req.params.id))) return void res.status(404).json({ message: 'NotFound' });
    await db.write();
    onChange();
    res.json({});
  };
}
