import type { RequestHandler } from 'express';
import type { Queue } from '../../../library/downloads/queue.ts';

// The user pauses the queue, or starts it again. Running work ends, and no new work starts.
export function queuePausePost(queue: Queue): RequestHandler {
  return (req, res) => {
    const paused = (req.body ?? {}).paused;
    if (typeof paused !== 'boolean') return void res.status(400).json({ error: 'invalid_request' });
    queue.setPaused(paused);
    res.json({ paused });
  };
}
