import type { RequestHandler } from 'express';
import type { EnqueueInput, Job } from '../../../../core/jobs.ts';
import type { Title } from '../../../../library/library.ts';
import { refreshJob } from '../../../../library/metadata.ts';
import type { Tmdb } from '../../../../metadata/tmdb.ts';

type Deps = { tmdb?: Tmdb; enqueue: (input: EnqueueInput) => Job };

export function libraryRefresh({ tmdb, enqueue }: Deps): RequestHandler<{ key: string }> {
  return (_req, res) => {
    if (!tmdb) return void res.status(503).json({ error: 'metadata_unavailable' });
    const title: Title = res.locals.title;
    const job = enqueue(refreshJob(title.key));
    res.status(202).json({ jobId: job.id });
  };
}
