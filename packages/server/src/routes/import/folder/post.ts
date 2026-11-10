import { get } from '../../../core/db.ts';
import type { RequestHandler } from 'express';
import type { EnqueueInput, Job } from '../../../core/jobs.ts';
import type { ImportStatus } from '../../../library/imports/status.ts';
import { openJournal, PlanError, titleBusy } from '../../../library/imports/plan.ts';
import { planFolder } from '../../../library/imports/manual.ts';
import { fail, input } from '../../../helpers/import-folder.ts';

type Deps = { enqueue: (input: EnqueueInput) => Job; status: ImportStatus; configDir?: string };

// The plan is made again here. The server does not trust the preview that the browser holds.
export function importFolderStart({ enqueue, status, configDir }: Deps): RequestHandler {
  const db = get();
  return async (req, res) => {
    try {
      const plan = await planFolder(db, input(req.body, configDir));
      if (!plan.steps.length) throw new PlanError('nothing_to_import');
      if (titleBusy(db, plan.titleKey)) throw new PlanError('title_busy');
      const journal = await openJournal({ db, enqueue, status }, { kind: 'import', titleKey: plan.titleKey, sourceBase: plan.real, steps: plan.steps });
      res.status(202).json({ id: journal.id, total: plan.steps.length });
    } catch (error) {
      fail(res, error);
    }
  };
}
