import { get } from '../../../core/db.ts';
import type { RequestHandler } from 'express';
import { parseProfile } from '../../../helpers/quality.ts';

export function qualityProfileCreate(): RequestHandler {
  const db = get();
  return async (req, res) => {
    const profile = parseProfile(req.body);
    if ('invalid' in profile) return void res.status(400).json({ error: 'invalid_profile', field: profile.invalid });
    // The profiles of version 1 have the IDs p1080 and p2160. A profile of the user has a number, so the compat API can give it one.
    const id = String(Math.max(2, ...Object.keys(db.data.profiles).filter((key) => /^\d+$/.test(key)).map(Number)) + 1);
    db.data.profiles[id] = { id, ...profile };
    db.data.profileOrder.push(id);
    await db.write();
    res.status(201).json({ profile: db.data.profiles[id] });
  };
}
