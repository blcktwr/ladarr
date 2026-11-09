import type { RequestHandler } from 'express';
import type { Db } from '../../../../../core/db.ts';
import { prioritize } from '../../../../../core/jobs.ts';
import { isItemJob } from '../../../../../helpers/queue.ts';

// A job of the item flow starts first, before every job of the normal lane. The other jobs are not on this page.
export function queueJobPriorityPost(db: Db, persist: () => void = () => {}): RequestHandler<{ id: string }> {
  return (req, res) => {
    const job = db.data.jobs[req.params.id];
    if (!job || !isItemJob(job)) return void res.status(404).json({ error: 'not_found' });
    if (job.state !== 'waiting') return void res.status(409).json({ error: 'job_not_waiting' });
    prioritize(db, job.id);
    persist();
    res.json({ done: true });
  };
}
