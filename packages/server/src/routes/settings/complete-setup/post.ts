import type { RequestHandler } from 'express';
import type { Db } from '../../../core/db.ts';

// The setup ends when both default folders exist. No download can start before that.
export function settingsCompleteSetup(db: Db): RequestHandler {
  return async (_req, res) => {
    const { defaultRoots } = db.data.settings;
    if (!defaultRoots.movie || !defaultRoots.tv) return void res.status(400).json({ error: 'roots_required' });
    db.data.settings.setupCompleted = true;
    await db.write();
    res.json({ settings: db.data.settings });
  };
}
