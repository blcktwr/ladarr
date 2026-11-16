import type { RequestHandler } from 'express';
import { mappingOf, titleOf } from '../../../helpers/mapping.ts';
import { fail } from '../../../helpers/rename.ts';
import { applyCorrection, correctionOf } from '../../../library/mapping.ts';
import type { ApplyDeps } from '../../../types.ts';

// Writes the approved mapping into the library record: the coverage of each file, and the file of each episode.
// The names of the files change with the rename of the title, not here.
export function mappingApply({ persist, events }: ApplyDeps): RequestHandler {
  return (req, res) => {
    const titleKey = titleOf(req.body);
    if (!titleKey) return void res.status(400).json({ error: 'invalid_title' });
    const entries = mappingOf(req.body);
    if (!entries) return void res.status(400).json({ error: 'invalid_mapping' });
    try {
      const correction = correctionOf(titleKey, entries);
      applyCorrection(correction);
      persist?.();
      events?.publish('library.changed', { key: titleKey });
      const counts = { change: correction.rows.filter((row) => row.status === 'change').length, review: correction.rows.filter((row) => row.status === 'review').length };
      res.json({ rows: correction.rows, pointers: correction.pointers, counts });
    } catch (error) {
      fail(res, error);
    }
  };
}
