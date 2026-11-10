import { get, type Db } from '../../../../core/db.ts';
import type { RequestHandler } from 'express';
import type { Job } from '../../../../core/jobs.ts';
import { isActive, type Queue, type QueueEntry } from '../../../../library/downloads/queue.ts';
import { isItemJob } from '../../../../helpers/queue.ts';

// The targets of a job, so a job that the user removes does not leave a target that waits for work that is gone.
function targetsOf(db: Db, job: Job): QueueEntry[] {
  const payload = job.payload as { entryIds?: string[]; hash?: string } | null;
  if (payload?.entryIds?.length) return payload.entryIds.map((id) => db.data.queue[id]).filter((entry): entry is QueueEntry => Boolean(entry));
  if (payload?.hash) return Object.values(db.data.queue).filter((entry) => entry.transferHash === payload.hash);
  return [];
}

// The user takes a job of the item flow out of the queue. Its targets stop with a reason, so the sweep does not
// put the same job back. A running job keeps its lease.
export function queueJobDelete(queue: Queue, persist: () => void = () => {}): RequestHandler<{ id: string }> {
  const db = get();
  return (req, res) => {
    const job = db.data.jobs[req.params.id];
    if (!job || !isItemJob(job)) return void res.status(404).json({ error: 'not_found' });
    if (job.state !== 'waiting') return void res.status(409).json({ error: 'job_not_waiting' });
    const targets = targetsOf(db, job);
    delete db.data.jobs[job.id];
    for (const entry of targets) {
      if (!isActive(entry) || entry.branch === 'paused' || entry.branch === 'cancelled') continue;
      if (entry.branch === 'waiting' && entry.search) entry.search.nextAt = null;
      queue.move(entry, { branch: null, reason: { code: 'job_removed' } }, 'job removed by the user');
    }
    persist();
    res.json({ done: true });
  };
}
