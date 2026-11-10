import { get } from '../../../../../core/db.ts';
import type { RequestHandler } from 'express';
import { prioritize } from '../../../../../core/jobs.ts';
import { isItemJob } from '../../../../../helpers/queue.ts';

// A job of the item flow starts first, before every job of the normal lane. The other jobs are not on this page.
export function queueJobPriorityPost(persist: () => void = () => {}): RequestHandler<{ id: string }> {
  const db = get();
  return (req, res) => {
    const job = db.data.jobs[req.params.id];
    if (!job || !isItemJob(job)) return void res.status(404).json({ error: 'not_found' });
    if (job.state !== 'waiting') return void res.status(409).json({ error: 'job_not_waiting' });
    prioritize(job.id);
    persist();
    res.json({ done: true });
  };
}
