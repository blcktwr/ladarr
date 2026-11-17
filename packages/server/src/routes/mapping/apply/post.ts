import type { RequestHandler } from 'express';
import { db } from '../../../core/db.ts';
import { withTitleLock } from '../../../core/title-lock.ts';
import { mappingOf, titleOf } from '../../../helpers/mapping.ts';
import { fail } from '../../../helpers/rename.ts';
import { correctionJournal, correctionOf, prepareCorrection, recoverCorrection } from '../../../library/mapping.ts';
import { PlanError, titleBusy } from '../../../library/imports/plan.ts';
import type { ApplyDeps } from '../../../types.ts';

// Writes the approved mapping into the library record: the coverage of each file, and the file of each episode.
// The names of the files change with the rename of the title, not here.
export function mappingApply({ persist, events, queue, enqueue }: ApplyDeps): RequestHandler {
  return async (req, res) => {
    const titleKey = titleOf(req.body);
    if (!titleKey) return void res.status(400).json({ error: 'invalid_title' });
    const entries = mappingOf(req.body);
    if (!entries) return void res.status(400).json({ error: 'invalid_mapping' });
    const ids = req.body.ids ?? [];
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) return void res.status(400).json({ error: 'invalid_ids' });
    if (req.body.version === undefined) return void res.status(409).json({ error: 'preview_required' });
    try {
      await withTitleLock(titleKey, async () => {
        const correction = correctionOf(titleKey, entries, ids);
        if (req.body.version !== correction.version) throw new PlanError('mapping_stale');
        if (titleBusy(titleKey)) throw new PlanError('title_busy');
        const journal = correctionJournal(prepareCorrection(correction));
        db.data.imports[journal.id] = journal;
        await db.write();
        try {
          prepareCorrection(correction);
        } catch (error) {
          delete db.data.imports[journal.id];
          await db.write();
          throw error;
        }
        await recoverCorrection(journal, { queue });
        if (journal.steps.length) enqueue?.({ type: 'import.run', payload: { hash: journal.hash }, dedupeKey: `import:${journal.hash}` });
        await (persist ? persist() : db.write());
        events?.publish('library.changed', { key: titleKey });
        const counts = { change: correction.rows.filter((row) => row.status === 'change').length, review: correction.rows.filter((row) => row.status === 'review').length };
        res.json({ ...correction, counts });
      });
    } catch (error) {
      fail(res, error);
    }
  };
}
