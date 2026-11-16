import type { RequestHandler } from 'express';
import type { Events } from '../../types.ts';

export function eventsGet(events: Events): RequestHandler {
  return (req, res, next) => events.handler(req, res, next);
}
