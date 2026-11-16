import type { RequestHandler } from 'express';
import { refreshJob } from '../../../../library/metadata.ts';
import type { RefreshDeps, Title } from '../../../../types.ts';

export function libraryRefresh({ tmdb, enqueue }: RefreshDeps): RequestHandler<{ key: string }> {
  return (_req, res) => {
    if (!tmdb) return void res.status(503).json({ error: 'metadata_unavailable' });
    const title: Title = res.locals.title;
    const job = enqueue(refreshJob(title.key));
    res.status(202).json({ jobId: job.id });
  };
}
