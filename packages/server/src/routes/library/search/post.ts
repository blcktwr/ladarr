import type { RequestHandler } from 'express';
import { BULK_SEARCH_JOB, type BulkSearchPayload } from '../../../library/calendar/calendar-search.ts';
import type { EnqueueInput, Job } from '../../../core/jobs.ts';
import { isObject, plans } from './plans.ts';

// The job runs the plan in batches. A second request for the same plan returns the same job.
export function librarySearchStart(enqueue: (input: EnqueueInput) => Job): RequestHandler {
  return (req, res) => {
    const planId = isObject(req.body) && typeof req.body.planId === 'string' ? req.body.planId : '';
    const plan = plans.get(planId);
    if (!plan) return void res.status(404).json({ error: 'plan_not_found' });
    plan.jobId ??= enqueue({ type: BULK_SEARCH_JOB, payload: { planId, keys: plan.keys, offset: 0, ...(plan.kind === 'upgrades' ? { kind: plan.kind, quality: plan.quality } : {}) } satisfies BulkSearchPayload, dedupeKey: `${BULK_SEARCH_JOB}:${planId}:0` }).id;
    res.status(202).json({ jobId: plan.jobId, titles: plan.keys.length, targets: plan.targets });
  };
}
