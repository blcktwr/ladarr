import type { RequestHandler } from 'express';
import type { EnqueueInput, Job } from '../../../../core/jobs.ts';
import type { Title } from '../../../../library/library.ts';
import { scanJob } from '../../../../library/scan.ts';

type Deps = { enqueue: (input: EnqueueInput) => Job };

// Reads the folder of the title again and updates its files. The job runs in the background.
export function libraryRescan({ enqueue }: Deps): RequestHandler<{ key: string }> {
  return (_req, res) => {
    const title: Title = res.locals.title;
    if (!title.folder) return void res.status(409).json({ error: 'no_folder' });
    res.status(202).json({ jobId: enqueue(scanJob(title.key)).id });
  };
}
