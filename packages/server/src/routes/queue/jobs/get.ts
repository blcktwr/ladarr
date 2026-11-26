import type { QueueJob } from '@ladarr/shared/types';
import type { RequestHandler } from 'express';
import { itemJobs, jobEta, jobLabel, jobTitle, publicText } from '../../../helpers/queue.ts';
import type { Finder, Job, SearchPayload } from '../../../types.ts';

function payloadOf(job: Job) {
  if (job.type !== 'queue.search' || !job.payload) return job.payload;
  const { itemId, titleKey, season, entryIds, fresh, manual, otherSeasons, resume } = job.payload as SearchPayload;
  return { itemId, titleKey, season, entryIds, fresh, manual, otherSeasons, resume };
}

export function queueJobsGet(finder: Finder): RequestHandler {
  return (_req, res) => {
    const jobs = itemJobs();
    res.json({
      items: jobs.map((job) => ({ id: job.id, type: job.type, state: job.state === 'running' ? 'running' : 'waiting', payload: payloadOf(job), runAt: job.runAt, eta: jobEta(finder, job), attempts: job.attempts, priority: job.priority, lastError: job.lastError ? { ...job.lastError, message: publicText(job.lastError.message) } : null, label: jobLabel(job), posterPath: jobTitle(job)?.meta.posterPath ?? null })),
    } satisfies { items: QueueJob[] });
  };
}
