import type { RequestHandler } from 'express';
import { mappingOf, titleOf } from '../../../helpers/mapping.ts';
import { fail } from '../../../helpers/rename.ts';
import { correctionOf } from '../../../library/mapping.ts';

// Reads the approved mapping against the library and gives the change of each file and each episode. It changes
// nothing, so a person can read the result before the apply.
export function mappingPreview(): RequestHandler {
  return (req, res) => {
    const titleKey = titleOf(req.body);
    if (!titleKey) return void res.status(400).json({ error: 'invalid_title' });
    const entries = mappingOf(req.body);
    if (!entries) return void res.status(400).json({ error: 'invalid_mapping' });
    try {
      const correction = correctionOf(titleKey, entries);
      const counts = { change: correction.rows.filter((row) => row.status === 'change').length, same: correction.rows.filter((row) => row.status === 'same').length, review: correction.rows.filter((row) => row.status === 'review').length, blocked: correction.rows.filter((row) => row.status === 'blocked').length };
      res.json({ rows: correction.rows, pointers: correction.pointers, counts });
    } catch (error) {
      fail(res, error);
    }
  };
}
