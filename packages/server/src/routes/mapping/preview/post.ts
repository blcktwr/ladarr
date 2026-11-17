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
    const ids = req.body.ids ?? [];
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) return void res.status(400).json({ error: 'invalid_ids' });
    try {
      const correction = correctionOf(titleKey, entries, ids);
      const counts = { change: correction.rows.filter((row) => row.status === 'change').length, same: correction.rows.filter((row) => row.status === 'same').length, review: correction.rows.filter((row) => row.status === 'review').length, blocked: correction.rows.filter((row) => row.status === 'blocked').length };
      res.json({ ...correction, counts });
    } catch (error) {
      fail(res, error);
    }
  };
}
