import { db } from '../../../../core/db.ts';
import type { RequestHandler } from 'express';

// A profile that a title uses stays: the title would change its quality without a word. The chain keeps one profile.
export function qualityProfileDelete(): RequestHandler<{ id: string }> {
  return async (req, res) => {
    const id = req.params.id;
    if (!Object.hasOwn(db.data.profiles, id)) return void res.status(404).json({ error: 'not_found' });
    if (Object.keys(db.data.profiles).length <= 1) return void res.status(409).json({ error: 'last_profile' });
    const titles = Object.values(db.data.titles).filter((title) => title.preset === id).length;
    if (titles) return void res.status(409).json({ error: 'profile_in_use', titles });
    delete db.data.profiles[id];
    db.data.profileOrder = db.data.profileOrder.filter((profileId) => profileId !== id);
    await db.write();
    res.status(204).end();
  };
}
