import { db } from '../../../core/db.ts';
import type { RequestHandler } from 'express';
import { openJournal, PlanError, titleBusy } from '../../../library/imports/plan.ts';
import { planFolder } from '../../../library/imports/manual.ts';
import { fail, input } from '../../../helpers/import-folder.ts';
import type { PostDeps } from '../../../types.ts';

// The plan is made again here. The server does not trust the preview that the browser holds.
export function importFolderStart({ enqueue, status, configDir }: PostDeps): RequestHandler {
  return async (req, res) => {
    try {
      const plan = await planFolder(input(req.body, configDir));
      if (!plan.steps.length) throw new PlanError('nothing_to_import');
      if (titleBusy(plan.titleKey)) throw new PlanError('title_busy');
      const journal = await openJournal({ enqueue, status }, { kind: 'import', titleKey: plan.titleKey, sourceBase: plan.real, steps: plan.steps });
      res.status(202).json({ id: journal.id, total: plan.steps.length });
    } catch (error) {
      fail(res, error);
    }
  };
}
