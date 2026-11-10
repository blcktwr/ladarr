import { get } from '../../core/db.ts';
import type { QualityResponse } from '@ladarr/shared/types';
import type { RequestHandler } from 'express';
import { QUALITIES } from '../../library/grab/quality.ts';
import { profilesInOrder, type Db } from '../../core/db.ts';

// The profiles and the sizes of the qualities. The default profile is a setting.
export function qualityGet(): RequestHandler {
  const db = get();
  return (_req, res) => {
    res.json({
      qualities: QUALITIES.map((quality) => ({ ...quality, sizes: db.data.qualitySizes[quality.id] })),
      profiles: profilesInOrder(db.data),
    } satisfies QualityResponse);
  };
}
