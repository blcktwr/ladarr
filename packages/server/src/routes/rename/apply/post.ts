import type { RequestHandler } from 'express';
import type { Db } from '../../../core/db.ts';
import type { EnqueueInput, Job } from '../../../core/jobs.ts';
import type { ImportStatus } from '../../../library/imports/status.ts';
import { openJournal, PlanError, titleBusy } from '../../../library/imports/plan.ts';
import { planRename } from '../../../library/rename.ts';
import { fail, isObject } from '../../../helpers/rename.ts';

type Deps = { enqueue: (input: EnqueueInput) => Job; status: ImportStatus };

// The plan is made again here, with the saved templates.
export function renameApply(db: Db, { enqueue, status }: Deps): RequestHandler {
  return async (req, res) => {
    try {
      const plan = await planRename(db, String(isObject(req.body) ? req.body.titleKey : ''));
      if (!plan.steps.length) throw new PlanError('nothing_to_rename');
      if (titleBusy(db, plan.title.key)) throw new PlanError('title_busy');
      const journal = await openJournal({ db, enqueue, status }, { kind: 'rename', titleKey: plan.title.key, sourceBase: plan.rootReal, steps: plan.steps });
      res.status(202).json({ id: journal.id, total: plan.steps.length });
    } catch (error) {
      fail(res, error);
    }
  };
}
