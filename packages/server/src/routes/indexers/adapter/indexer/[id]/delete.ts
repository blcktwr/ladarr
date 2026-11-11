import { db } from '../../../../../core/db.ts';
import type { RequestHandler } from 'express';
import { removePush, type IndexerApp } from '../../../../../library/grab/indexers.ts';

export function indexerDelete(app: IndexerApp, { onChange = () => {} }: { onChange?: () => void } = {}): RequestHandler<{ id: string }> {
  return async (req, res) => {
    if (!removePush(app, Number(req.params.id))) return void res.status(404).json({ message: 'NotFound' });
    await db.write();
    onChange();
    res.json({});
  };
}
