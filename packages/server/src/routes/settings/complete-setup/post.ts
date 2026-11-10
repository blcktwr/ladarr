import { get } from '../../../core/db.ts';
import type { RequestHandler } from 'express';

// The setup ends when both default folders exist. No download can start before that.
export function settingsCompleteSetup(): RequestHandler {
  const db = get();
  return async (_req, res) => {
    const { defaultRoots } = db.data.settings;
    if (!defaultRoots.movie || !defaultRoots.tv) return void res.status(400).json({ error: 'roots_required' });
    db.data.settings.setupCompleted = true;
    await db.write();
    res.json({ settings: db.data.settings });
  };
}
