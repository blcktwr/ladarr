import type { MediaType } from '@ladarr/shared/enums';
import type { RequestHandler } from 'express';
import { db } from '../../../../../core/db.ts';
import { isQualityId, type SizeLimits } from '../../../../../library/grab/quality.ts';
import { isLimit, isObject } from '../../../../../helpers/quality.ts';

const isMedia = (value: string): value is MediaType => value === 'movie' || value === 'tv';

export function qualitySizesPut(): RequestHandler<{ media: string; quality: string }> {
  return async (req, res) => {
    const { media, quality } = req.params;
    if (!isMedia(media) || !isQualityId(quality)) return void res.status(404).json({ error: 'not_found' });
    const body = req.body;
    if (!isObject(body)) return void res.status(400).json({ error: 'invalid_sizes' });
    const { min, preferred, max } = body;
    // The three limits are in order: minimum, preferred, maximum. A limit that is null is not checked.
    const low = typeof min === 'number' ? min : 0;
    const ordered = (min === null || isLimit(min)) && (preferred === null || (isLimit(preferred) && preferred >= low)) && (max === null || (isLimit(max) && max >= (preferred ?? low)));
    if (!ordered) return void res.status(400).json({ error: 'invalid_sizes' });
    db.data.qualitySizes[media][quality] = { min, preferred, max } as SizeLimits;
    await db.write();
    res.json({ sizes: db.data.qualitySizes[media][quality] });
  };
}
