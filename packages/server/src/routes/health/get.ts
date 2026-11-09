import type { RequestHandler } from 'express';

const HEARTBEAT_MAX_AGE_MS = 30_000;

export function healthGet(heartbeat?: () => number): RequestHandler {
  return (_req, res) => {
    const workerOk = !heartbeat || Date.now() - heartbeat() < HEARTBEAT_MAX_AGE_MS;
    res.status(workerOk ? 200 : 503).json({ status: workerOk ? 'ok' : 'worker_stalled' });
  };
}
