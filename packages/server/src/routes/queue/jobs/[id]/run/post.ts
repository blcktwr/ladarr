import type { RequestHandler } from 'express';
import type { Db } from '../../../../../core/db.ts';
import { isItemJob } from '../../../../../helpers/queue.ts';

// A job of the item flow starts now, instead of waiting for its time. A paused queue still holds it.
export function queueJobRunPost(db: Db, persist: () => void = () => {}): RequestHandler<{ id: string }> {
  return (req, res) => {
    const job = db.data.jobs[req.params.id];
    if (!job || !isItemJob(job)) return void res.status(404).json({ error: 'not_found' });
    if (job.state !== 'waiting') return void res.status(409).json({ error: 'job_not_waiting' });
    job.runAt = Date.now();
    persist();
    res.json({ done: true });
  };
}
