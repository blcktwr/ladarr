import type { RequestHandler } from 'express';
import { log } from '../../../core/log.ts';
import { UpdateError } from '../../../system/update.ts';

type Deps = { installUpdate?: () => Promise<{ version: string }>; pauseQueue?: () => Promise<void>; resumeQueue?: () => void; restart?: () => void };

// The update stops the queue and waits for the jobs that run, then it replaces the files. The process
// restarts after the answer. A failed install starts the queue again.
export function systemUpdatePost({ installUpdate, pauseQueue, resumeQueue, restart }: Deps): RequestHandler {
  let updating = false;
  return async (_req, res) => {
    if (!installUpdate) return void res.status(404).json({ error: 'update_unavailable' });
    if (updating) return void res.status(409).json({ error: 'update_in_progress' });
    updating = true;
    try {
      await pauseQueue?.();
      const { version } = await installUpdate();
      res.on('finish', () => restart?.());
      res.status(202).json({ version });
    } catch (error) {
      updating = false;
      resumeQueue?.();
      const code = error instanceof UpdateError ? error.code : 'failed';
      log.warn('update install failed', { code, error });
      res.status(code === 'no_update' ? 409 : 502).json({ error: code === 'no_update' ? 'no_update' : 'update_failed' });
    }
  };
}
