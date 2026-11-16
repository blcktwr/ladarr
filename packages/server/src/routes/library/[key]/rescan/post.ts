import type { RequestHandler } from 'express';
import { scanJob } from '../../../../library/scan.ts';
import type { RescanDeps, Title } from '../../../../types.ts';

// Reads the folder of the title again and updates its files. The job runs in the background.
export function libraryRescan({ enqueue }: RescanDeps): RequestHandler<{ key: string }> {
  return (_req, res) => {
    const title: Title = res.locals.title;
    if (!title.folder) return void res.status(409).json({ error: 'no_folder' });
    res.status(202).json({ jobId: enqueue(scanJob(title.key)).id });
  };
}
