import { db } from '../../../core/db.ts';
import type { RequestHandler } from 'express';
import { openJournal, PlanError, titleBusy } from '../../../library/imports/plan.ts';
import { planRename } from '../../../library/rename.ts';
import { fail, isObject } from '../../../helpers/rename.ts';
import type { RenameApplyDeps } from '../../../types.ts';

// The plan is made again here, with the saved templates.
export function renameApply({ enqueue, status }: RenameApplyDeps): RequestHandler {
  return async (req, res) => {
    try {
      const plan = await planRename(String(isObject(req.body) ? req.body.titleKey : ''));
      if (!plan.steps.length) throw new PlanError('nothing_to_rename');
      if (titleBusy(plan.title.key)) throw new PlanError('title_busy');
      const journal = await openJournal({ enqueue, status }, { kind: 'rename', titleKey: plan.title.key, sourceBase: plan.rootReal, steps: plan.steps });
      res.status(202).json({ id: journal.id, total: plan.steps.length });
    } catch (error) {
      fail(res, error);
    }
  };
}
