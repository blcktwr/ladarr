import type { QualityResponse } from '@ladarr/shared/types';
import { Router } from 'express';
import { profilesInOrder, type Db } from '../core/db.ts';
import { isQualityId, QUALITIES, type Profile, type SizeLimits } from './quality.ts';

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isLimit = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100_000;

// Returns the profile that the body describes, or the name of the first field that is not valid.
function parseProfile(body: unknown): Omit<Profile, 'id'> | { invalid: string } {
  if (!isObject(body)) return { invalid: 'body' };
  const { name, items } = body;
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 60) return { invalid: 'name' };
  const seen = new Set<string>();
  if (!Array.isArray(items) || items.length < 1 || !items.every((group) => Array.isArray(group) && group.length >= 1 && group.every((id) => isQualityId(id) && !seen.has(id) && seen.add(id)))) return { invalid: 'items' };
  return { name: name.trim(), items: items as string[][] };
}

// The profiles and the sizes of the qualities. The default profile is a setting: see settings.ts.
export function qualityRouter(db: Db) {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json({
      qualities: QUALITIES.map((quality) => ({ ...quality, sizes: db.data.qualitySizes[quality.id] })),
      profiles: profilesInOrder(db.data),
    } satisfies QualityResponse);
  });

  router.post('/profiles', async (req, res) => {
    const profile = parseProfile(req.body);
    if ('invalid' in profile) return void res.status(400).json({ error: 'invalid_profile', field: profile.invalid });
    // The profiles of version 1 have the IDs p1080 and p2160. A profile of the user has a number, so the compat API can give it one.
    const id = String(Math.max(2, ...Object.keys(db.data.profiles).filter((key) => /^\d+$/.test(key)).map(Number)) + 1);
    db.data.profiles[id] = { id, ...profile };
    db.data.profileOrder.push(id);
    await db.write();
    res.status(201).json({ profile: db.data.profiles[id] });
  });

  // The order of the chain, the best profile first.
  router.put('/order', async (req, res) => {
    const ids = (req.body as { ids?: unknown } | null)?.ids;
    const known = Object.keys(db.data.profiles);
    const valid = Array.isArray(ids) && ids.length === known.length && ids.every((id) => typeof id === 'string' && Object.hasOwn(db.data.profiles, id)) && new Set(ids).size === ids.length;
    if (!valid) return void res.status(400).json({ error: 'invalid_order' });
    db.data.profileOrder = ids as string[];
    await db.write();
    res.json({ profiles: profilesInOrder(db.data) });
  });

  router.put('/profiles/:id', async (req, res) => {
    const current = db.data.profiles[req.params.id!];
    if (!current || !Object.hasOwn(db.data.profiles, req.params.id!)) return void res.status(404).json({ error: 'not_found' });
    const profile = parseProfile(req.body);
    if ('invalid' in profile) return void res.status(400).json({ error: 'invalid_profile', field: profile.invalid });
    db.data.profiles[current.id] = { id: current.id, ...profile };
    await db.write();
    res.json({ profile: db.data.profiles[current.id] });
  });

  // A profile that a title uses stays: the title would change its quality without a word. The chain keeps one profile.
  router.delete('/profiles/:id', async (req, res) => {
    const id = req.params.id!;
    if (!Object.hasOwn(db.data.profiles, id)) return void res.status(404).json({ error: 'not_found' });
    if (Object.keys(db.data.profiles).length <= 1) return void res.status(409).json({ error: 'last_profile' });
    const titles = Object.values(db.data.titles).filter((title) => title.preset === id).length;
    if (titles) return void res.status(409).json({ error: 'profile_in_use', titles });
    delete db.data.profiles[id];
    db.data.profileOrder = db.data.profileOrder.filter((profileId) => profileId !== id);
    await db.write();
    res.status(204).end();
  });

  router.put('/sizes/:quality', async (req, res) => {
    const id = req.params.quality!;
    if (!isQualityId(id)) return void res.status(404).json({ error: 'not_found' });
    const body = req.body;
    if (!isObject(body)) return void res.status(400).json({ error: 'invalid_sizes' });
    const { min, preferred, max } = body;
    // The three limits are in order: minimum, preferred, maximum. A limit that is null is not checked.
    const ordered = isLimit(min) && (preferred === null || (isLimit(preferred) && preferred >= min)) && (max === null || (isLimit(max) && max >= (preferred ?? min)));
    if (!ordered) return void res.status(400).json({ error: 'invalid_sizes' });
    db.data.qualitySizes[id] = { min, preferred, max } as SizeLimits;
    await db.write();
    res.json({ sizes: db.data.qualitySizes[id] });
  });

  return router;
}
