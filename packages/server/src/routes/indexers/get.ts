import { get } from '../../core/db.ts';
import type { RequestHandler } from 'express';
import { summarize } from '../../library/grab/indexers.ts';

// The list for Settings. The indexer manager owns every value of the indexers that it pushed, except the delay and the preferred languages.
// The indexers that the user added can change, test, and go.
export function indexersGet(): RequestHandler {
  const db = get();
  return (_req, res) => {
    res.json({ indexers: Object.values(db.data.indexers).map(summarize).sort((a, b) => a.name.localeCompare(b.name)) });
  };
}
