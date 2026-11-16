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
    // A good install ends with the restart of the process. Any other end must let the next try reach the files.
    let restarting = false;
    try {
      await pauseQueue?.();
      const { version } = await installUpdate();
      // The answer can go to a client that is gone, and the restart must still happen, once.
      let done = false;
      const restartOnce = () => {
        if (done) return;
        done = true;
        restarting = true;
        restart?.();
      };
      res.on('finish', restartOnce);
      res.on('close', restartOnce);
      res.status(202).json({ version });
      if (res.destroyed) restartOnce();
    } catch (error) {
      resumeQueue?.();
      const code = error instanceof UpdateError ? error.code : 'failed';
      log.warn('update install failed', { code, error });
      if (code === 'no_update') return void res.status(409).json({ error: 'no_update' });
      // A queue that does not stop is not a broken update. The user tries again when the work ends.
      if (code === 'busy') return void res.status(503).json({ error: 'queue_busy' });
      res.status(502).json({ error: 'update_failed' });
    } finally {
      if (!restarting) updating = false;
    }
  };
}
