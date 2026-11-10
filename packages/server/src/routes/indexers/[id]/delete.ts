import { get } from '../../../core/db.ts';
import type { RequestHandler } from 'express';

// The queue entries of a removed indexer keep their release. The decision step reports `indexer_removed` for them.
export function indexersDelete({ onChange = () => {} }: { onChange?: () => void } = {}): RequestHandler<{ id: string }> {
  const db = get();
  return async (req, res) => {
    const id = Number(req.params.id);
    if (!db.data.indexers[id]?.manual) return void res.status(404).json({ error: 'not_found' });
    delete db.data.indexers[id];
    await db.write();
    onChange();
    res.status(204).end();
  };
}
