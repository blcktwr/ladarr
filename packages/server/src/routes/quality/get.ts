import { type Db, db, profilesInOrder } from '../../core/db.ts';
import type { QualityResponse } from '@ladarr/shared/types';
import type { RequestHandler } from 'express';
import { QUALITIES } from '../../library/grab/quality.ts';

// The profiles and the sizes of the qualities. The default profile is a setting.
export function qualityGet(): RequestHandler {
  return (_req, res) => {
    res.json({
      qualities: QUALITIES.map(({ id, label, source, resolution }) => ({ id, label, source, resolution })),
      profiles: profilesInOrder(db.data),
      sizes: db.data.qualitySizes,
    } satisfies QualityResponse);
  };
}
