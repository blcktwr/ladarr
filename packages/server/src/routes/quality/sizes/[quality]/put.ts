import { get } from '../../../../core/db.ts';
import type { RequestHandler } from 'express';
import { isQualityId, type SizeLimits } from '../../../../library/grab/quality.ts';
import { isLimit, isObject } from '../../../../helpers/quality.ts';

export function qualitySizesPut(): RequestHandler<{ quality: string }> {
  const db = get();
  return async (req, res) => {
    const id = req.params.quality;
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
  };
}
