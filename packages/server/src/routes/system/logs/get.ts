import type { LogsResponse } from '@ladarr/shared/types';
import type { RequestHandler } from 'express';
import { recentLogs } from '../../../core/log.ts';

export function systemLogs(): RequestHandler {
  return async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
    const itemId = typeof req.query.itemId === 'string' ? req.query.itemId : undefined;
    const itemType = typeof req.query.itemType === 'string' ? req.query.itemType : undefined;
    const kind = req.query.kind === 'requests' ? 'requests' : 'logs';
    const type = req.query.type === 'catalog' ? 'catalog' : req.query.type === 'system' ? 'system' : undefined;
    const requestId = typeof req.query.requestId === 'string' ? req.query.requestId : undefined;
    res.json({ entries: await recentLogs(limit, { itemId, itemType, kind, type, requestId }) } satisfies LogsResponse);
  };
}
