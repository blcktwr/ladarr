import type { RequestHandler } from 'express';
import type { Db } from '../../../../core/db.ts';
import { parseProfile } from '../../../../helpers/quality.ts';

export function qualityProfileUpdate(db: Db): RequestHandler<{ id: string }> {
  return async (req, res) => {
    const current = db.data.profiles[req.params.id];
    if (!current || !Object.hasOwn(db.data.profiles, req.params.id)) return void res.status(404).json({ error: 'not_found' });
    const profile = parseProfile(req.body);
    if ('invalid' in profile) return void res.status(400).json({ error: 'invalid_profile', field: profile.invalid });
    db.data.profiles[current.id] = { id: current.id, ...profile };
    await db.write();
    res.json({ profile: db.data.profiles[current.id] });
  };
}
