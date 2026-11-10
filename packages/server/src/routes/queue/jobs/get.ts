import { db } from '../../../core/db.ts';
import type { QueueJob } from '@ladarr/shared/types';
import type { RequestHandler } from 'express';
import type { Finder } from '../../../library/grab/finder.ts';
import { itemJobs, jobEta, jobLabel, jobTitle } from '../../../helpers/queue.ts';

export function queueJobsGet(finder: Finder): RequestHandler {
  return (_req, res) => {
    const jobs = itemJobs();
    res.json({
      items: jobs.map((job) => ({ id: job.id, type: job.type, state: job.state === 'running' ? 'running' : 'waiting', payload: job.payload, runAt: job.runAt, eta: jobEta(finder, job), attempts: job.attempts, priority: job.priority, lastError: job.lastError, label: jobLabel(job), posterPath: jobTitle(job)?.meta.posterPath ?? null })),
    } satisfies { items: QueueJob[] });
  };
}
